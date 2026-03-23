Below is a `spec.md` you can hand to an AI agent to extend/modify your existing app.

***

# spec.md – Texas New Venue Lead Intelligence

## 1. Goal

Build a commercial‑grade “new and active bar/restaurant” lead product for Texas, focused on:  
- Early detection of new venues (pre‑opening through early operation). [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- High‑confidence validation that a record is a real venue, not an empty lot. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2020-08/public-roster-record-layout.pdf)
- Enriched decision‑maker contacts (owners/principals) with emails/phones where possible. [salesgenie](https://www.salesgenie.com/leads/food-and-restaurant-leads/)
- Actionable scoring and segmentation for beer/wine/liquor distributors, POS vendors, and related service providers. [barmart](https://barmart.net/reportwelcomepage.html)

The agent should extend an existing Next.js/TypeScript app that already ingests:  
- TABC issued licenses (Socrata). [catalog-beta.data](https://catalog-beta.data.gov/?q=tabc)
- TABC pending applications (Socrata). [catalog-beta.data](https://catalog-beta.data.gov/?q=tabc)
- Mixed Beverage Gross Receipts (Comptroller / Texas Open Data). [data.texas](https://data.texas.gov/dataset/Mixed-Beverage-Gross-Receipts/naix-2893)
- Google Places (Text Search + Details).  
- Google Geocoding.  
- Austin and Dallas health inspections.  

The work here is primarily **new data sources, enrichment jobs, and a richer schema**, not a ground‑up rewrite.

***

## 2. Core Data Model Changes

### 2.1 Entities

Add/extend the following core entities in the database:

#### `Location`

Represents a physical venue (single address). Some fields exist already; augment as needed.

Required fields:

- `id` (UUID) – internal location ID.  
- `address_line1`, `address_line2`, `city`, `county`, `state`, `zip`, `country`.  
- `lat`, `lng`.  
- `place_id` (nullable) – Google Place ID if resolved.  
- `primary_trade_name` – current DBA for this location.  
- `legal_entity_name` – joined from TABC / legal notice / SOS; may differ from DBA. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2020-08/public-roster-record-layout.pdf)
- `stage` – enum: `pre_notice`, `newspaper_notice`, `tabc_pending`, `tabc_licensed`, `inactive`. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- `first_seen_at` – earliest timestamp from any source (notice, TABC pending, etc.).  
- `opened_at` (nullable) – inferred open date (first TABC issued date or first receipts date). [data.texas](https://data.texas.gov/dataset/Mixed-Beverage-Gross-Receipts/naix-2893)
- `closed_at` (nullable).  
- `concept_tags` – array of short tags like `["full_service", "bar", "nightclub", "brewpub"]`. [data.texas](https://data.texas.gov/stories/s/Mixed-Beverage-Gross-Receipts-Intro-Page/tj7s-7tc8/)
- `google_categories` – raw Google Places categories (string[]).  
- `hours_json` – JSON blob of opening hours from Google Places if available.  
- `viability_score` – float 0–1 (see Section 4).  
- `created_at`, `updated_at`.

#### `License`

Represents a TABC license record tied to a `Location`.

- `id` (UUID).  
- `location_id` (FK → `Location`).  
- `tabc_license_number`. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2020-08/public-roster-record-layout.pdf)
- `license_type_code` and `license_type_desc`. [data.texas](https://data.texas.gov/stories/s/Mixed-Beverage-Gross-Receipts-Intro-Page/tj7s-7tc8/)
- `tier` (retail, distribution, manufacturing, other) from TABC fields. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2020-08/public-roster-record-layout.pdf)
- `status` – Active, Pending, Inactive, etc. [tabc.texas](https://www.tabc.texas.gov/public-information/tabc-public-inquiry/)
- `original_issue_date`, `current_issue_date`, `expiry_date`. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2020-08/public-roster-record-layout.pdf)
- `pending_renewal` (boolean). [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2020-08/public-roster-record-layout.pdf)
- `source_row_json` – raw Socrata row for debugging. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2020-08/public-roster-record-layout.pdf)
- `created_at`, `updated_at`.

#### `LegalNotice`

Represents a TABC newspaper legal notice (Hearst/iPublish, etc.). [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)

- `id` (UUID).  
- `location_id` (nullable initially; filled when matched).  
- `publisher` – e.g., `"Hearst Austin"` or site name. [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
- `notice_url`. [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
- `notice_text_raw` – entire raw text. [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
- `legal_entity_name`. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- `trade_name`. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- `address_line1`, `address_line2`, `city`, `county`, `state`, `zip`. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- `permit_type_full_text` – “Mixed Beverage Permit”, etc. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- `notice_date` – publication date. [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
- `principals` – JSON array of `{ name, title }` parsed from the officer/partner section. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- `parsed_successfully` – boolean.  
- `matched_location_confidence` – float 0–1 when linked to `Location`.  
- `created_at`, `updated_at`.

#### `Principal`

Normalized person that can be associated with multiple locations/entities.

- `id` (UUID).  
- `full_name`.  
- `normalized_name_key` – for matching (e.g., lowercased, stripped).  
- `source_type` – `legal_notice`, `sos`, `comptroller`, `enrichment_api`, etc. [mycpa.cpa.state.tx](https://mycpa.cpa.state.tx.us/atr/help.html)
- `raw_source_json`.  
- `created_at`, `updated_at`.

#### `PrincipalRoleAtLocation`

Join table between `Principal` and `Location`.

- `id` (UUID).  
- `principal_id` (FK).  
- `location_id` (FK).  
- `role` – free text like “Managing Member”, “Owner”, “GM”, “Partner”. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- `from_source` – e.g., `tabc_newspaper_notice`, `sos_officer_record`, `contact_api`. [mycpa.cpa.state.tx](https://mycpa.cpa.state.tx.us/atr/help.html)
- `confidence` – float 0–1.  
- `created_at`, `updated_at`.

#### `Contact`

Represents actual contact methods.

- `id` (UUID).  
- `principal_id` (nullable).  
- `location_id` (nullable, for generic venue email/phone).  
- `type` – `email` | `phone`.  
- `value`.  
- `source` – `google_places`, `website_scrape`, `contact_api_vendor_name`, etc. [limeleads](https://www.limeleads.com/restaurants/)
- `verified` – boolean.  
- `verification_method` – `vendor_verified`, `pattern_inferred`, `google_places`, etc. [salesgenie](https://www.salesgenie.com/leads/food-and-restaurant-leads/)
- `confidence` – float 0–1.  
- `created_at`, `updated_at`.

#### `RevenueSummary`

Aggregated mixed‑beverage receipts by location and period. [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)

- `id` (UUID).  
- `location_id` (FK).  
- `taxpayer_number`. [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)
- `period_start`, `period_end` (date). [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)
- `liquor_receipts`, `wine_receipts`, `beer_receipts`, `cover_charge_receipts`, `total_receipts`. [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)
- `trailing_3m_total`, `trailing_6m_total`, `trailing_12m_total` (denormalized).  
- `growth_3m_vs_prev_3m`, `growth_12m_vs_prev_12m` (floats).  
- `rank_within_zip`, `rank_within_city`, `rank_within_county` (ints, nullable).  
- `created_at`, `updated_at`.

#### `LeadScore`

Scores per location for specific customer personas.

- `id` (UUID).  
- `location_id` (FK).  
- `score_for_distributor` – float 0–1.  
- `score_for_pos` – float 0–1.  
- `score_last_updated_at`.  
- `tags` – JSON array like `["new_30d", "high_volume", "pre_opening", "late_night_cluster"]`. [barmart](https://barmart.net/reportwelcomepage.html)
- `created_at`, `updated_at`.

***

## 3. New Ingestion and Enrichment Pipelines

### 3.1 Legal Notices Ingestion (Hearst / iPublish)

Create a new scheduled job, e.g., `jobs/ingestLegalNotices.ts`.

Requirements:

- Crawl iPublish legal notices pages that contain TABC license application notices for at least Austin initially (parameterize city). [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
- For each listing page:
  - Follow pagination. [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
  - For each notice, load detail page and extract:
    - Raw text of notice. [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
    - Legal entity name. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
    - Trade name (DBA). [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
    - Full address (including suite/building). [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
    - County. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
    - License/permit type full text. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
    - List of officers/partners with names and titles. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
    - Publication date. [hearst-mp.ipublishmarketplace](https://hearst-mp.ipublishmarketplace.com/marketplace/austin/advert/-Notices_501)
- Normalize extracted data and upsert into the `LegalNotice` table keyed by `(notice_url)`.

Parsing:

- Implement robust regex/NER‑style parsing to detect: entity name, DBA, address, county, permit type, and officer block based on the sample language required by TABC. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
- Store parsing confidence and raw text for manual inspection.

Scheduling:

- Run daily or more often, with idempotent upsert behavior.

### 3.2 Location Matching and Creation

Create a job, e.g., `jobs/matchLegalNoticesToLocations.ts`.

Logic:

- For any `LegalNotice` with `location_id IS NULL`:
  1. Geocode the notice address via Google Geocoding; store lat/lng.  
  2. Attempt to find an existing `Location` within a small distance (e.g., 50 meters) and same city/county and similar trade name.  
  3. If found, link `location_id` and update `stage` to at least `newspaper_notice` if not further along.  
  4. If not found, create a new `Location` with:
     - `stage = "newspaper_notice"`.  
     - `first_seen_at = notice_date`. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
     - `primary_trade_name` and `legal_entity_name` from notice. [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)
  5. Compute `matched_location_confidence` (simple heuristic using distance + string similarity on DBA and address).

### 3.3 Principal Extraction and Linking

Create a job, e.g., `jobs/enrichPrincipalsFromNotices.ts`.

- For each `LegalNotice` with parsed `principals`:
  - For each `{ name, title }`:
    - Normalize name into `normalized_name_key`.  
    - Upsert `Principal` record using `normalized_name_key` and optionally `legal_entity_name` as context.  
    - Create or update `PrincipalRoleAtLocation` for the linked `Location` with `role = title`, `from_source = "tabc_newspaper_notice"`, and high initial confidence (e.g., 0.9). [tabc.texas](https://www.tabc.texas.gov/static/sites/default/files/2021-02/tabc-newspaper-publication-example-form.pdf)

Later, extend this with SOS/Comptroller officer data as additional `from_source` types.

### 3.4 Property / CAD Layer (Viability Check)

Design a placeholder job, e.g., `jobs/enrichPropertyData.ts`. (The AI agent should leave integration points for county‑specific APIs or CSV sources; exact endpoints are county‑dependent.)

Goals:

- Given `Location.lat/lng` or address, match to parcel in county appraisal district (CAD) data.  
- Pull and store minimal fields (can be in a `property_json` column on `Location` or a new `Property` table):
  - Land use code / category.  
  - Presence and size of building improvements.  
  - Year built, property class.  
- Compute `viability_score` (0–1), where:
  - High when there is an existing commercial building and the CAD use suggests retail/restaurant.  
  - Low when land is vacant or purely residential.

If CAD integration is not yet implemented, the AI agent should structure the code to allow plugging in a CAD client later and mark records as `viability_score = null` until filled.

### 3.5 Mixed Beverage Revenue Aggregation

Create a job, e.g., `jobs/enrichRevenueSummaries.ts`, built on top of the existing mixed beverage ingestion.

Requirements:

- Use the Mixed Beverage Gross Receipts dataset fields such as `taxpayer_number`, `obligation_end_date_yyyymmdd`, `liquor_receipts`, `wine_receipts`, `beer_receipts`, `cover_charge_receipts`, `total_receipts`. [data.texas](https://data.texas.gov/dataset/Mixed-Beverage-Gross-Receipts/naix-2893)
- Join each record to a `Location` via existing mapping (taxpayer number + address).  
- For each `location_id`, compute:
  - Monthly totals. [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)
  - Trailing 3‑/6‑/12‑month totals. [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)
  - Growth rates vs previous periods.  
- Calculate ranking within each ZIP, city, county by `total_receipts` for the latest available period. [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)
- Upsert into `RevenueSummary`.

### 3.6 Concept Tagging

Create a job, e.g., `jobs/tagLocationConcept.ts`.

Inputs:

- TABC license type (beer‑only vs mixed beverage, private club, etc.). [data.texas](https://data.texas.gov/stories/s/Mixed-Beverage-Gross-Receipts-Intro-Page/tj7s-7tc8/)
- Mixed beverage receipts presence/intensity. [data.texas](https://data.texas.gov/dataset/Mixed-Beverage-Gross-Receipts/naix-2893)
- Google Places categories and maybe hours.

Logic examples:

- If Google category includes “Bar” or “Night club” and license is mixed beverage → tag `["bar", "nightclub?"]`.  
- If receipts are high in beer vs liquor and category suggests “brewery” → tag `["brewpub", "brewery"]`.  
- If category includes “Restaurant” and closes early → tag `["full_service"]`.

Store tags in `concept_tags` on `Location`.

### 3.7 Contact Enrichment Microservice

Create an internal service and background job, e.g., `services/contactEnrichment.ts` and `jobs/runContactEnrichment.ts`.

Inputs per location:

- `Location` record, including `legal_entity_name`, `primary_trade_name`, `city`, `website` (from Google Places), plus any known `Principal` names.

Process:

1. **Google Places details (already in app)**  
   - Ensure location phone and website are captured as `Contact` records with `source = "google_places"`.  

2. **External contact APIs (abstracted)**  
   - Define an interface like:  
     - `fetchContactsForBusiness({ legal_entity_name, trade_name, city, domain }): EnrichedContact[]`.  
   - Implementation details (API keys, specific vendors like Clearbit, Apollo, etc.) should be left abstract / configurable.  
   - Results should map into `Principal` (by name) and `Contact` records, with `source` set to the vendor name and `confidence` from the vendor if available. [limeleads](https://www.limeleads.com/restaurants/)

3. **Pattern‑based inference**  
   - If at least one verified email with a clear pattern (`first.last@domain`, etc.) exists for a domain, infer candidate emails for other principals with the same pattern.  
   - Store inferred contacts with `verified = false` and lower confidence.

Scheduling:

- Run enrichment asynchronously, with rate limiting and retry logic.  
- Avoid calling external APIs repeatedly for the same `Location` if last run is recent and there are no changes.

***

## 4. Scoring Logic

Implement a scoring module, e.g., `services/leadScoring.ts`, and a job, `jobs/updateLeadScores.ts`.

### 4.1 Viability Score (`Location.viability_score`)

Inputs:

- CAD property data (when available).  
- Google Places presence (has Place ID?).  
- Street‑view/imagery heuristics (optional future hook).  

Suggested rules (configurable):

- Base score from CAD:  
  - Vacant land → 0.1.  
  - Commercial building with restaurant‑like category → 0.8+.  
- Add bump if Google Place exists and category is restaurant/bar.  
- Clip between 0 and 1.

### 4.2 Persona‑specific Lead Scores

For each `Location`, compute:

- `score_for_distributor` based on:
  - Stage: pre‑opening (`newspaper_notice` or `tabc_pending`) gets a bump. [catalog-beta.data](https://catalog-beta.data.gov/?q=tabc)
  - Presence and growth of mixed beverage receipts: higher + growing → higher score. [barmart](https://barmart.net/reportwelcomepage.html)
  - Concept tags: bars/nightclubs prioritized over low‑alcohol concepts.  
  - Density: adjust for venue clustering (new venue in under‑served area may be extra interesting).  

- `score_for_pos` based on:
  - Stage: pre‑opening and first few months after opening get highest weight. [data.texas](https://data.texas.gov/dataset/Mixed-Beverage-Gross-Receipts/naix-2893)
  - Viability_score (must be high enough to matter).  
  - Existence of at least one principal with a contact method (email or phone).  

Persist these scores in the `LeadScore` table and update periodically.

***

## 5. API and Webhook Changes

### 5.1 Lead Object Shape

Expose a unified `Lead` object via your existing API/webhooks to enterprise customers.

Suggested JSON shape:

```json
{
  "locationId": "uuid",
  "tradeName": "Archive Bar",
  "legalEntityName": "Archive Bar LLC",
  "address": {
    "line1": "617 Congress Ave",
    "line2": "Suite 100",
    "city": "Austin",
    "county": "Travis",
    "state": "TX",
    "zip": "78701",
    "lat": 30.2672,
    "lng": -97.7431
  },
  "stage": "tabc_pending",
  "viabilityScore": 0.92,
  "conceptTags": ["bar", "nightclub"],
  "licenses": [
    {
      "tabcLicenseNumber": "MB123456",
      "licenseTypeCode": "MB",
      "licenseTypeDesc": "Mixed Beverage Permit",
      "status": "Pending",
      "originalIssueDate": null,
      "expiryDate": null
    }
  ],
  "revenue": {
    "trailing3mTotal": 125000,
    "trailing12mTotal": 480000,
    "growth3mVsPrev3m": 0.18,
    "growth12mVsPrev12m": 0.27,
    "rankWithinZip": 4,
    "rankWithinCity": 37
  },
  "principals": [
    {
      "name": "Jane Doe",
      "roles": ["Managing Member"],
      "contacts": [
        {
          "type": "email",
          "value": "jane@archivebar.com",
          "source": "contact_api_vendor",
          "verified": true,
          "confidence": 0.96
        },
        {
          "type": "phone",
          "value": "+1-512-555-0100",
          "source": "google_places",
          "verified": false,
          "confidence": 0.7
        }
      ]
    }
  ],
  "leadScores": {
    "distributor": 0.88,
    "pos": 0.95,
    "tags": ["new_30d", "high_volume_zip", "pre_opening"]
  },
  "sourceTimestamps": {
    "firstSeenAt": "2026-03-01T00:00:00Z",
    "noticeDate": "2026-02-20T00:00:00Z",
    "tabcPendingSince": "2026-02-25T00:00:00Z",
    "firstReceiptsDate": "2026-04-20T00:00:00Z"
  }
}
```

### 5.2 Filters Important for Customers

Ensure API/query layer supports filtering by:

- Geography: radius, city, county, ZIP.  
- Stage: `newspaper_notice`, `tabc_pending`, `tabc_licensed`. [catalog-beta.data](https://catalog-beta.data.gov/?q=tabc)
- Recency: first seen in last X days.  
- Concept tags (e.g., bars only).  
- Revenue thresholds and growth (e.g., top 10% in city). [data.sugarlandtx](https://data.sugarlandtx.gov/dataset/mixed-beverage-gross-receipts/resource/fe6d0525-e6a0-498f-926f-3a0ab9b44a09?view_id=b7e99111-0bcd-45aa-ab33-791ce7ca0115)
- Lead scores and tags (e.g., `pre_opening` only).  

Webhooks should send this `Lead` object (or a subset) on:

- New `Location` entering `newspaper_notice` or `tabc_pending`. [catalog-beta.data](https://catalog-beta.data.gov/?q=tabc)
- Stage changes (pending → licensed, licensed → inactive). [tabc.texas](https://www.tabc.texas.gov/public-information/tabc-public-inquiry/)
- Significant revenue or score changes (e.g., big growth or drop).

***

## 6. Implementation Constraints and Notes

- Respect external data source terms and rate limits; make external data clients pluggable/configurable, not hard‑coded. [tabc.texas](https://www.tabc.texas.gov/public-information/tabc-public-inquiry/)
- All new jobs should be idempotent and safe to rerun.  
- Use background jobs/queues for heavy tasks (scraping, enrichment API calls, scoring).  
- Provide logging around parsing failures for legal notices and enrichment API errors.

***

This spec is intended to be self‑contained so an AI agent can:  
- Extend the schema.  
- Implement new ingestion pipelines.  
- Add enrichment, scoring, and API responses without needing more business context.