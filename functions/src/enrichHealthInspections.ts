import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const AUSTIN_API = 'https://data.austintexas.gov/resource/ecmv-9xxi.json';
const DALLAS_TASK_API = 'https://inspections.myhealthdepartment.com/';

const MATCH_THRESHOLD = 0.72;

type HealthStatus = 'success' | 'skip' | 'error';

interface DallasInspection {
  inspectionID: string;
  inspectionDate: string;
  score: number;
  purpose?: string;
  establishmentName?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  state?: string;
  zip?: string;
  permitID?: string;
}

interface AustinInspection {
  restaurant_name?: string;
  zip_code?: string;
  inspection_date?: string;
  score?: string;
  address?: string;
  facility_id?: string;
  process_description?: string;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(llc|inc|lp|ltd|dba|corp|co\.?|restaurant|bar|grill|kitchen)\b/gi, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

function confidence(nameA: string, addrA: string, nameB: string, addrB: string): number {
  const nameScore = similarity(nameA, nameB);
  const addrScore = similarity(addrA, addrB);
  return nameScore * 0.7 + addrScore * 0.3;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function trendFromScores(scores: number[]): 'improving' | 'stable' | 'declining' {
  if (scores.length < 2) return 'stable';
  const newest = scores[0];
  const oldest = scores[scores.length - 1];
  const diff = newest - oldest;
  if (diff >= 5) return 'improving';
  if (diff <= -5) return 'declining';
  return 'stable';
}

async function logHealthEnrichment(
  establishmentId: string,
  status: HealthStatus,
  message: string,
  confidenceValue?: number,
  matchMethod?: string
): Promise<void> {
  await db.collection('system/enrichmentLogs/items').add({
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    establishmentId,
    source: 'healthInspection',
    status,
    confidence: confidenceValue ?? null,
    matchMethod: matchMethod ?? null,
    message,
  }).catch(() => { /* non-fatal */ });
}

async function fetchAustinInspections(
  businessName: string,
  fromDate: Date
): Promise<AustinInspection[]> {
  const params = new URLSearchParams({
    '$limit': '250',
    '$order': 'inspection_date DESC',
    '$select': 'restaurant_name,zip_code,inspection_date,score,address,facility_id,process_description',
    '$q': businessName,
  });

  const url = `${AUSTIN_API}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Austin API failed: HTTP ${res.status}`);

  const records = (await res.json()) as AustinInspection[];
  return records.filter((r) => {
    if (!r.inspection_date) return false;
    const inspected = new Date(r.inspection_date);
    return !Number.isNaN(inspected.getTime()) && inspected >= fromDate;
  });
}

async function fetchDallasInspections(
  businessName: string,
  fromDate: Date,
  toDate: Date
): Promise<DallasInspection[]> {
  const all: DallasInspection[] = [];
  const dateRange = `${fmtDate(fromDate)} to ${fmtDate(toDate)}`;
  const count = 200;

  for (let start = 0; start <= 1000; start += count) {
    const payload = {
      task: 'searchInspections',
      data: {
        path: 'dallas',
        programName: '',
        filters: {
          date: dateRange,
          purpose: '',
        },
        start,
        count,
        searchQueryOverride: null,
        searchStr: businessName,
        lat: 0,
        lng: 0,
        sort: {},
      },
    };

    const res = await fetch(DALLAS_TASK_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Dallas task endpoint failed: HTTP ${res.status}`);

    const rows = (await res.json()) as DallasInspection[];
    all.push(...rows);
    if (rows.length < count) break;
  }

  return all;
}

function resolveJurisdiction(city: string, county: string): 'Austin' | 'Dallas' | 'Unavailable' {
  const c = city.toLowerCase();
  const co = county.toLowerCase();

  if (c.includes('austin') || co.includes('travis')) return 'Austin';
  if (c.includes('dallas') || co.includes('dallas')) return 'Dallas';
  return 'Unavailable';
}

export async function enrichHealthInspectionForEstablishment(
  establishmentId: string,
  estData: Record<string, any>,
  lookbackDays = 365
): Promise<'complete' | 'no_match' | 'unavailable' | 'error'> {
  const businessName = String(estData.businessName ?? estData.tradeName ?? '').trim();
  const address = String(estData.address ?? '').trim();
  const city = String(estData.city ?? '').trim();
  const county = String(estData.county ?? '').trim();

  const jurisdiction = resolveJurisdiction(city, county);
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  if (!businessName || !address) {
    await db.collection('establishments').doc(establishmentId).set({
      healthInspection: {
        available: false,
        jurisdiction: jurisdiction === 'Unavailable' ? undefined : jurisdiction,
        reason: 'Missing business name or address for matching',
      },
      'enrichment.healthInspection': 'unavailable',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await logHealthEnrichment(establishmentId, 'skip', 'Missing business name/address');
    return 'unavailable';
  }

  if (jurisdiction === 'Unavailable') {
    await db.collection('establishments').doc(establishmentId).set({
      healthInspection: {
        available: false,
        reason: 'no public data for this jurisdiction',
      },
      'enrichment.healthInspection': 'unavailable',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await logHealthEnrichment(establishmentId, 'skip', 'Jurisdiction unavailable for health data');
    return 'unavailable';
  }

  try {
    if (jurisdiction === 'Austin') {
      const records = await fetchAustinInspections(businessName, fromDate);
      if (records.length === 0) {
        await db.collection('establishments').doc(establishmentId).set({
          healthInspection: {
            available: true,
            jurisdiction: 'Austin / Travis County',
            reason: 'No inspection records in lookback window',
            matchedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          'enrichment.healthInspection': 'no_match',
          'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        await logHealthEnrichment(establishmentId, 'skip', 'Austin: no records in last year');
        return 'no_match';
      }

      let best: AustinInspection | null = null;
      let bestConfidence = 0;

      for (const rec of records) {
        const conf = confidence(
          businessName,
          `${address} ${city}`,
          rec.restaurant_name ?? '',
          rec.address ?? ''
        );
        if (conf > bestConfidence) {
          best = rec;
          bestConfidence = conf;
        }
      }

      if (!best || bestConfidence < MATCH_THRESHOLD) {
        await db.collection('establishments').doc(establishmentId).set({
          healthInspection: {
            available: true,
            jurisdiction: 'Austin / Travis County',
            reason: 'No confident match found',
            confidence: bestConfidence,
            matchedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          'enrichment.healthInspection': 'no_match',
          'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        await logHealthEnrichment(establishmentId, 'skip', 'Austin: low-confidence match', bestConfidence, 'name+address');
        return 'no_match';
      }

      const scoped = best.facility_id
        ? records.filter((r) => r.facility_id === best?.facility_id)
        : records.filter((r) => confidence(businessName, `${address} ${city}`, r.restaurant_name ?? '', r.address ?? '') >= MATCH_THRESHOLD);

      const history = scoped
        .map((r) => ({
          date: r.inspection_date ? new Date(r.inspection_date) : null,
          score: Number(r.score ?? 0),
          violationCount: 0,
          criticalViolationCount: 0,
        }))
        .filter((r) => r.date instanceof Date && !Number.isNaN(r.date.getTime()))
        .map((r) => ({ ...r, date: r.date as Date }))
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 25);

      const scores = history.map((h) => h.score);
      const latest = history[0];

      await db.collection('establishments').doc(establishmentId).set({
        healthInspection: {
          available: true,
          jurisdiction: 'Austin / Travis County',
          latestScore: latest?.score ?? null,
          latestInspectionDate: latest?.date ?? null,
          inspectionHistory: history,
          scoreTrend: trendFromScores(scores),
          confidence: bestConfidence,
          matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        'enrichment.healthInspection': 'complete',
        'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await logHealthEnrichment(establishmentId, 'success', `Austin match with ${history.length} records`, bestConfidence, 'name+address');
      return 'complete';
    }

    const records = await fetchDallasInspections(businessName, fromDate, toDate);
    if (records.length === 0) {
      await db.collection('establishments').doc(establishmentId).set({
        healthInspection: {
          available: true,
          jurisdiction: 'Dallas',
          reason: 'No inspection records in lookback window',
          matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        'enrichment.healthInspection': 'no_match',
        'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await logHealthEnrichment(establishmentId, 'skip', 'Dallas: no records in last year');
      return 'no_match';
    }

    let best: DallasInspection | null = null;
    let bestConfidence = 0;

    for (const rec of records) {
      const recAddr = [rec.addressLine1 ?? '', rec.addressLine2 ?? '', rec.city ?? ''].join(' ').trim();
      const conf = confidence(businessName, `${address} ${city}`, rec.establishmentName ?? '', recAddr);
      if (conf > bestConfidence) {
        best = rec;
        bestConfidence = conf;
      }
    }

    if (!best || bestConfidence < MATCH_THRESHOLD) {
      await db.collection('establishments').doc(establishmentId).set({
        healthInspection: {
          available: true,
          jurisdiction: 'Dallas',
          reason: 'No confident match found',
          confidence: bestConfidence,
          matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        'enrichment.healthInspection': 'no_match',
        'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await logHealthEnrichment(establishmentId, 'skip', 'Dallas: low-confidence match', bestConfidence, 'name+address');
      return 'no_match';
    }

    const scoped = best.permitID
      ? records.filter((r) => r.permitID === best?.permitID)
      : records.filter((r) => {
        const recAddr = [r.addressLine1 ?? '', r.addressLine2 ?? '', r.city ?? ''].join(' ').trim();
        return confidence(businessName, `${address} ${city}`, r.establishmentName ?? '', recAddr) >= MATCH_THRESHOLD;
      });

    const history = scoped
      .map((r) => ({
        id: r.inspectionID,
        date: r.inspectionDate ? new Date(r.inspectionDate) : null,
        score: Number(r.score ?? 0),
        violationCount: 0,
        criticalViolationCount: 0,
      }))
      .filter((r) => r.date instanceof Date && !Number.isNaN(r.date.getTime()))
      .map((r) => ({ ...r, date: r.date as Date }))
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .filter((row, idx, arr) => idx === arr.findIndex((x) => x.id === row.id))
      .slice(0, 25)
      .map(({ id, ...rest }) => rest);

    const latest = history[0];
    const scores = history.map((h) => h.score);

    await db.collection('establishments').doc(establishmentId).set({
      healthInspection: {
        available: true,
        jurisdiction: 'Dallas',
        latestScore: latest?.score ?? null,
        latestInspectionDate: latest?.date ?? null,
        inspectionHistory: history,
        scoreTrend: trendFromScores(scores),
        confidence: bestConfidence,
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      'enrichment.healthInspection': 'complete',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await logHealthEnrichment(establishmentId, 'success', `Dallas match with ${history.length} records`, bestConfidence, 'name+address');
    return 'complete';
  } catch (err: any) {
    await db.collection('establishments').doc(establishmentId).set({
      'enrichment.healthInspection': 'error',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await logHealthEnrichment(establishmentId, 'error', err?.message ?? String(err));
    return 'error';
  }
}

export async function runHealthInspectionsJob(
  limit = 500,
  options?: { county?: string; lookbackDays?: number }
): Promise<{
  processed: number;
  complete: number;
  noMatch: number;
  unavailable: number;
  error: number;
}> {
  const countyFilter = options?.county?.trim().toLowerCase();
  const lookbackDays = options?.lookbackDays ?? 730;

  const snapshot = await db.collection('establishments').limit(limit).get();

  let processed = 0;
  let complete = 0;
  let noMatch = 0;
  let unavailable = 0;
  let error = 0;

  for (const doc of snapshot.docs) {
    const estCounty = String(doc.data().county ?? '').trim().toLowerCase();
    if (countyFilter && estCounty !== countyFilter) continue;

    const status = await enrichHealthInspectionForEstablishment(doc.id, doc.data(), lookbackDays);
    processed++;
    if (status === 'complete') complete++;
    else if (status === 'no_match') noMatch++;
    else if (status === 'unavailable') unavailable++;
    else error++;
  }

  return { processed, complete, noMatch, unavailable, error };
}
