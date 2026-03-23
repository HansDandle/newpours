# New Pours — Admin Panel Spec

> **For the AI agent:** This document defines the internal admin panel — a separate, auth-gated section of the app accessible only to users with `role: 'admin'` on their Firestore user doc. Do not expose any admin routes to regular subscribers. Build this after the core dashboard is functional.

---

## 1. Overview

The admin panel gives the product owner (Hans) full operational visibility and control over the New Pours platform — without needing to live in the Firebase console. It covers four domains: data health, user & subscription management, enrichment review queues, and system job monitoring.

**Route prefix:** `/admin/*` — server-side protected by middleware that checks Firebase Auth + `role: 'admin'` claim. Return 404 (not 403) for non-admin users to avoid revealing the route exists.

**Access:** Admin role is set manually via Firebase Admin SDK or directly in Firestore. The agent should create a one-time CLI script `scripts/make-admin.ts` that sets `role: 'admin'` on a given uid.

---

## 2. Admin Navigation

Sidebar with the following sections:

```
├── Overview          ← system health at a glance
├── Establishments    ← browse, search, manually re-enrich
├── Review Queues
│   ├── Unmatched Comptroller Records
│   └── Duplicate Flags
├── Users & Billing   ← subscriber management
├── Job Monitor       ← ingest/enrichment run history
└── Logs              ← enrichment error log
```

---

## 3. Page Specs

---

### 3.1 Overview `/admin`

A status dashboard showing system health at a glance. Auto-refreshes every 60 seconds.

**Stats cards (top row):**
- Total establishments in database
- Enrichment complete % (establishments where all 4 sources are `complete` or `no_match`)
- Unmatched Comptroller records (count from `comptroller_unmatched` collection)
- Duplicate flags pending review (count of `duplicateFlag: true` establishment docs)
- Active subscribers (count of users where `planStatus: 'active'`)
- MRR estimate (sum of plan prices × active subscriber counts — hardcoded price map)

**Last job runs (table):**
| Job | Last Run | Status | Records Processed | Duration |
|---|---|---|---|---|
| TABC Ingest | 2 hours ago | ✅ Success | 847 | 12s |
| Comptroller Update | 3 days ago | ✅ Success | 61,204 | 4m 32s |
| Google Places Refresh | 12 days ago | ✅ Success | 892 | 8m 14s |
| Health Inspections | 1 hour ago | ⚠️ Partial | 1,204 / 1,890 | 3m 01s |
| Building Permits | 1 hour ago | ✅ Success | 342 | 44s |

Pull this data from the `system/jobRuns/{runId}` Firestore collection (see Section 5).

**Backfill status banner:**
Show a prominent banner if `system/backfill.tabc_complete` or `system/backfill.comptroller_complete` is false, with a note to run the backfill script.

---

### 3.2 Establishments `/admin/establishments`

Full searchable, filterable table of all establishment records.

**Search:** Full-text search on business name, DBA name, address, license number (client-side filter on paginated Firestore results is fine at this scale).

**Filters:**
- County (multi-select)
- License type (multi-select)
- Enrichment status per source (complete / pending / error / no_match)
- Has comptroller data (yes/no)
- Duplicate flagged (yes/no)

**Table columns:**
| Column | Notes |
|---|---|
| Business name | Link to detail view |
| License # | Monospace |
| County | Badge |
| License type | Badge |
| Status | Active / Pending / Expired |
| Comptroller data | ✅ / ⚠️ / ❌ |
| Google Places | ✅ / ⚠️ / ❌ |
| Health inspection | ✅ / ⚠️ / ❌ / N/A |
| Building permits | ✅ / ⚠️ / ❌ / N/A |
| First seen | Date |

**Establishment Detail View `/admin/establishments/{id}`:**

Full record dump with all raw fields visible. Sections:

- **TABC data** — all raw fields from ingestion
- **Comptroller data** — revenue table (all months), trend chart (sparkline)
- **Google Places** — rating, review count, hours, match confidence score
- **Health inspections** — inspection history table
- **Building permits** — permit history table
- **Enrichment status** — all 4 sources with status, confidence score, matchMethod, matchedAt
- **Raw Firestore doc** — collapsible JSON dump of the full document for debugging

**Actions available on detail view:**
- **Re-enrich: Google Places** — triggers `enrichNewEstablishment` for this record, replaces existing data if confidence improves
- **Re-enrich: All sources** — queues all enrichment jobs for this record
- **Clear duplicate flag** — sets `duplicateFlag: false`, removes from review queue
- **Mark as reviewed** — adds `adminReviewed: true, adminReviewedAt: Timestamp` to doc
- **Link related license** — manually set `relatedLicenses[]` field

---

### 3.3 Review Queue — Unmatched Comptroller Records `/admin/queues/unmatched`

Shows all records in `comptroller_unmatched` collection that couldn't be automatically matched to a TABC establishment.

**Table columns:**
| Column | Notes |
|---|---|
| Taxpayer name | |
| Location name (DBA) | |
| Address | |
| City | |
| Taxpayer # | |
| Location # | |
| Latest month revenue | |
| Action | |

**Actions per row:**
- **Search establishments** — opens a modal with a search box to find the correct establishment doc; on confirm, writes the Comptroller data to that establishment and deletes from `comptroller_unmatched`
- **Dismiss** — marks as `dismissed: true` with a reason dropdown (e.g. "out of scope license type", "closed establishment", "data error")

**Bulk action:** Dismiss all selected with reason.

---

### 3.4 Review Queue — Duplicate Flags `/admin/queues/duplicates`

Shows all establishment docs where `duplicateFlag: true`, meaning two TABC records matched the same Google Places `placeId`.

**For each flagged pair, show side by side:**
- License numbers
- Business names
- Addresses
- License types and statuses
- First seen dates

**Actions:**
- **Keep both** — clears the flag on both records, adds a `duplicateReviewed: true` note
- **Mark as related** — sets `relatedLicenses` on both docs, clears flag
- **Archive one** — sets `archived: true` on the lesser record (e.g. expired license superseded by new one)

---

### 3.5 Users & Billing `/admin/users`

Searchable table of all registered users.

**Table columns:**
| Column | Notes |
|---|---|
| Email | |
| Name | |
| Plan | Badge (free / basic / pro / enterprise) |
| Plan status | active / past_due / canceled |
| Joined | Date |
| Last active | Pull from Firebase Auth last sign-in |
| MRR contribution | Based on plan |
| Actions | |

**Actions per row:**
- **View in Stripe** — deep link to Stripe customer page
- **Override plan** — manually set plan tier in Firestore (for comped accounts, pilots, etc.) — requires confirmation modal
- **Reset API key** — regenerate the user's API key
- **Send password reset** — trigger Firebase Auth password reset email
- **Disable account** — sets Firebase Auth `disabled: true`

**User detail view `/admin/users/{uid}`:**
- All user doc fields
- Subscription history (from Stripe webhook logs stored in Firestore)
- Alert history (last 30 alerts delivered)
- Export history
- API usage last 30 days (reads from rate limit counter doc)

---

### 3.6 Job Monitor `/admin/jobs`

Full history of all enrichment and ingest job runs, pulled from `system/jobRuns` collection.

**Table columns:**
| Column | Notes |
|---|---|
| Job name | |
| Started at | |
| Completed at | |
| Duration | |
| Status | success / partial / error |
| Records processed | |
| Records failed | |
| Notes | Error summary if applicable |

**Actions:**
- **View full log** — opens a modal with the full per-record log for that run
- **Re-trigger job** — calls an admin-only HTTP Cloud Function endpoint to manually kick off any scheduled job on demand

**Manual trigger buttons (top of page):**
Buttons to manually trigger each job without waiting for its schedule:
- Run TABC Ingest Now
- Run Comptroller Update Now
- Run Google Places Refresh Now
- Run Health Inspections Now
- Run Building Permits Now

Each button shows a confirmation modal, then calls the corresponding admin HTTP trigger endpoint and shows a toast when the job is queued.

---

### 3.7 Logs `/admin/logs`

Enrichment error and skip log, pulled from `system/enrichmentLogs` collection.

**Filters:**
- Source (Google Places / Comptroller / Health / Permits)
- Status (error / skip / success)
- Date range

**Table columns:**
| Column | Notes |
|---|---|
| Timestamp | |
| Establishment ID | Link to detail view |
| Source | |
| Status | error / skip / success |
| Confidence score | If applicable |
| Message | Error message or skip reason |

**Retention:** Keep enrichment logs for 90 days, then auto-delete via a monthly Cloud Function cleanup job.

---

## 4. Firestore Collections for Admin Data

### `system/jobRuns/{runId}`
```ts
{
  jobName: string,              // e.g. 'tabc_ingest' | 'comptroller_update' | 'google_places_refresh'
  startedAt: Timestamp,
  completedAt: Timestamp,
  durationMs: number,
  status: 'success' | 'partial' | 'error',
  recordsProcessed: number,
  recordsFailed: number,
  notes: string,               // Summary of errors if partial/error
}
```

### `system/enrichmentLogs/{logId}`
```ts
{
  timestamp: Timestamp,
  establishmentId: string,
  source: 'googlePlaces' | 'comptroller' | 'healthInspection' | 'buildingPermits',
  status: 'success' | 'skip' | 'error',
  confidence?: number,
  matchMethod?: string,
  message: string,
}
```

### `system/backfill`
```ts
{
  tabc_complete: boolean,
  tabc_count: number,
  tabc_completedAt: Timestamp,
  comptroller_complete: boolean,
  comptroller_months_processed: number,
  comptroller_records_matched: number,
  comptroller_records_unmatched: number,
  comptroller_completedAt: Timestamp,
}
```

---

## 5. Admin-Only Cloud Function Endpoints

These are HTTP-triggered Cloud Functions callable only with a valid admin Firebase Auth token. The frontend sends the user's ID token in the `Authorization: Bearer {token}` header; the function verifies it and checks for `role: 'admin'` custom claim before executing.

```
POST /adminTrigger/tabc_ingest
POST /adminTrigger/comptroller_update
POST /adminTrigger/google_places_refresh
POST /adminTrigger/health_inspections
POST /adminTrigger/building_permits
POST /adminTrigger/enrich_single?id={establishmentId}&source={source}
```

Each endpoint queues the corresponding Cloud Task and returns `{ queued: true, jobId: string }` immediately — it does not wait for completion.

---

## 6. Firestore Security Rules for Admin Routes

```
// Admin-only collections
match /system/{document=**} {
  allow read, write: if request.auth.token.role == 'admin';
}

match /comptroller_unmatched/{document=**} {
  allow read, write: if request.auth.token.role == 'admin';
}
```

The `role: 'admin'` custom claim must be set via the Firebase Admin SDK (not Firestore) so it's included in the Auth token and readable in security rules.

The `scripts/make-admin.ts` script:
```ts
// Usage: npx ts-node scripts/make-admin.ts <uid>
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const uid = process.argv[2];
await getAuth().setCustomUserClaims(uid, { role: 'admin' });
console.log(`Admin role set for ${uid}. User must sign out and back in for claim to take effect.`);
```

---

## 7. Design Notes

- The admin panel should be visually distinct from the subscriber dashboard — use a muted, utilitarian aesthetic (dense tables, no marketing copy, data-forward)
- Use shadcn/ui `<Table>`, `<Badge>`, `<Dialog>`, and `<Toast>` components throughout for consistency
- All destructive actions (disable account, archive record, dismiss queue items) require a confirmation modal with the action clearly stated
- All admin actions should write an audit log entry to `system/adminAuditLog/{logId}` with: `adminUid`, `action`, `targetId`, `timestamp`, `notes`
- Mobile responsiveness is not a priority for the admin panel — design for desktop only

---

## 8. Build Order

1. Create `scripts/make-admin.ts` and set admin role on your uid
2. Add admin middleware to Next.js — check Firebase token + admin claim, return 404 if not admin
3. Build Firestore security rules for admin collections
4. Build admin HTTP trigger Cloud Functions with auth verification
5. Build Overview page `/admin` — stats cards + job run table
6. Build Establishments table `/admin/establishments` with search and filters
7. Build Establishment detail view `/admin/establishments/{id}` with re-enrich actions
8. Build Unmatched Comptroller queue `/admin/queues/unmatched`
9. Build Duplicate flags queue `/admin/queues/duplicates`
10. Build Users & Billing table `/admin/users`
11. Build Job Monitor `/admin/jobs` with manual trigger buttons
12. Build Logs view `/admin/logs` with filters
13. Wire audit log writes to all destructive actions

---

*Last updated: March 2026 | New Pours admin panel v1*
