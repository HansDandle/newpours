# New Pours — Data Enrichment Pipeline Spec

> **For the AI agent:** This document defines the enrichment pipeline to be layered on top of the existing TABC license ingestion. All enrichment sources in this spec are free. Do not integrate any paid APIs without explicit approval. When you reach a section marked `[AGENT: ASK]`, stop and ask the user before proceeding.

---

## 1. Overview & Goals

The enrichment pipeline takes raw TABC license records stored in Firestore and progressively adds data from external public sources. The result is a rich, unified establishment profile per record — more valuable than any single source alone.

**Guiding principles:**
- **Free APIs only** in this phase — no paid data sources
- **Conservative matching** — only associate external data when confidence is high; never overwrite a field with a lower-confidence match
- **No duplicates** — one canonical Firestore document per physical establishment, regardless of how many source records reference it
- **Idempotent runs** — every enrichment job can safely re-run without creating duplicate writes; use Firestore `set(..., { merge: true })` throughout
- **Graceful degradation** — if an external source is unavailable or returns no match, log it and move on; never fail the whole record

---

## 2. Canonical Record & Confidence Model

### Master Record Location
All enriched data lives in Firestore at `establishments/{establishmentId}`.

The `establishmentId` is a deterministic hash of the TABC license number — never auto-generated. This makes all enrichment jobs idempotent and collision-free.

### Confidence Scoring
Every joined field from an external source must include a companion confidence field:

```ts
{
  googlePlacesId: "ChIJ...",
  googlePlacesId_confidence: 0.95,   // 0.0 – 1.0
  googlePlacesId_matchMethod: "name+address",
  googlePlacesId_matchedAt: Timestamp,
}
```

**Confidence thresholds:**
| Score | Meaning | Action |
|---|---|---|
| >= 0.90 | High confidence | Write to record, surface in UI |
| 0.70 – 0.89 | Medium confidence | Write to record, flag for review |
| < 0.70 | Low confidence | Log only, do NOT write to record |

### Matching Logic (General Rules)
Apply these rules across all enrichment sources:

1. **Exact license number match** → confidence 1.0 (TABC and Comptroller share a taxpayer number)
2. **Name + address match** → start at 0.85, adjust up/down based on string similarity
3. **Name only match** → max confidence 0.70 (do not write)
4. **Address only match** → max confidence 0.60 (do not write)
5. **Fuzzy name matching:** Use normalized comparison — strip legal suffixes (LLC, Inc, LP, DBA), lowercase, remove punctuation, then use Levenshtein distance or similar. A normalized edit distance ≤ 0.15 is a strong match.
6. **Never merge two records** that have different TABC license numbers unless there is explicit evidence they are the same physical location (e.g. a license transfer with the same address).

---

## 3. Enrichment Source 1 — Texas Comptroller Mixed Beverage Gross Receipts

### Purpose
Adds estimated monthly alcohol revenue, revenue trend, and breakdown by liquor/wine/beer to each establishment record.

### Data Source
- **Dataset:** Mixed Beverage Gross Receipts
- **Socrata endpoint:** `https://data.texas.gov/resource/naix-2893.json`
- **Update frequency:** Monthly (new data typically available by the 25th of the following month)
- **Auth required:** None (public SODA2 API)

### Key Fields Available
| Field | Description |
|---|---|
| `taxpayer_number` | 11-digit Texas comptroller taxpayer ID |
| `taxpayer_name` | Legal entity name |
| `location_name` | DBA / trade name |
| `location_address` | Street address |
| `location_city` | City |
| `location_zip` | ZIP code |
| `obligation_end_date` | Reporting month (YYYY-MM-DD) |
| `liquor_receipts` | Monthly liquor sales $ |
| `wine_receipts` | Monthly wine sales $ |
| `beer_receipts` | Monthly beer/malt liquor sales $ |
| `cover_charge_receipts` | Monthly cover charge $ |
| `total_receipts` | Sum of above |

### Join Strategy
The Comptroller's `taxpayer_number` is the same identifier used on TABC license applications. **If the TABC dataset includes a taxpayer number field, use it as the primary join key (confidence 1.0).** If not present in the TABC record, fall back to fuzzy name + address matching.

> **[AGENT: CHECK]** Before writing join logic, inspect the actual fields on both the TABC dataset (`https://data.texas.gov/resource/ab7a-aabn.json?$limit=1`) and the Comptroller dataset (`https://data.texas.gov/resource/naix-2893.json?$limit=1`) and document which fields are available. Adjust the join strategy accordingly.

### Revenue Calculation
The mixed beverage gross receipts tax rate is 6.7%. The public dataset reports the **dollar amount of sales**, not the tax paid, so `total_receipts` is directly usable as an estimated monthly revenue figure — no back-calculation needed.

### Fields to Write to Establishment Record
```ts
comptroller: {
  taxpayerNumber: string,
  monthlyRecords: [
    {
      month: "2025-11",           // YYYY-MM
      liquorReceipts: number,
      wineReceipts: number,
      beerReceipts: number,
      coverChargeReceipts: number,
      totalReceipts: number,
    }
  ],
  // Computed from monthlyRecords:
  latestMonthRevenue: number,
  avgMonthlyRevenue: number,       // 3-month rolling average
  revenuetrend: 'up' | 'flat' | 'down',  // compare last 3 months vs prior 3 months
  revenueDataFrom: Timestamp,      // oldest month in our dataset for this record
  revenueDataThrough: Timestamp,   // most recent month
  confidence: number,
  matchMethod: string,
}
```

### Polling Schedule
- Run monthly, triggered by a Firebase Scheduled Function on the 26th of each month
- Fetch only records where `obligation_end_date` equals the most recently published month
- Diff against existing `monthlyRecords` array; append new months, never overwrite existing ones

### Duplicate / Multi-Location Handling
A single taxpayer may have multiple locations under one taxpayer number. The Comptroller dataset includes a `location_number` field. Treat each unique `taxpayer_number + location_number` combination as a separate establishment. Match to TABC records by address when taxpayer number alone is ambiguous.

---

## 4. Enrichment Source 2 — Google Places API

### Purpose
Adds star rating, review count, price level, phone number, website, hours, and a place photo reference to each establishment.

### Data Source
- **API:** Google Places API (New) — Text Search + Place Details
- **Cost:** Free within monthly $200 credit (~10,000 Text Search calls/month free)
- **Auth:** Requires `GOOGLE_MAPS_API_KEY` (already in stack)

### Matching Strategy
1. Call Text Search with query: `"{business_name}" "{street_address}" "{city}" Texas`
2. Take the top result only
3. Compute confidence:
   - Name similarity (normalized Levenshtein) contributes 60% of score
   - Address similarity contributes 40% of score
   - If computed confidence >= 0.85, accept the match
   - If < 0.85, log as unmatched; do not write

### Fields to Write
```ts
googlePlaces: {
  placeId: string,
  name: string,                  // As returned by Google
  rating: number,                // 1.0 – 5.0
  reviewCount: number,
  priceLevel: 1 | 2 | 3 | 4,    // $ to $$$$
  phoneNumber: string,
  website: string,
  hours: object,                 // Google's opening_hours object
  photoReference: string,        // First photo reference for display
  lat: number,
  lng: number,
  confidence: number,
  matchedAt: Timestamp,
}
```

### Notes
- Run once per new establishment record, triggered by Firestore `onCreate`
- Re-run quarterly to catch rating/review count changes (scheduled batch job)
- The geocoordinates from this step replace any less-precise geocoding done at ingest time
- Rate limit: stay under 10 QPS; use a queue with delay between calls

---

## 5. Enrichment Source 3 — Health Inspection Data

### Purpose
Adds health inspection score and violation history. Relevant to buyers evaluating operational risk (vendors, insurance brokers, investors).

### Important Caveat — County-by-County Fragmentation
Health inspection data in Texas is **not centralized**. Each local health authority publishes (or doesn't publish) its own data. The agent must handle this source-by-source.

**Strategy:** Enrich only for counties/cities where a clean public data source exists. Skip others gracefully — write `healthInspection: { available: false, reason: "no public data for this jurisdiction" }`.

### Currently Available Sources

#### Austin / Travis County
- **Source:** City of Austin Open Data Portal
- **Dataset:** Food Establishment Inspection Scores
- **Endpoint:** `https://data.austintexas.gov/resource/ecmv-9xxi.json` *(verify current endpoint)*
- **Fields:** establishment name, address, score, inspection date, violation details
- **Match strategy:** Name + address fuzzy match against TABC record; confidence threshold 0.85

#### Dallas
- **Source:** City of Dallas Open Data
- **Dataset:** Environmental Health Restaurant Inspections
- **Endpoint:** Check `https://www.dallasopendata.com` for current dataset *(verify at build time)*

#### Houston / Harris County
- **Source:** Harris County Public Health or City of Houston open data
- **Note:** As of early 2025 this data is inconsistently published. Check `https://opendata.houstontx.gov` at build time. If not available, skip and mark as unavailable.

#### San Antonio / Bexar County
- **Source:** Check `https://data.sanantonio.gov` at build time
- **Note:** May require scraping the city's inspection search page if no SODA2 endpoint exists

> **[AGENT: ASK]** Before building health inspection ingestion, check each of the above endpoints and report back to the user which ones are live, what fields are available, and whether they require scraping vs. API. Get approval before writing a scraper for any jurisdiction.

### Fields to Write
```ts
healthInspection: {
  available: boolean,
  jurisdiction: string,          // e.g. "Austin/Travis County"
  latestScore: number,           // e.g. 95
  latestInspectionDate: Timestamp,
  inspectionHistory: [
    {
      date: Timestamp,
      score: number,
      violationCount: number,
      criticalViolationCount: number,
    }
  ],
  scoretrend: 'improving' | 'stable' | 'declining',
  confidence: number,
  matchedAt: Timestamp,
}
```

---

## 6. Enrichment Source 4 — Building Permits

### Purpose
Identifies establishments that have recently pulled significant renovation or construction permits — a signal of growth, reopening, or major capital investment.

### Important Caveat — County-by-County Fragmentation
Like health inspections, building permit data is published by individual municipalities. Handle county by county.

**Strategy:** Same as health inspections — enrich where clean data exists, skip gracefully elsewhere.

### Currently Available Sources

#### Austin
- **Source:** City of Austin Development Services
- **Endpoint:** `https://data.austintexas.gov/resource/3syk-w9eu.json` *(verify)*
- **Fields:** permit type, issue date, address, description, work value ($)
- **Filter:** Only pull permits with work value > $10,000 and issued in the last 24 months

#### Dallas
- **Source:** `https://www.dallasopendata.com` — search for "building permits"

#### Houston
- **Source:** `https://opendata.houstontx.gov` — search for "permits"

#### San Antonio
- **Source:** `https://data.sanantonio.gov`

> **[AGENT: ASK]** Same process as health inspections — verify each endpoint is live before building, and get user approval before writing any scrapers.

### Match Strategy
Building permits are matched by **address only** (there is no business name on most permits, just a property address). Normalize addresses before comparing:
- Expand abbreviations (St → Street, Ave → Avenue, etc.)
- Strip suite/unit numbers for the primary match
- Match on street number + street name + city; zip is a tiebreaker

Confidence ceiling for address-only matches: **0.80** (acceptable for permit data since we're matching a physical location, not a business entity).

### Fields to Write
```ts
buildingPermits: {
  available: boolean,
  jurisdiction: string,
  recentPermits: [
    {
      permitType: string,        // e.g. "Commercial Remodel"
      issueDate: Timestamp,
      description: string,
      workValue: number,         // in dollars
      status: string,
    }
  ],
  hasSignificantRecentWork: boolean,   // true if any permit > $10k in last 24 months
  largestRecentPermitValue: number,
  confidence: number,
  matchedAt: Timestamp,
}
```

---

## 7. A Note on EIN / Federal Business Data

> **For the user's reference:** The Comptroller dataset uses an 11-digit Texas taxpayer number, not a federal EIN. The IRS does **not** provide a free public API for EIN lookups on for-profit businesses. The only free federal sources are:
> - **SEC EDGAR** — public companies only (not useful for bars/restaurants)
> - **IRS Tax Exempt Organization Search** — nonprofits only
>
> All EIN lookup services that return owner/principal data for private businesses are paid (Middesk, EINsearch, Judy Diamond, etc.). This enrichment is **deferred to a future paid tier** and is not included in this spec. The Texas Secretary of State's SOSDirect is the best available free-ish source for owner data, but charges $1/lookup — also deferred.
>
> **Practical impact:** Owner/principal name data will not be in the enriched record for this phase. Business name, DBA name, address, and the taxpayer number are sufficient for matching purposes.

---

## 8. Enrichment Pipeline Architecture

### Trigger Map
| Trigger | Function | Sources |
|---|---|---|
| New license doc created in Firestore | `enrichNewEstablishment` | Google Places (immediate) |
| Daily scheduled job, 7:00 AM CST | `enrichHealthInspections` | Health inspection APIs (by county) |
| Daily scheduled job, 7:30 AM CST | `enrichBuildingPermits` | Permit APIs (by county) |
| Monthly scheduled job, 26th at 6:00 AM CST | `enrichComptrollerRevenue` | Comptroller SODA2 |
| Quarterly scheduled job | `refreshGooglePlaces` | Google Places (re-fetch ratings/hours) |

### Queue & Rate Limiting
- Use **Firebase Task Queues** (Cloud Tasks) for Google Places calls — process one at a time with 200ms delay between calls to stay under rate limits
- Health inspection and permit jobs process by county in sequence, not in parallel
- All jobs write to Firestore with `merge: true` — safe to re-run

### Error Handling
For every enrichment source, implement this pattern:
```ts
try {
  const result = await fetchFromSource(record);
  if (result.confidence >= CONFIDENCE_THRESHOLD) {
    await db.doc(`establishments/${id}`).set(result.data, { merge: true });
    await logEnrichmentSuccess(id, source, result.confidence);
  } else {
    await logEnrichmentSkip(id, source, result.confidence, "below threshold");
  }
} catch (err) {
  await logEnrichmentError(id, source, err.message);
  // Do NOT throw — let the job continue with other records
}
```

### Enrichment Status Tracking
Add an `enrichment` map to each establishment doc to track what's been attempted:
```ts
enrichment: {
  googlePlaces: 'complete' | 'no_match' | 'pending' | 'error',
  comptroller: 'complete' | 'no_match' | 'pending' | 'error',
  healthInspection: 'complete' | 'no_match' | 'unavailable' | 'pending' | 'error',
  buildingPermits: 'complete' | 'no_match' | 'unavailable' | 'pending' | 'error',
  lastEnrichedAt: Timestamp,
}
```
This lets the dashboard show data completeness indicators and lets batch jobs skip already-enriched records efficiently.

---

## 9. Deduplication Strategy

### Problem
The same physical bar may appear under multiple records:
- TABC record (by license number)
- Comptroller record (by taxpayer + location number)
- Health inspection record (by name/address)
- Building permit record (by address)

The goal is one canonical `establishments/{id}` document that aggregates all sources.

### Rules
1. **Primary key is always the TABC license number** — this is the authoritative identifier. All enrichment hangs off of it.
2. **Never create an establishment doc from a non-TABC source.** Comptroller, health, and permit data only enriches existing TABC-seeded docs.
3. **If two TABC license numbers resolve to the same address** (e.g. a license transfer), keep both docs but add a `relatedLicenses: string[]` field linking them. Do not merge.
4. **If Google Places returns the same `placeId` for two different TABC license records**, flag both for manual review by writing `duplicateFlag: true` and `duplicatePlaceId: string` — do not auto-merge.
5. **Comptroller multi-location:** As noted above, use `taxpayer_number + location_number` as the Comptroller-side key. Match each location to a TABC record by address. If no address match, write the Comptroller data to a holding collection `comptroller_unmatched/{id}` for future review.

---

## 10. Firebase Plan & Cost Reality

### Upgrade to Blaze (Pay-as-You-Go) Before Building This Pipeline

**Scheduled Cloud Functions are not available on the free Spark plan.** The entire enrichment pipeline depends on scheduled functions, so Blaze is a hard requirement — not optional.

The good news: Blaze retains all free tier quotas and real-world costs at New Pours' data volume are negligible.

**Free daily quotas (retained on Blaze):**
- 50,000 Firestore reads/day
- 20,000 Firestore writes/day
- 20,000 Firestore deletes/day
- 1GB storage included

**Estimated one-time backfill cost:**
- ~100,000 TABC establishment writes: ~$0.18
- ~3.6M Comptroller monthly records (5 years × ~60K filers × 12 months), stored as arrays on establishment docs rather than individual documents: covered by the establishment write cost — no extra per-month-record write fee since monthly data is appended to the parent doc array
- Total backfill: **under $1.00**

**Estimated ongoing monthly cost:**
- Daily TABC ingest (~500 new/changed records): negligible
- Monthly Comptroller update (~60K records): ~$0.11 in writes
- Dashboard reads (depends on subscriber count): budget $5–10/month at early scale
- Cloud Functions invocations: well within free tier (2M invocations/month free)
- **Realistic monthly bill at early stage: $5–15**

> **[AGENT: ASK]** Confirm with the user that the Firebase project has been upgraded to the Blaze plan before deploying any scheduled functions or running the backfill script.

### Firestore Storage Pattern for Monthly Revenue Data

**Do not use a subcollection for Comptroller monthly records.** Store all monthly data as an array directly on the establishment document.

**Why:** A subcollection of 60 monthly documents costs 60 Firestore reads every time a user views an establishment profile. An array on the parent document costs 1 read regardless of how many months of data it contains.

```ts
// CORRECT — array on parent doc, 1 read to get everything
establishments/{id}: {
  ...tabc fields,
  comptroller: {
    taxpayerNumber: string,
    monthlyRecords: [
      { month: "2021-01", liquorReceipts: 0, wineReceipts: 0, beerReceipts: 0, coverChargeReceipts: 0, totalReceipts: 0 },
      { month: "2021-02", ... },
      // up to 60 months — ~15KB max, well within 1MB doc limit
    ],
    latestMonthRevenue: number,
    avgMonthlyRevenue: number,
    revenueTrend: 'up' | 'flat' | 'down',
    revenueDataFrom: string,    // "2021-01"
    revenueDataThrough: string, // "2025-11"
  }
}

// WRONG — subcollection costs 60 reads per profile view
establishments/{id}/comptrollerMonths/{month}: { ... }
```

When appending a new month during the monthly update job, use Firestore `arrayUnion` to add the new month object without rewriting the entire array.

---

## 11. Historical Backfill Script

### Overview
A one-time Node.js script run locally (not as a Cloud Function) to populate the database with all historical TABC licenses and 5 years of Comptroller revenue data. Running locally avoids Cloud Function timeout limits (540s max) and is easier to monitor and resume.

### Script Location
`scripts/backfill.ts` — run with `npx ts-node scripts/backfill.ts`

### Backfill Sequence

**Phase 1 — TABC Full License Ingest**
```
1. Fetch all records from TABC SODA2 endpoint using $limit=1000 pagination
2. For each page:
   a. Write each record to establishments/{hash(licenseNumber)} using batch writes (500 ops/batch)
   b. Set enrichment status fields to 'pending' for all sources
   c. Log progress: "Page X complete — Y total records written"
   d. Sleep 500ms between pages to avoid rate limiting
3. On completion, write a metadata doc to system/backfill with:
   - tabc_complete: true
   - tabc_count: number
   - tabc_completedAt: timestamp
```

**Phase 2 — Comptroller 5-Year Backfill**
```
Date range: January 2021 through most recent published month

For each month in range (oldest to newest):
  1. Fetch all Comptroller records for that obligation_end_date using $limit=1000 pagination
  2. For each record, find matching establishment doc by taxpayer_number (or fuzzy name+address)
  3. If match found (confidence >= threshold):
     a. Append month object to comptroller.monthlyRecords array using arrayUnion
     b. Recompute latestMonthRevenue, avgMonthlyRevenue, revenueTrend
     c. Write with merge: true
  4. If no match: write to comptroller_unmatched/{taxpayerNumber_locationNumber}
  5. Log progress per month: "2021-03 complete — X matched, Y unmatched"
  6. Sleep 500ms between pages

On completion, update system/backfill with:
  - comptroller_complete: true
  - comptroller_months_processed: number
  - comptroller_records_matched: number
  - comptroller_records_unmatched: number
  - comptroller_completedAt: timestamp
```

### Resumability
The script must be resumable in case of interruption:
- Before starting Phase 1, check `system/backfill.tabc_complete` — skip if true
- Before processing each Comptroller month, check if that month's data already exists on a sample of records — skip the month if already processed
- Log all progress to a local `backfill.log` file in addition to console output

### Rate Limiting
- SODA2 API: 500ms sleep between paginated requests
- Firestore batch writes: max 500 operations per batch; await each batch before starting the next
- Do not run the backfill concurrently with any other enrichment jobs

---

## 12. Build Order

1. Confirm Firebase project is on Blaze plan before proceeding
2. Inspect actual field schemas of all SODA2 endpoints (TABC + Comptroller) and document findings
3. Build and run `scripts/backfill.ts` — Phase 1 (TABC full ingest), then Phase 2 (Comptroller 5-year)
4. Build `enrichNewEstablishment` Cloud Function (Google Places trigger on new doc)
5. Build `enrichComptrollerRevenue` scheduled function for ongoing monthly updates
6. Verify which health inspection endpoints are live; report to user before building anything
7. Build health inspection enrichment for confirmed-live jurisdictions only
8. Verify which building permit endpoints are live; report to user before building anything
9. Build building permit enrichment for confirmed-live jurisdictions only
10. Build `refreshGooglePlaces` quarterly batch job
11. Add enrichment status indicators to the dashboard UI
12. Add `comptroller_unmatched` review queue to admin panel

---

*Last updated: March 2026 | New Pours enrichment pipeline v1 — free APIs only*
