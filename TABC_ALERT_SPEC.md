# TABC License Alert SaaS — Agent Build Spec

> **For the AI agent:** This document is your source of truth. Follow it top to bottom. When you reach a section marked `[AGENT: ASK]`, stop and ask the user for the required information before proceeding. Do not assume or fabricate keys, IDs, or config values.

---

## 1. Product Overview

**Product name:** TBD (placeholder: `LicenseAlert`)
**Purpose:** Monitor Texas TABC new license applications daily and deliver structured lead data to paying subscribers (beer/wine distributors, POS vendors, staffing agencies, talent bookers, insurance brokers, etc.)
**Core value prop:** Real-time (daily) alerts of new TABC license filings, enriched with geocoding and business metadata, delivered via dashboard, email digest, CSV export, and webhook.

---

## 2. Tech Stack

### Frontend
- **Framework:** Next.js 14+ (App Router)
- **Styling:** Tailwind CSS
- **Component library:** shadcn/ui
- **Auth UI:** Firebase Auth (Google + Email/Password)
- **Hosting:** Vercel (auto-deploy from GitHub main branch)
- **State management:** Zustand or React Context (keep it simple)

### Backend
- **Auth:** Firebase Authentication
- **Database:** Firestore (NoSQL — collections for users, subscriptions, licenses, alerts)
- **Scheduled jobs:** Cloud Functions for Firebase (scheduled functions via Cloud Scheduler)
- **File storage:** Firebase Storage (for CSV exports)
- **Email:** Resend (transactional email — daily digest, welcome, billing)
- **Payments:** Stripe (subscriptions — Basic / Pro / Enterprise tiers)
- **Enrichment:** Google Maps Geocoding API (lat/lng + place details from address)

### Data Ingestion
- **Primary source:** Texas Open Data Portal — TABC License dataset (Socrata SODA2 API, no auth required for public data)
- **Endpoint:** `https://data.texas.gov/resource/ab7a-aabn.json` (verify current endpoint)
- **Polling cadence:** Daily at 6:00 AM CST via Firebase Scheduled Function
- **Diffing strategy:** Store last-seen `license_number` set in Firestore; compare on each run to identify net-new records
- **Enrichment pipeline:** For each new record → geocode address → classify license type → store enriched doc in Firestore `licenses` collection → trigger alert fanout

---

## 3. Repository Structure

```
/
├── app/                        # Next.js App Router
│   ├── (marketing)/            # Public-facing pages (unauthenticated)
│   │   ├── page.tsx            # Landing page
│   │   ├── pricing/page.tsx
│   │   └── login/page.tsx
│   ├── (dashboard)/            # Auth-protected routes
│   │   ├── dashboard/page.tsx  # Alert feed, filters, map
│   │   ├── account/page.tsx    # Billing, subscription, API key mgmt
│   │   └── exports/page.tsx    # CSV download history
│   └── api/                    # Next.js API routes (thin — most logic in Firebase Functions)
│       ├── webhooks/stripe/route.ts
│       └── export/route.ts
│
├── components/
│   ├── ui/                     # shadcn/ui primitives
│   ├── dashboard/              # Alert feed, filters, map, license card
│   ├── marketing/              # Hero, pricing cards, feature sections
│   └── shared/                 # Navbar, footer, auth guard
│
├── lib/
│   ├── firebase.ts             # Firebase client SDK init
│   ├── firebase-admin.ts       # Firebase Admin SDK (server-side only)
│   ├── stripe.ts               # Stripe client init
│   ├── resend.ts               # Resend email client
│   └── utils.ts                # Shared helpers
│
├── functions/                  # Firebase Cloud Functions (separate deploy)
│   ├── src/
│   │   ├── ingest.ts           # Scheduled: poll TABC SODA2 API daily
│   │   ├── enrich.ts           # Firestore trigger: geocode + classify new license docs
│   │   ├── alertFanout.ts      # Firestore trigger: notify matching subscribers
│   │   ├── emailDigest.ts      # Scheduled: send daily email digests
│   │   └── stripeWebhook.ts    # HTTP: handle Stripe subscription events
│   └── package.json
│
├── types/
│   └── index.ts                # Shared TypeScript types
│
├── .env.local                  # Local dev secrets (never commit)
├── .env.example                # Template for required env vars
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
└── package.json
```

---

## 4. Environment Variables

> **[AGENT: ASK]** Before writing any code that references these values, ask the user to provide each of the following. Present them as a checklist.

```env
# Firebase (client-side — safe to expose in Next.js NEXT_PUBLIC_ vars)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Firebase Admin (server-side only — never expose)
FIREBASE_ADMIN_PROJECT_ID=
FIREBASE_ADMIN_CLIENT_EMAIL=
FIREBASE_ADMIN_PRIVATE_KEY=       # Paste full key including \n characters

# Stripe
STRIPE_SECRET_KEY=                 # sk_live_... or sk_test_...
STRIPE_WEBHOOK_SECRET=             # whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# Stripe Price IDs (create these in Stripe dashboard first)
STRIPE_PRICE_BASIC=                # price_...
STRIPE_PRICE_PRO=                  # price_...
STRIPE_PRICE_ENTERPRISE=           # price_...

# Resend (transactional email)
RESEND_API_KEY=                    # re_...
RESEND_FROM_EMAIL=                 # e.g. alerts@yourdomain.com

# Google Maps (geocoding)
GOOGLE_MAPS_API_KEY=

# App
NEXT_PUBLIC_APP_URL=               # e.g. https://yourdomain.com
```

> **[AGENT: ASK]** Also ask: "What domain will this be hosted on?" — needed for Vercel config and Stripe webhook registration.

---

## 5. Firestore Data Model

### `users/{uid}`
```ts
{
  uid: string
  email: string
  displayName: string
  createdAt: Timestamp
  stripeCustomerId: string
  plan: 'free' | 'basic' | 'pro' | 'enterprise'
  planStatus: 'active' | 'past_due' | 'canceled'
  apiKey: string               // UUID, generated on signup
  webhookUrl?: string          // Enterprise only
  filters: {
    counties: string[]         // e.g. ['Travis', 'Harris'] — empty = all
    licenseTypes: string[]     // e.g. ['MB', 'BQ'] — empty = all
    zipCodes: string[]
  }
  emailDigest: boolean         // opt in/out of daily email
  digestTime: '6am' | '8am' | '12pm'
}
```

### `licenses/{licenseNumber}`
```ts
{
  licenseNumber: string
  businessName: string
  ownerName: string
  address: string
  city: string
  county: string
  zipCode: string
  licenseType: string          // Raw TABC code
  licenseTypeLabel: string     // Human-readable
  status: 'Pending' | 'Active' | 'Expired' | 'Cancelled'
  applicationDate: Timestamp
  effectiveDate?: Timestamp
  expirationDate?: Timestamp
  lat?: number
  lng?: number
  enrichedAt?: Timestamp
  firstSeenAt: Timestamp       // When our system first ingested it
  isNew: boolean               // True for first 7 days
}
```

### `alerts/{alertId}`
```ts
{
  userId: string
  licenseNumber: string
  deliveredAt: Timestamp
  channel: 'email' | 'webhook' | 'dashboard'
}
```

### `exports/{exportId}`
```ts
{
  userId: string
  createdAt: Timestamp
  filters: object
  recordCount: number
  downloadUrl: string          // Firebase Storage signed URL
  expiresAt: Timestamp
}
```

---

## 6. Subscription Tiers & Feature Gates

| Feature | Free | Basic ($49/mo) | Pro ($199/mo) | Enterprise ($599/mo) |
|---|---|---|---|---|
| License feed | Last 7 days, 10 results | Daily, county filter | Daily, all filters | Real-time, all filters |
| Email digest | — | Weekly | Daily | Daily + instant |
| CSV export | — | 100 records/mo | Unlimited | Unlimited |
| API access | — | — | Read-only | Full + webhooks |
| Webhook | — | — | — | ✓ |
| Seats | 1 | 1 | 3 | Unlimited |

Implement feature gating via a `checkPlan(uid, feature)` server utility that reads the user's Firestore doc. Gate at the API route and Cloud Function level — never trust client-side plan checks for access control.

---

## 7. Core Pages & UI

### Landing Page `/`
- Hero: headline + subheadline + email capture CTA
- Social proof: "X new TABC licenses discovered this week"
- Feature sections: How it works (3 steps), Who it's for (verticals grid), Sample alert card
- Pricing section (3 tiers, highlight Pro)
- Footer with links

### Dashboard `/dashboard`
- **Alert feed:** Card list of new licenses, sortable by date/county/type, with infinite scroll
- **Filters sidebar:** County multi-select, license type multi-select, zip code input, date range
- **Map view:** Toggle to see new licenses plotted on Texas map (use `react-map-gl` + Mapbox or Google Maps)
- **Export button:** Triggers CSV generation and download

### Account `/account`
- Current plan + usage stats
- Upgrade/downgrade (Stripe customer portal redirect)
- Filter preferences (save default filters)
- Email digest toggle + time preference
- API key display + regenerate
- Webhook URL input (Enterprise)

---

## 8. Firebase Cloud Functions

### `ingestTABC` — Scheduled, daily 6:00 AM CST
```
1. Fetch TABC dataset from Socrata SODA2 API (paginate with $limit/$offset)
2. Load existing licenseNumber set from Firestore (or a dedicated index doc)
3. Diff: find records not in existing set
4. Write new records to licenses/{licenseNumber} with isNew=true, firstSeenAt=now
5. Log run metadata (count ingested, duration) to a runs/{runId} doc
```

### `enrichLicense` — Firestore onCreate trigger on `licenses/{licenseNumber}`
```
1. Read new license doc
2. Call Google Maps Geocoding API with full address
3. Update doc with lat, lng, enrichedAt
4. Map licenseType code to human-readable label
5. Set enrichedAt timestamp
```

### `alertFanout` — Firestore onCreate trigger on `licenses/{licenseNumber}`
```
1. Query all users where plan != 'free'
2. For each user, check if license matches their saved filters
3. If match: write to alerts/{alertId}, queue for digest or send webhook
4. For Enterprise webhook users: POST license payload to webhookUrl immediately
```

### `sendDailyDigest` — Scheduled, runs hourly, checks user digestTime preference
```
1. Find users where emailDigest=true and their preferred digest hour matches current hour
2. For each user, query alerts from last 24h not yet emailed
3. Render email template with license cards
4. Send via Resend
5. Mark alerts as emailed
```

### `stripeWebhook` — HTTP trigger
```
Events to handle:
- customer.subscription.created → set plan, planStatus on user doc
- customer.subscription.updated → update plan tier
- customer.subscription.deleted → downgrade to free
- invoice.payment_failed → set planStatus = 'past_due', send warning email
```

---

## 9. Design System

**Aesthetic direction:** Clean, data-forward, B2B SaaS. Think Stripe or Linear — not a startup landing page template.

- **Font:** Use a modern geometric sans for UI (e.g. Geist, DM Sans) + monospace for license numbers and data
- **Colors:** Dark navy primary, amber/gold accent (nod to Texas), neutral grays for data surfaces
- **License card:** Should show business name, address, county badge, license type badge, days-since-filed pill, and a "View Details" expand
- **Map pins:** Color-coded by license type
- **Data tables:** Use shadcn/ui `<Table>` with sticky header, row hover, and sortable columns

---

## 10. Auth & Security Rules

### Firestore Security Rules (enforce server-side too)
```
- users/{uid}: read/write only if request.auth.uid == uid
- licenses/*: read if request.auth != null && user plan != 'free' for full data
- alerts/{alertId}: read only if resource.data.userId == request.auth.uid
- exports/{exportId}: read only if resource.data.userId == request.auth.uid
```

### API Key Auth (for Pro/Enterprise API access)
- Generate UUID v4 on user creation, store on user doc
- For API routes, accept `Authorization: Bearer {apiKey}` header
- Look up apiKey in Firestore (consider a reverse-index `apiKeys/{key} → uid` collection for fast lookup)
- Rate limit: 1000 req/day for Pro, unlimited for Enterprise (track in Firestore counter doc)

---

## 11. Deployment & CI/CD

### Vercel (Frontend)
- Connect GitHub repo to Vercel
- Set all `NEXT_PUBLIC_*` and server-side env vars in Vercel dashboard
- Production branch: `main`; preview branches: all PRs
- Set `NEXT_PUBLIC_APP_URL` to production domain

### Firebase (Backend)
- `firebase deploy --only functions` for Cloud Functions
- `firebase deploy --only firestore:rules` for security rules
- Use Firebase Emulator Suite locally for functions + Firestore dev

### GitHub Actions (optional but recommended)
```yaml
# On push to main:
# 1. Run lint + type check
# 2. Deploy Firebase Functions
# 3. Vercel handles frontend deploy automatically
```

---

## 12. Agent Build Order

Build in this sequence to avoid dependency blockers:

1. **Firebase project setup** — Auth, Firestore, Storage, Functions scaffold
2. **Environment variables** — `.env.local` populated, `.env.example` committed
3. **Data types** — `types/index.ts` with all shared interfaces
4. **Ingest function** — Get TABC data flowing into Firestore first, verify with emulator
5. **Enrich function** — Geocoding trigger working on new license docs
6. **Auth + user creation** — Firebase Auth, user doc creation on signup
7. **Stripe integration** — Products/prices in Stripe, webhook handler, plan gating utility
8. **Frontend shell** — Next.js project, Tailwind, shadcn/ui, Firebase client init
9. **Dashboard page** — License feed pulling from Firestore, filters, basic card UI
10. **Landing page** — Marketing copy, pricing section, CTA
11. **Account page** — Stripe customer portal, filter prefs, API key
12. **Alert fanout + email** — Resend integration, digest function
13. **CSV export** — Firebase Storage, signed URL delivery
14. **Map view** — react-map-gl or Google Maps embed
15. **Polish** — Loading states, empty states, error handling, mobile responsiveness

---

## 13. Open Questions for the User

> **[AGENT: ASK THESE AT THE START, ALL AT ONCE]**

1. What do you want to name the product/brand?
2. Do you have a Firebase project created already, or should I walk you through setup?
3. Do you have a Stripe account and have you created the subscription products/prices yet?
4. Do you have a Resend account and a verified sending domain?
5. Do you have a Google Cloud project with the Maps/Geocoding API enabled?
6. What domain will the app live on?
7. Do you want Mapbox or Google Maps for the map view? (Mapbox is cheaper at scale)
8. Are you building this solo or do you need multi-seat team accounts from day one?

---

*Last updated: March 2026 | Stack: Next.js 14 / Firebase / Vercel / Stripe / Resend*
