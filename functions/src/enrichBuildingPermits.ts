import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const AUSTIN_PERMITS_API = 'https://data.austintexas.gov/resource/3syk-w9eu.json';
const MIN_WORK_VALUE = 10000;
const MATCH_THRESHOLD = 0.72;

type PermitStatus = 'success' | 'skip' | 'error';

interface AustinPermitRecord {
  permit_type_desc?: string;
  permit_class_mapped?: string;
  work_class?: string;
  description?: string;
  issue_date?: string;
  total_job_valuation?: string;
  status_current?: string;
  original_address1?: string;
  original_city?: string;
  original_zip?: string;
  permit_number?: string;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(apartment|apt|suite|ste|unit|fl|floor|room|rm)\b.*$/gi, '')
    .replace(/#/g, ' ')
    .replace(/\b(st|str)\b/g, 'street')
    .replace(/\b(rd)\b/g, 'road')
    .replace(/\b(dr)\b/g, 'drive')
    .replace(/\b(ave)\b/g, 'avenue')
    .replace(/\b(blvd)\b/g, 'boulevard')
    .replace(/\b(ln)\b/g, 'lane')
    .replace(/\b(hwy)\b/g, 'highway')
    .replace(/\b(cv)\b/g, 'cove')
    .replace(/\b(ct)\b/g, 'court')
    .replace(/\b(pl)\b/g, 'place')
    .replace(/\b(pkwy)\b/g, 'parkway')
    .replace(/\b(n)\b/g, 'north')
    .replace(/\b(s)\b/g, 'south')
    .replace(/\b(e)\b/g, 'east')
    .replace(/\b(w)\b/g, 'west')
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
  const left = normalizeText(a);
  const right = normalizeText(b);
  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(left, right) / maxLen;
}

function extractPrimaryAddress(value: string): string {
  return normalizeText(value)
    .replace(/\b(texas|tx)\b/g, '')
    .replace(/\b\d{5}(?:\s*\d{4})?\b/g, '')
    .trim();
}

function resolveJurisdiction(city: string, county: string): 'Austin' | 'Unavailable' {
  const normalizedCity = normalizeText(city);
  const normalizedCounty = normalizeText(county);
  if (normalizedCity.includes('austin')) return 'Austin';
  if (normalizedCounty.includes('travis') && normalizedCity.includes('austin')) return 'Austin';
  return 'Unavailable';
}

async function logPermitEnrichment(
  establishmentId: string,
  status: PermitStatus,
  message: string,
  confidence?: number,
  matchMethod?: string
): Promise<void> {
  await db.collection('system/enrichmentLogs/items').add({
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    establishmentId,
    source: 'buildingPermits',
    status,
    confidence: confidence ?? null,
    matchMethod: matchMethod ?? null,
    message,
  }).catch(() => { /* non-fatal */ });
}

async function fetchAustinPermits(address: string, fromDate: Date): Promise<AustinPermitRecord[]> {
  const addressQuery = extractPrimaryAddress(address).slice(0, 80);
  if (!addressQuery) return [];

  // Socrata date literal here must not include a trailing timezone suffix.
  const fromDateLiteral = fromDate.toISOString().slice(0, 19);
  const params = new URLSearchParams({
    '$limit': '100',
    '$order': 'issue_date DESC',
    '$select': 'permit_type_desc,permit_class_mapped,work_class,description,issue_date,total_job_valuation,status_current,original_address1,original_city,original_zip,permit_number',
    '$q': addressQuery,
    '$where': `issue_date >= '${fromDateLiteral}' AND total_job_valuation >= ${MIN_WORK_VALUE}`,
  });

  const res = await fetch(`${AUSTIN_PERMITS_API}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Austin permits API failed: HTTP ${res.status}${body ? ` - ${body.slice(0, 240)}` : ''}`);
  }
  return (await res.json()) as AustinPermitRecord[];
}

export async function enrichBuildingPermitsForEstablishment(
  establishmentId: string,
  estData: Record<string, any>,
  lookbackDays = 730
): Promise<'complete' | 'no_match' | 'unavailable' | 'error'> {
  const address = String(estData.address ?? '').trim();
  const city = String(estData.city ?? '').trim();
  const county = String(estData.county ?? '').trim();
  const jurisdiction = resolveJurisdiction(city, county);
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  if (!address) {
    await db.collection('establishments').doc(establishmentId).set({
      buildingPermits: {
        available: false,
        jurisdiction: jurisdiction === 'Unavailable' ? undefined : jurisdiction,
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      'enrichment.buildingPermits': 'unavailable',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await logPermitEnrichment(establishmentId, 'skip', 'Missing address for permit matching');
    return 'unavailable';
  }

  if (jurisdiction === 'Unavailable') {
    await db.collection('establishments').doc(establishmentId).set({
      buildingPermits: {
        available: false,
        reason: 'no public permit source for this jurisdiction',
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      'enrichment.buildingPermits': 'unavailable',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await logPermitEnrichment(establishmentId, 'skip', 'Jurisdiction unavailable for permit data');
    return 'unavailable';
  }

  try {
    const records = await fetchAustinPermits(address, fromDate);
    if (records.length === 0) {
      await db.collection('establishments').doc(establishmentId).set({
        buildingPermits: {
          available: true,
          jurisdiction: 'Austin',
          recentPermits: [],
          hasSignificantRecentWork: false,
          largestRecentPermitValue: 0,
          matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        'enrichment.buildingPermits': 'no_match',
        'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await logPermitEnrichment(establishmentId, 'skip', 'Austin: no permits in lookback window');
      return 'no_match';
    }

    const targetAddress = extractPrimaryAddress(address);
    const scored = records.map((record) => {
      const candidateAddress = extractPrimaryAddress(record.original_address1 ?? '');
      const zipMatch = estData.zipCode && record.original_zip
        ? String(estData.zipCode).slice(0, 5) === String(record.original_zip).slice(0, 5)
        : false;
      const addressConfidence = similarity(targetAddress, candidateAddress);
      const confidence = Math.min(0.8, addressConfidence + (zipMatch ? 0.05 : 0));
      return { record, candidateAddress, confidence };
    });

    const best = scored.sort((left, right) => right.confidence - left.confidence)[0];

    if (!best || best.confidence < MATCH_THRESHOLD) {
      await db.collection('establishments').doc(establishmentId).set({
        buildingPermits: {
          available: true,
          jurisdiction: 'Austin',
          recentPermits: [],
          hasSignificantRecentWork: false,
          largestRecentPermitValue: 0,
          confidence: best?.confidence ?? 0,
          matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        'enrichment.buildingPermits': 'no_match',
        'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await logPermitEnrichment(establishmentId, 'skip', 'Austin: low-confidence address match', best?.confidence ?? 0, 'address');
      return 'no_match';
    }

    const matchingAddress = best.candidateAddress;
    const scoped = scored
      .filter((item) => item.candidateAddress === matchingAddress)
      .sort((left, right) => String(right.record.issue_date ?? '').localeCompare(String(left.record.issue_date ?? '')))
      .slice(0, 20)
      .map(({ record }) => ({
        permitType: record.permit_type_desc ?? record.work_class ?? record.permit_class_mapped ?? 'Unknown',
        issueDate: record.issue_date ? new Date(record.issue_date) : null,
        description: record.description ?? '',
        workValue: Number(record.total_job_valuation ?? 0),
        status: record.status_current ?? 'Unknown',
      }))
      .filter((record) => record.issueDate instanceof Date && !Number.isNaN(record.issueDate.getTime()));

    const largestRecentPermitValue = scoped.reduce((largest, record) => Math.max(largest, Number(record.workValue ?? 0)), 0);

    await db.collection('establishments').doc(establishmentId).set({
      buildingPermits: {
        available: true,
        jurisdiction: 'Austin',
        recentPermits: scoped,
        hasSignificantRecentWork: largestRecentPermitValue >= MIN_WORK_VALUE,
        largestRecentPermitValue,
        confidence: best.confidence,
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      'enrichment.buildingPermits': 'complete',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await logPermitEnrichment(establishmentId, 'success', `Austin permit match with ${scoped.length} permit(s)`, best.confidence, 'address');
    return 'complete';
  } catch (err: any) {
    await db.collection('establishments').doc(establishmentId).set({
      'enrichment.buildingPermits': 'error',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await logPermitEnrichment(establishmentId, 'error', err?.message ?? String(err));
    return 'error';
  }
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function runBuildingPermitsJob(options?: {
  county?: string;
  lookbackMonths?: number;
}): Promise<{
  processed: number;
  complete: number;
  noMatch: number;
  unavailable: number;
  error: number;
}> {
  const countyFilter = options?.county?.trim().toLowerCase();
  const lookbackMonths = options?.lookbackMonths ?? 24;
  const since = new Date();
  since.setMonth(since.getMonth() - lookbackMonths);

  const snapshot = await db.collection('establishments').get();

  let processed = 0;
  let complete = 0;
  let noMatch = 0;
  let unavailable = 0;
  let error = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const estCounty = String(data.county ?? '').trim().toLowerCase();
    if (countyFilter && estCounty !== countyFilter) continue;

    const recordDate = toDate(data.applicationDate) ?? toDate(data.firstSeenAt) ?? toDate(data.effectiveDate);
    if (recordDate && recordDate < since) continue;

    const status = await enrichBuildingPermitsForEstablishment(doc.id, data, lookbackMonths * 30);
    processed++;
    if (status === 'complete') complete++;
    else if (status === 'no_match') noMatch++;
    else if (status === 'unavailable') unavailable++;
    else error++;
  }

  return { processed, complete, noMatch, unavailable, error };
}