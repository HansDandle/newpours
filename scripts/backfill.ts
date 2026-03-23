/**
 * scripts/backfill.ts
 *
 * One-time local backfill script. Run with:
 *   npx ts-node scripts/backfill.ts [--county="Travis"] [--lookback-months=24]
 *
 * Phase 1 — TABC scoped ingest (county + lookback window)
 * Phase 2 — Comptroller scoped revenue backfill (county + lookback window)
 *
 * The script is resumable: it checks system/backfill docs before each phase.
 * Progress is logged to the console and appended to backfill.log in this directory.
 *
 * ⚠️  PREREQUISITES:
 * 1. Firebase project must be on the Blaze (pay-as-you-go) plan for scheduled
 *    Cloud Functions — not required for this local script, but required before
 *    deploying the enrichment pipeline.
 * 2. FIREBASE_ADMIN_* env vars must be set in .env.local.
 *
 * ─── [AGENT: CHECK] FIELD SCHEMA NOTES ──────────────────────────────────────
 * TABC issued licenses (7hf9-qc9f): no `taxpayer_number` field. Join to
 * Comptroller records falls back to fuzzy name + address matching.
 * Comptroller (naix-2893): `taxpayer_number`, `location_number`, `taxpayer_name`,
 * `location_name`, `location_address`, `location_city`, `location_zip`,
 * `obligation_end_date_yyyymmdd`, `liquor_receipts`, `wine_receipts`, `beer_receipts`,
 * `cover_charge_receipts`, `total_receipts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });

const db = getFirestore(app);

const LOG_FILE = path.resolve(__dirname, "backfill.log");
const TABC_ISSUED_API = "https://data.texas.gov/resource/7hf9-qc9f.json";
const TABC_PENDING_API = "https://data.texas.gov/resource/mxm5-tdpj.json";
const COMPTROLLER_API = "https://data.texas.gov/resource/naix-2893.json";
const PAGE_SIZE = 1000;
const SLEEP_MS = 500;

const ARG_COUNTY = process.argv.find((a) => a.startsWith("--county="));
const ARG_LOOKBACK = process.argv.find((a) => a.startsWith("--lookback-months="));
const COUNTY_FILTER = (ARG_COUNTY?.split("=")[1] ?? "").trim().toLowerCase();
const LOOKBACK_MONTHS_RAW = Number(ARG_LOOKBACK?.split("=")[1] ?? 24);
const LOOKBACK_MONTHS = Number.isFinite(LOOKBACK_MONTHS_RAW)
  ? Math.min(Math.max(Math.floor(LOOKBACK_MONTHS_RAW), 1), 24)
  : 24;

const SINCE_DATE = new Date();
SINCE_DATE.setMonth(SINCE_DATE.getMonth() - LOOKBACK_MONTHS);

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inLookbackWindow(value: string | undefined): boolean {
  const d = parseDate(value);
  if (!d) return false;
  return d >= SINCE_DATE;
}

function escapeSocrataString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildWhereClause(): string {
  const parts: string[] = [];
  if (COUNTY_FILTER) {
    parts.push(`upper(county) = upper('${escapeSocrataString(COUNTY_FILTER)}')`);
  }
  return parts.join(" AND ");
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    throw new Error(`Invalid month format: ${month}`);
  }
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function buildMonthList(startDate: Date, endDate: Date): string[] {
  const months: string[] = [];
  let cursor = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const end = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}`;

  while (cursor <= end) {
    months.push(cursor);
    cursor = nextMonth(cursor);
  }

  return months;
}

async function fetchSocrataRecords(url: string): Promise<Record<string, string>[]> {
  const res = await fetch(url);
  if (!res.ok) {
    let details = "";
    try {
      const text = await res.text();
      details = text.slice(0, 300);
    } catch {
      details = "";
    }
    throw new Error(`HTTP ${res.status} for ${url}${details ? ` :: ${details}` : ""}`);
  }

  const payload = await res.json();
  if (!Array.isArray(payload)) {
    const message =
      (payload as any)?.message ||
      (payload as any)?.error ||
      JSON.stringify(payload).slice(0, 300);
    throw new Error(`Unexpected Socrata response: ${message}`);
  }

  return payload as Record<string, string>[];
}

/** Normalize a name for fuzzy matching: strip legal suffixes, lowercase, remove punctuation */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|inc|lp|ltd|dba|corp|co\.?)\b/gi, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Simple Levenshtein distance */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalized edit distance (0 = identical, 1 = completely different) */
function editDistance(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return levenshtein(a, b) / maxLen;
}

/** Confidence score from normalized name + address similarity */
function computeConfidence(
  tabcName: string,
  tabcAddress: string,
  ctrlName: string,
  ctrlAddress: string
): number {
  const nameDist = editDistance(normalizeName(tabcName), normalizeName(ctrlName));
  const addrDist = editDistance(
    tabcAddress.toLowerCase().trim(),
    ctrlAddress.toLowerCase().trim()
  );
  const nameScore = 1 - nameDist;
  const addrScore = 1 - addrDist;
  const confidence = nameScore * 0.6 + addrScore * 0.4;
  // Clamp to [0, 0.85] for name+address fuzzy match (per spec)
  return Math.min(confidence, 0.85);
}

// ─── Phase 1: TABC Full Ingest ────────────────────────────────────────────────

async function phase1_tabcIngest() {
  const backfillRef = db.collection("system").doc("backfill");
  const backfillDoc = await backfillRef.get();
  if (backfillDoc.exists && backfillDoc.data()?.tabc_complete) {
    log("Phase 1: TABC ingest already complete — skipping.");
    return;
  }

  log(
    `Phase 1: Starting TABC ingest (county=${COUNTY_FILTER || "all"}, lookback=${LOOKBACK_MONTHS} months)…`
  );
  let totalWritten = 0;

  // Issued licenses
  const issuedWhereRaw = buildWhereClause();
  const issuedWhere = issuedWhereRaw ? `&$where=${encodeURIComponent(issuedWhereRaw)}` : "";
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${TABC_ISSUED_API}?$limit=${PAGE_SIZE}&$offset=${offset}&$order=current_issued_date DESC${issuedWhere}`;
    const records = await fetchSocrataRecords(url);
    if (records.length === 0) break;

    const batch = db.batch();
    let writtenThisPage = 0;
    for (const r of records) {
      if (!r.license_id) continue;
      if (!inLookbackWindow(r.current_issued_date)) continue;
      const id = `lic-${r.license_id}`;
      const ref = db.collection("establishments").doc(id);
      batch.set(
        ref,
        {
          licenseNumber: id,
          businessName: r.trade_name ?? "",
          ownerName: r.owner ?? "",
          tradeName: r.trade_name ?? "",
          address: r.address ?? "",
          address2: r.address_2 ?? "",
          city: r.city ?? "",
          county: r.county ?? "",
          zipCode: (r.zip ?? "").slice(0, 5),
          licenseType: r.license_type ?? "",
          licenseTypeLabel: r.tier ?? "",
          status: r.primary_status ?? "",
          applicationDate: r.current_issued_date ?? null,
          effectiveDate: r.current_issued_date ?? null,
          expirationDate: r.expiration_date ?? null,
          phone: r.phone ?? "",
          legacyClp: r.legacy_clp ?? "",
          secondaryStatus: r.secondary_status ?? "",
          statusChangeDate: r.status_change_date ?? null,
          mailAddress: r.mail_address ?? "",
          mailCity: r.mail_city ?? "",
          mailZip: (r.mail_zip ?? "").slice(0, 5),
          enrichment: {
            googlePlaces: "pending",
            comptroller: "pending",
            healthInspection: "pending",
            buildingPermits: "pending",
          },
          firstSeenAt: FieldValue.serverTimestamp(),
          isNew: true,
        },
        { merge: true }
      );
      writtenThisPage++;
    }
    await batch.commit();
    totalWritten += writtenThisPage;
    log(`  Phase 1 issued: offset=${offset}, fetched=${records.length}, written=${writtenThisPage}, total=${totalWritten}`);
    await sleep(SLEEP_MS);

    if (records.length < PAGE_SIZE) break;
  }

  // Pending applications
  const pendingWhereRaw = buildWhereClause();
  const pendingWhere = pendingWhereRaw ? `&$where=${encodeURIComponent(pendingWhereRaw)}` : "";
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${TABC_PENDING_API}?$limit=${PAGE_SIZE}&$offset=${offset}&$order=submission_date DESC${pendingWhere}`;
    const records = await fetchSocrataRecords(url);
    if (records.length === 0) break;

    const batch = db.batch();
    let writtenThisPage = 0;
    for (const r of records) {
      if (!r.applicationid) continue;
      if (!inLookbackWindow(r.submission_date)) continue;
      const id = `app-${r.applicationid}`;
      const ref = db.collection("establishments").doc(id);
      batch.set(
        ref,
        {
          licenseNumber: id,
          businessName: r.trade_name ?? r.owner ?? "",
          ownerName: r.owner ?? "",
          tradeName: r.trade_name ?? "",
          address: r.address ?? "",
          address2: r.address_2 ?? "",
          city: r.city ?? "",
          county: r.county ?? "",
          zipCode: (r.zip ?? "").slice(0, 5),
          licenseType: r.license_type ?? "",
          licenseTypeLabel: "Pending Application",
          status: r.applicationstatus ?? "Pending",
          applicationDate: r.submission_date ?? null,
          phone: r.phone ?? "",
          enrichment: {
            googlePlaces: "pending",
            comptroller: "pending",
            healthInspection: "pending",
            buildingPermits: "pending",
          },
          firstSeenAt: FieldValue.serverTimestamp(),
          isNew: true,
        },
        { merge: true }
      );
      writtenThisPage++;
    }
    await batch.commit();
    totalWritten += writtenThisPage;
    log(`  Phase 1 pending: offset=${offset}, fetched=${records.length}, written=${writtenThisPage}, total=${totalWritten}`);
    await sleep(SLEEP_MS);

    if (records.length < PAGE_SIZE) break;
  }

  await backfillRef.set(
    {
      tabc_complete: true,
      tabc_count: totalWritten,
      tabc_completedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  log(`Phase 1 complete. Total records written: ${totalWritten}`);
}

// ─── Phase 2: Comptroller Scoped Backfill ─────────────────────────────────---

/** Build a map of normalized address → establishment doc id for matching */
async function buildAddressIndex(): Promise<{
  index: Map<string, { id: string; name: string; address: string }>;
  citySet: Set<string>;
}> {
  const index = new Map<string, { id: string; name: string; address: string }>();
  const citySet = new Set<string>();
  const snap = await db.collection("establishments").get();
  for (const doc of snap.docs) {
    const d = doc.data();
    const estCounty = String(d.county ?? "").toLowerCase().trim();
    if (COUNTY_FILTER && estCounty !== COUNTY_FILTER) continue;

    const key = `${(d.address ?? "").toLowerCase().trim()}|${(d.city ?? "").toLowerCase().trim()}`;
    index.set(key, { id: doc.id, name: d.businessName ?? "", address: d.address ?? "" });
    const city = String(d.city ?? "").toLowerCase().trim();
    if (city) citySet.add(city);
  }
  return { index, citySet };
}

async function phase2_comptrollerBackfill() {
  const backfillRef = db.collection("system").doc("backfill");
  const backfillDoc = await backfillRef.get();
  if (backfillDoc.exists && backfillDoc.data()?.comptroller_complete) {
    log("Phase 2: Comptroller backfill already complete — skipping.");
    return;
  }

  log(
    `Phase 2: Building establishment address index (county=${COUNTY_FILTER || "all"}, lookback=${LOOKBACK_MONTHS} months)…`
  );
  const { index: addressIndex, citySet } = await buildAddressIndex();
  log(`Phase 2: Index built — ${addressIndex.size} establishments across ${citySet.size} cities.`);

  const CONFIDENCE_THRESHOLD = 0.70;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let monthsProcessed = 0;

  // Generate months from lookback window start to now using UTC-safe month math
  const start = new Date(Date.UTC(SINCE_DATE.getUTCFullYear(), SINCE_DATE.getUTCMonth(), 1));
  const now = new Date();
  const months = buildMonthList(start, now);

  for (const month of months) {
    const monthStart = `${month}-01T00:00:00.000`;
    const nextMonthStart = `${nextMonth(month)}-01T00:00:00.000`;

    log(`  Phase 2: Processing month ${month}…`);
    let monthMatched = 0;
    let monthUnmatched = 0;
    let monthFetched = 0;
    let monthConsidered = 0;

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const where = encodeURIComponent(
        `obligation_end_date_yyyymmdd >= '${monthStart}' AND obligation_end_date_yyyymmdd < '${nextMonthStart}'`
      );
      const url = `${COMPTROLLER_API}?$where=${where}&$limit=${PAGE_SIZE}&$offset=${offset}`;
      let records: Record<string, string>[] = [];
      try {
        records = await fetchSocrataRecords(url);
      } catch (err: any) {
        log(`  Phase 2: ${err.message} for ${month} offset ${offset} — skipping page`);
        break;
      }
      if (records.length === 0) break;
      monthFetched += records.length;

      let batch = db.batch();
      let batchOps = 0;

      for (const r of records) {
        const ctrlCity = (r.location_city ?? "").toLowerCase().trim();
        if (COUNTY_FILTER && ctrlCity && !citySet.has(ctrlCity)) {
          continue;
        }
        monthConsidered++;

        const ctrlAddress = (r.location_address ?? "").toLowerCase().trim();
        const addrKey = `${ctrlAddress}|${ctrlCity}`;

        let matchId: string | null = null;
        let confidence = 0;
        let matchMethod = "none";

        // Try exact address key first
        const addrMatch = addressIndex.get(addrKey);
        if (addrMatch) {
          confidence = computeConfidence(
            addrMatch.name,
            addrMatch.address,
            r.taxpayer_name ?? r.location_name ?? "",
            r.location_address ?? ""
          );
          if (confidence >= CONFIDENCE_THRESHOLD) {
            matchId = addrMatch.id;
            matchMethod = "address+fuzzy_name";
          }
        }

        const monthRecord = {
          month,
          liquorReceipts: parseFloat(r.liquor_receipts ?? "0"),
          wineReceipts: parseFloat(r.wine_receipts ?? "0"),
          beerReceipts: parseFloat(r.beer_receipts ?? "0"),
          coverChargeReceipts: parseFloat(r.cover_charge_receipts ?? "0"),
          totalReceipts: parseFloat(r.total_receipts ?? "0"),
        };

        if (matchId) {
          const ref = db.collection("establishments").doc(matchId);
          batch.set(
            ref,
            {
              "comptroller.taxpayerNumber": r.taxpayer_number ?? "",
              "comptroller.monthlyRecords": FieldValue.arrayUnion(monthRecord),
              "comptroller.latestMonthRevenue": monthRecord.totalReceipts,
              "comptroller.revenueDataThrough": month,
              "comptroller.confidence": confidence,
              "comptroller.matchMethod": matchMethod,
              "enrichment.comptroller": "complete",
            },
            { merge: true }
          );
          batchOps++;
          monthMatched++;
        } else {
          // Write to holding collection for manual review
          const unmatchedId = `${r.taxpayer_number ?? "unknown"}_${r.location_number ?? "0"}_${month}`;
          const unmatchedRef = db.collection("comptroller_unmatched").doc(unmatchedId);
          batch.set(unmatchedRef, {
            taxpayerNumber: r.taxpayer_number ?? "",
            taxpayerName: r.taxpayer_name ?? "",
            locationName: r.location_name ?? "",
            locationNumber: r.location_number ?? "",
            address: r.location_address ?? "",
            city: r.location_city ?? "",
            zip: r.location_zip ?? "",
            latestMonthRevenue: parseFloat(r.total_receipts ?? "0"),
            latestMonth: month,
            monthRecord,
          }, { merge: true });
          batchOps++;
          monthUnmatched++;
        }

        // Firestore batch limit is 500
        if (batchOps >= 490) {
          await batch.commit();
          batch = db.batch();
          batchOps = 0;
          await sleep(100);
        }
      }

      if (batchOps > 0) await batch.commit();
      await sleep(SLEEP_MS);

      if (records.length < PAGE_SIZE) break;
    }

    totalMatched += monthMatched;
    totalUnmatched += monthUnmatched;
    monthsProcessed++;
    log(
      `  Phase 2: ${month} done — fetched=${monthFetched}, considered=${monthConsidered}, matched=${monthMatched}, unmatched=${monthUnmatched}`
    );
  }

  await backfillRef.set(
    {
      comptroller_complete: true,
      comptroller_months_processed: monthsProcessed,
      comptroller_records_matched: totalMatched,
      comptroller_records_unmatched: totalUnmatched,
      comptroller_completedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  log(`Phase 2 complete. Matched: ${totalMatched}, Unmatched: ${totalUnmatched}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("=== NewPours Backfill Script Starting ===");
  log(`Options: county=${COUNTY_FILTER || "all"}, lookbackMonths=${LOOKBACK_MONTHS}`);
  await phase1_tabcIngest();
  await phase2_comptrollerBackfill();
  log("=== Backfill Complete ===");
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
