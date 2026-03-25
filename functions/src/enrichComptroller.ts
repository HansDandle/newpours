/**
 * Comptroller Revenue Enrichment — scheduled monthly on the 26th.
 *
 * ⚠️  BLAZE PLAN REQUIRED: Scheduled Cloud Functions are not available on the
 * Firebase Spark (free) plan. Upgrade the project to Blaze before deploying.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const COMPTROLLER_API = 'https://data.texas.gov/resource/naix-2893.json';
const PAGE_SIZE = 1000;
const CONFIDENCE_THRESHOLD = 0.70;

export interface ComptrollerRunResult {
  monthsProcessed: number;
  matched: number;
  unmatched: number;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|inc|lp|ltd|dba|corp|co\.?)\b/gi, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAddressKey(address: string): string {
  return address
    .toLowerCase()
    .replace(/\bmenchaca\b/g, 'manchaca')
    .replace(/\bmanchaca\b/g, 'manchaca')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
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

function computeConfidence(
  estName: string, estAddress: string,
  ctrlName: string, ctrlAddress: string
): number {
  const nameEdit = levenshtein(normalizeName(estName), normalizeName(ctrlName));
  const maxNameLen = Math.max(normalizeName(estName).length, normalizeName(ctrlName).length);
  const nameScore = maxNameLen > 0 ? 1 - nameEdit / maxNameLen : 1;

  const na = estAddress.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const nb = ctrlAddress.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const addrEdit = levenshtein(na, nb);
  const maxAddrLen = Math.max(na.length, nb.length);
  const addrScore = maxAddrLen > 0 ? 1 - addrEdit / maxAddrLen : 1;

  return Math.min(nameScore * 0.6 + addrScore * 0.4, 0.85);
}

async function logEnrichment(
  id: string,
  status: 'success' | 'skip' | 'error',
  message: string,
  confidence?: number
) {
  await db.collection('system/enrichmentLogs/items').add({
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    establishmentId: id,
    source: 'comptroller',
    status,
    confidence: confidence ?? null,
    message,
  }).catch(() => { /* non-fatal */ });
}

function getMonthString(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function buildMonthWindows(lookbackMonths: number): string[] {
  const safeLookback = Math.max(1, Math.floor(lookbackMonths));
  const months: string[] = [];
  for (let offset = safeLookback; offset >= 1; offset--) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCMonth(d.getUTCMonth() - offset);
    months.push(getMonthString(d));
  }
  return months;
}

export async function runComptrollerRevenueJob(options?: {
  county?: string;
  lookbackMonths?: number;
  writeUnmatched?: boolean;
  emitPerRecordLogs?: boolean;
}): Promise<ComptrollerRunResult> {
  const countyFilter = String(options?.county ?? '').trim().toLowerCase();
  const lookbackMonthsRaw = Number(options?.lookbackMonths ?? 1);
  const lookbackMonths = Number.isFinite(lookbackMonthsRaw)
    ? Math.min(Math.max(Math.floor(lookbackMonthsRaw), 1), 24)
    : 1;
  const writeUnmatched = options?.writeUnmatched ?? true;
  const emitPerRecordLogs = options?.emitPerRecordLogs ?? false;

  const estSnap = await db.collection('establishments').get();
  const addressIndex = new Map<string, Array<{ id: string; name: string; address: string }>>();
  const nameCityIndex = new Map<string, Array<{ id: string; name: string; address: string }>>();
  const citySet = new Set<string>();
  // Track existing revenue so we can compute month-over-month trend without extra reads
  const existingRevenueIndex = new Map<string, number>(); // id → latestMonthRevenue
  for (const d of estSnap.docs) {
    const data = d.data();
    const estCounty = (data.county ?? '').toLowerCase().trim();
    if (countyFilter && estCounty !== countyFilter) continue;
    const city = (data.city ?? '').toLowerCase().trim();
    const key = `${normalizeAddressKey(data.address ?? '')}|${city}`;
    if (city) citySet.add(city);
    const entry = { id: d.id, name: data.businessName ?? '', address: data.address ?? '' };
    const entries = addressIndex.get(key) ?? [];
    entries.push(entry);
    addressIndex.set(key, entries);

    const normalizedBusinessName = normalizeName(data.businessName ?? data.tradeName ?? '');
    if (normalizedBusinessName && city) {
      const nameKey = `${normalizedBusinessName}|${city}`;
      const nameEntries = nameCityIndex.get(nameKey) ?? [];
      nameEntries.push(entry);
      nameCityIndex.set(nameKey, nameEntries);
    }

    const prevRevenue = Number(data.comptroller?.latestMonthRevenue ?? data['comptroller.latestMonthRevenue']);
    if (Number.isFinite(prevRevenue) && prevRevenue > 0) {
      existingRevenueIndex.set(d.id, prevRevenue);
    }
  }

  let matched = 0;
  let unmatched = 0;
  let monthsProcessed = 0;

  for (const month of buildMonthWindows(lookbackMonths)) {
    const monthStart = `${month}-01T00:00:00.000`;
    const nextMonthDate = new Date(`${month}-01T00:00:00.000Z`);
    nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
    const nextMonthStart = nextMonthDate.toISOString().slice(0, 23);

    console.log(`runComptrollerRevenueJob: processing month ${month}${countyFilter ? ` county=${countyFilter}` : ''}`);

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const where = encodeURIComponent(
        `obligation_end_date_yyyymmdd >= '${monthStart}' AND obligation_end_date_yyyymmdd < '${nextMonthStart}'`
      );
      const url = `${COMPTROLLER_API}?$where=${where}&$limit=${PAGE_SIZE}&$offset=${offset}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Comptroller API returned HTTP ${res.status} for ${month} offset ${offset}`);
      }
      const records: Record<string, string>[] = await res.json();
      if (records.length === 0) break;

      let batch = db.batch();
      let batchOps = 0;

      for (const r of records) {
        const ctrlAddress = normalizeAddressKey(r.location_address ?? '');
        const ctrlCity = (r.location_city ?? '').toLowerCase().trim();
        if (countyFilter && ctrlCity && !citySet.has(ctrlCity)) {
          continue;
        }
        const addrKey = `${ctrlAddress}|${ctrlCity}`;

        const matchById = new Map<string, { id: string; confidence: number; matchMethod: string }>();
        const addrMatches = addressIndex.get(addrKey) ?? [];
        for (const addrMatch of addrMatches) {
          const confidence = computeConfidence(
            addrMatch.name,
            addrMatch.address,
            r.taxpayer_name ?? r.location_name ?? '',
            r.location_address ?? ''
          );
          if (confidence >= CONFIDENCE_THRESHOLD) {
            matchById.set(addrMatch.id, { id: addrMatch.id, confidence, matchMethod: 'address+fuzzy_name' });
          }
        }

        // Also propagate to exact-name siblings in the same city (e.g. pending renewal apps).
        const sourceNameKey = normalizeName(r.location_name ?? r.taxpayer_name ?? '');
        if (sourceNameKey && ctrlCity) {
          const siblings = nameCityIndex.get(`${sourceNameKey}|${ctrlCity}`) ?? [];
          for (const sibling of siblings) {
            if (!matchById.has(sibling.id)) {
              matchById.set(sibling.id, { id: sibling.id, confidence: 0.9, matchMethod: 'city+exact_name' });
            }
          }
        }

        const matchIds = [...matchById.values()];

        const monthRecord = {
          month,
          liquorReceipts: parseFloat(r.liquor_receipts ?? '0'),
          wineReceipts: parseFloat(r.wine_receipts ?? '0'),
          beerReceipts: parseFloat(r.beer_receipts ?? '0'),
          coverChargeReceipts: parseFloat(r.cover_charge_receipts ?? '0'),
          totalReceipts: parseFloat(r.total_receipts ?? '0'),
        };

        if (matchIds.length > 0) {
          for (const match of matchIds) {
            const ref = db.collection('establishments').doc(match.id);
            // Write monthly detail to subcollection (idempotent by month ID, keeps parent doc lean)
            const revenueRef = ref.collection('revenue').doc(month);
            batch.set(revenueRef, monthRecord);
            batchOps++;

            // Compute month-over-month trend from in-memory index (no extra reads needed)
            const prevRevenue = existingRevenueIndex.get(match.id) ?? 0;
            let revenueTrend: string | null = null;
            if (prevRevenue > 0 && monthRecord.totalReceipts > 0) {
              const ratio = (monthRecord.totalReceipts - prevRevenue) / prevRevenue;
              revenueTrend = ratio > 0.08 ? 'up' : ratio < -0.08 ? 'down' : 'flat';
            }
            // Update in-memory index for this session
            existingRevenueIndex.set(match.id, monthRecord.totalReceipts);

            // Update parent with aggregate stats only — no monthlyRecords array on parent
            const parentUpdate: Record<string, unknown> = {
              'comptroller.taxpayerNumber': r.taxpayer_number ?? '',
              'comptroller.latestMonthRevenue': monthRecord.totalReceipts,
              'comptroller.avgMonthlyRevenue': monthRecord.totalReceipts,
              'comptroller.revenueDataThrough': month,
              'comptroller.confidence': match.confidence,
              'comptroller.matchMethod': match.matchMethod,
              'enrichment.comptroller': 'complete',
            };
            if (revenueTrend) parentUpdate['comptroller.revenueTrend'] = revenueTrend;
            batch.set(ref, parentUpdate, { merge: true });
            matched++;
            batchOps++;
            if (emitPerRecordLogs) {
              await logEnrichment(match.id, 'success', `Wrote ${month} revenue to subcollection`, match.confidence);
            }
          }
        } else {
          if (writeUnmatched) {
            const unmatchedId = `${r.taxpayer_number ?? 'unknown'}_${r.location_number ?? '0'}_${month}`;
            batch.set(db.collection('comptroller_unmatched').doc(unmatchedId), {
              taxpayerNumber: r.taxpayer_number ?? '',
              taxpayerName: r.taxpayer_name ?? '',
              locationName: r.location_name ?? '',
              locationNumber: r.location_number ?? '',
              address: r.location_address ?? '',
              city: r.location_city ?? '',
              zip: r.location_zip ?? '',
              latestMonthRevenue: monthRecord.totalReceipts,
              latestMonth: month,
              monthRecord,
            }, { merge: true });
            batchOps++;
          }
          unmatched++;
        }

        if (batchOps >= 490) {
          await batch.commit();
          batch = db.batch();
          batchOps = 0;
        }
      }

      if (batchOps > 0) {
        await batch.commit();
      }

      if (records.length < PAGE_SIZE) break;
    }

    monthsProcessed++;
  }

  return {
    monthsProcessed,
    matched,
    unmatched,
  };
}

/** Monthly Comptroller update — fetches the most recently published month */
export const enrichComptrollerRevenue = onSchedule(
  { schedule: '0 6 26 * *', timeZone: 'America/Chicago' },
  async () => {
    const startedAt = Date.now();

    const result = await runComptrollerRevenueJob({ lookbackMonths: 1 });

    const durationMs = Date.now() - startedAt;
    await db.collection('system/jobRuns/items').add({
      jobName: 'comptroller_update',
      startedAt: new Date(startedAt),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      durationMs,
      status: 'success',
      recordsProcessed: result.matched + result.unmatched,
      recordsFailed: 0,
      notes: `Months: ${result.monthsProcessed}. Matched: ${result.matched}, Unmatched: ${result.unmatched}`,
    });

    console.log(`enrichComptrollerRevenue: done. matched=${result.matched} unmatched=${result.unmatched} duration=${durationMs}ms`);
  }
);
