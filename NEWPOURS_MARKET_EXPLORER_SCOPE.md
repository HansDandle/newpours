# NewPours Market Explorer Scope

## Goal

Add a second major product surface outside the alert feed: a searchable, sortable venue intelligence workspace where users can discover, compare, segment, and export establishments using license, revenue, inspection, permit, and Google Places data.

The alert feed answers:
- What changed today?

The Market Explorer should answer:
- Which venues are worth contacting?
- Which ZIP codes or corridors are strongest?
- Which operators are under-served, growing, risky, or newly active?
- Which establishments should I save, export, or revisit later?

## Why This Matters

The current dashboard is optimized for chronology and recent filings. That is useful for alerts, but it is not the right surface for:
- territory building
- revenue-first prospecting
- venue comparison
- saved targeting workflows
- ranking venues inside a ZIP, city, county, or license segment

Users already have enough data to ask questions like:
- show me the highest-revenue venues in 78704
- show me pending renewals in Travis County with strong receipts
- show me venues with high revenue and weak web presence
- show me operators with recent permit activity and good sales volume

## Current Inputs Available

Based on the existing schema and codebase, the explorer can already build on:
- TABC license and application data
- establishment classification: truly new / pending new / renewal / transfer-or-change / unknown
- Comptroller monthly receipts
- Google Places rating, reviews, website, price level
- health inspection history and latest score
- building permit signals
- enrichment status by source

Key references:
- [types/index.ts](types/index.ts)
- [app/(dashboard)/dashboard/page.tsx](app/(dashboard)/dashboard/page.tsx)
- [app/admin/establishments/[id]/page.tsx](app/admin/establishments/[id]/page.tsx)
- [additional_spec.md](additional_spec.md)

## Product Principles

1. Start with commercial usefulness, not visual complexity.
2. Prioritize segmentation, sorting, and export before maps or fancy analytics.
3. Treat establishments as the core unit, not individual alert rows.
4. Roll up sibling/pending/active license records where possible.
5. Make the first version fast and legible for prospecting workflows.

## Highest-Impact Scope First

### Phase 1: Market Explorer MVP

This is the first build target.

#### Core jobs to support

Users should be able to:
- sort establishments by latest month revenue
- filter by ZIP, county, city, license type, status, and classification
- search by venue name, owner, address, license number
- filter by enrichment availability
- export the current result set
- open a richer detail view for one establishment

#### Primary table columns

- business / trade name
- owner / applicant
- city
- county
- ZIP
- license type
- status
- classification
- latest month revenue
- revenue month
- Google rating
- Google review count
- latest health score
- permit activity flag
- comptroller / Google / inspection enrichment status

#### MVP filters

- ZIP code
- county
- city
- license type
- status
- classification
- latest revenue min / max
- Google rating min / max
- review count min
- health score min / max
- has website yes / no
- permit activity yes / no
- enrichment completeness

#### MVP actions

- save current view
- export CSV
- open establishment detail
- copy list / shareable filtered URL

#### Why this is first

This delivers immediate sales utility with the least amount of new infrastructure. Users can already answer high-value targeting questions without waiting for scoring, maps, or workflow tooling.

### Phase 2: Saved Views and Prospect Lists

After the explorer table is stable, add reusable workflow primitives.

Users should be able to:
- save named views like "Top Austin MB venues by revenue"
- pin favorite segments
- create prospect lists from filtered results
- add notes / tags to establishments
- mark targets as hidden, contacted, qualified, or won

#### Why this is second

Once users can find valuable venues, the next need is retaining and operationalizing those findings.

### Phase 3: Account / Venue Rollup

This should unify sibling license records into a cleaner venue-level representation.

Problems it solves:
- multiple docs for the same establishment
- pending app vs active license duplication
- enrichment written to one sibling but not obvious on another

Deliverables:
- canonical venue rollup record
- linked license list per venue
- aggregated enrichment view
- revenue shown at the venue level regardless of which sibling record matched

#### Why this matters

This reduces confusion and improves trust in the explorer. The recent South Austin Beer Garden and Shoal Creek Saloon issues are direct evidence that venue-level rollup should become a product and data priority.

## High-Value Future Improvements

These are strong candidates after the MVP stack is working well.

### Opportunity Presets

One-click saved lenses such as:
- top revenue in this ZIP
- pending renewals worth calling
- high revenue, weak ratings
- high revenue, no website
- recent permit activity plus strong revenue
- new filings near strong incumbents

### Compare View

Allow users to compare one venue against:
- ZIP median revenue
- county peers
- same license-type peers
- percentile ranking in market

### Map View

Map and cluster venues by:
- revenue band
- license status
- pending vs active
- recent permit or inspection activity

### Scoring Layer

Derived scores, for example:
- opportunity score
- under-optimized score
- growth / momentum score
- risk score

### Trigger-Based Monitoring Beyond Alerts

Alert users when:
- revenue crosses threshold
- health score declines
- permit activity appears
- a venue moves from pending to licensed

## Suggested Data / Model Improvements

These are not necessarily UI features, but they will improve the product.

### 1. Canonical Venue Entity

Create or formalize a venue-level rollup model separate from raw license docs.

Recommended outputs:
- canonical venue ID
- linked license IDs
- canonical business name
- canonical address
- rolled-up enrichment summary
- rolled-up monthly revenue

### 2. Materialized Explorer Fields

To keep explorer queries simple and fast, consider materializing fields such as:
- latestMonthRevenue
- avgMonthlyRevenue
- revenueTrend
- latestHealthScore
- hasWebsite
- hasRecentPermitActivity
- opportunity flags

### 3. Data Shape Normalization

Ensure all enrichment fields are stored consistently as nested objects, not mixed flat dotted keys and nested objects.

### 4. Explorer-Friendly Indexes

As filtering expands, add Firestore indexes for common combinations:
- county + latestMonthRevenue
- ZIP + latestMonthRevenue
- classification + status
- enrichment completeness + county
- revenue band + health score

## Recommended MVP UX Structure

### New route

Suggested route:
- `app/(dashboard)/explorer/page.tsx`

### Layout

- top bar: search + saved views + export
- filter rail or sticky filter tray
- table as the default primary view
- right-side detail panel or drill-in page

### Table behavior

- multi-column sorting
- sticky headers
- pagination or virtualized rows
- quick filter chips
- column visibility controls

## User Stories

### Distributor / supplier rep

As a supplier rep, I want to sort venues in a ZIP by revenue and export the top accounts so I can build a call list.

### POS or service vendor

As a vendor, I want to find high-revenue venues with weak ratings or no website so I can identify under-served operators.

### Territory manager

As a territory manager, I want to save views by county and license type so I can revisit the same opportunity pools weekly.

### Analyst / operator

As an analyst, I want to compare venues against their local market so I can prioritize who matters most.

## Success Metrics

The Market Explorer should be considered successful when users can do these things quickly:
- find top venues in a ZIP or county in under 30 seconds
- export a filtered prospect list without using the alert feed
- reopen saved targeting views in one click
- understand why a venue is included based on visible metrics

Product metrics to track later:
- saved views per user
- exports from explorer vs alert feed
- searches per session
- filter usage frequency
- establishment detail opens from explorer

## Out of Scope for MVP

These should not block the first release:
- full CRM pipeline
- rep assignment / team collaboration
- complex map analytics
- automated scoring models with many weights
- cross-state expansion
- polished BI-style charting suite

## Proposed Delivery Order

1. Market Explorer table with filters, sorting, and CSV export
2. Saved views
3. Venue detail improvements
4. Canonical venue rollup
5. Opportunity presets
6. Compare view
7. Map view
8. Scoring and trigger-based intelligence

## Open Questions

Before implementation, answer these:
- Should explorer be available only to Pro / Enterprise users?
- Should revenue sorting/filtering be a premium-only feature?
- Is the primary unit a raw establishment doc or a rolled-up venue entity?
- Should saved views be user-private only, or shareable across a team later?
- Should lists and notes be part of MVP or phase 2?

## Recommendation

Start with the smallest high-value thing:

Build a `Market Explorer` route that gives users a sortable venue table with revenue, Google, inspection, and permit signals plus saved views and export.

That is the highest-impact next product surface because it turns NewPours from an alerting product into a usable prospecting and territory-planning tool.