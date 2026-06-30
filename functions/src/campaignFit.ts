/**
 * Campaign fit scoring — rates each lead 0–100 for Sun Radio's three sells, so the
 * same lead pool can be sorted into three "campaign views" instead of three apps.
 *
 *   underwriting — ethos-fit 16-month underwriting: independent, local, an
 *                  established business (not a fragile day-one opening) that can pay.
 *   naming       — naming-rights "whale": a wealth/budget proxy (big revenue, big
 *                  buildout, large org) — who could put their name on the building.
 *   football     — HS football sponsor: multi-town broadcast footprint (a regional
 *                  advertiser present across many of the broadcast cities).
 *
 * Heuristic and intentionally transparent — tune the weights as real deals close.
 */

/** Per-campaign fit scores (0–100). Mirrors CampaignFit in the root types. */
export interface CampaignFit {
  underwriting: number;
  naming: number;
  football: number;
}

interface FitInput {
  category?: string;
  sources?: Array<{ type?: string; estimatedCost?: number | null; raw?: Record<string, any> }>;
  signals?: string[];
  website?: string;
  footprintCount?: number;
  /** Existing enrichment map (Comptroller revenue, etc.) used as a budget proxy. */
  enrichment?: Record<string, any>;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// Categories whose businesses typically sponsor community / small-town sports.
const COMMUNITY_CATEGORIES = new Set(['Financial', 'Medical', 'Legal', 'Retail & Services', 'Housing', 'Home Services']);

// Per-category review thresholds for tiers 1–4 (modest → established → prominent → dominant).
// Calibrated so tier 3 = "top 10% of this vertical" — makes cross-vertical comparison fair.
const REVIEW_TIERS: Record<string, [number, number, number, number]> = {
  'Food & Drink':      [ 75, 250,  750, 2000],
  'Medical':           [ 20,  60,  150,  400],
  'Legal':             [ 15,  40,  100,  250],
  'Financial':         [ 10,  30,   80,  200],
  'Home Services':     [ 20,  60,  150,  400],
  'Retail & Services': [ 30, 100,  300,  800],
  'Nonprofit':         [  5,  15,   40,  100],
  'Housing':           [ 10,  30,   80,  200],
};
const DEFAULT_REVIEW_TIERS: [number, number, number, number] = [30, 100, 300, 800];

// Per-category underwriting base — each vertical's default ethos-fit for Sun Radio.
const UNDERWRITING_BASE: Record<string, number> = {
  'Food & Drink':      30, // core of the Sun Radio brand
  'Medical':           25, // dentists/docs: local, long-tenure, reliable payers
  'Legal':             20, // law firms: established, community-facing
  'Home Services':     20, // HVAC, pest control, roofing: repeat-advertiser verticals
  'Retail & Services': 20,
  'Financial':         15,
  'Housing':           15,
  'Nonprofit':         10,
};

/** Google review count for a lead (popularity / established-ness proxy). */
function reviewCount(input: FitInput): number {
  const fromEnrich = Number(input.enrichment?.googlePlaces?.reviewCount ?? 0);
  let fromSrc = 0;
  for (const s of input.sources ?? []) {
    const rc = Number((s.raw as any)?.reviews ?? 0);
    if (Number.isFinite(rc) && rc > fromSrc) fromSrc = rc;
  }
  return Math.max(fromEnrich || 0, fromSrc);
}

/**
 * Returns 0–4: how prominent this business is *within its own vertical*.
 * Tier 4 = dominant (Torchy's-level); tier 1 = modest but present.
 */
function reviewTier(category: string | undefined, reviews: number): number {
  const tiers = REVIEW_TIERS[category ?? ''] ?? DEFAULT_REVIEW_TIERS;
  if (reviews >= tiers[3]) return 4;
  if (reviews >= tiers[2]) return 3;
  if (reviews >= tiers[1]) return 2;
  if (reviews >= tiers[0]) return 1;
  return 0;
}

/** Largest dollar figure we know about a lead — revenue, buildout cost, 990 revenue. */
function wealthProxy(input: FitInput): number {
  let max = 0;
  for (const s of input.sources ?? []) {
    const c = Number(s.estimatedCost ?? 0);
    if (Number.isFinite(c) && c > max) max = c;
  }
  const compRev = Number(input.enrichment?.comptroller?.latestMonthRevenue ?? 0);
  if (Number.isFinite(compRev) && compRev * 12 > max) max = compRev * 12; // annualize monthly
  return max;
}

export function computeCampaignFit(input: FitInput): CampaignFit {
  // Government / institutional entities aren't ad prospects — zero on every sell.
  if (input.category === 'Government/Institutional') return { underwriting: 0, naming: 0, football: 0 };

  const signals = new Set(input.signals ?? []);
  const sources = input.sources ?? [];
  const hasType = (t: string) => sources.some((s) => s.type === t);
  const footprint = Number(input.footprintCount ?? 0);
  const money = wealthProxy(input);
  const reviews = reviewCount(input);
  const tier = reviewTier(input.category, reviews); // 0–4, relative to vertical

  // ── Football: driven by broadcast footprint, with a small floor for the kinds of
  // regional advertisers that sponsor local sports even before we know their map. ──
  let football = footprint * 5; // ~20 broadcast cities ⇒ maxed out
  if (football === 0 && COMMUNITY_CATEGORIES.has(input.category ?? '')) football = 12;
  if (hasType('bank_branch') && footprint >= 3) football += 15; // banks are prototypical sponsors
  if (signals.has('in_the_news')) football += 5; // active/visible — warmer to approach
  if (signals.has('active_advertiser')) football += 8; // already buys ads — proven budget+behavior
  // Prominent within-vertical businesses are recognizable regional names → football upside.
  if (tier === 4) football += 5;
  else if (tier === 3) football += 3;

  // ── Underwriting: independent + local + established + can pay. ──
  // Each vertical has its own base — so a prominent dentist can compete with a restaurant.
  let underwriting = UNDERWRITING_BASE[input.category ?? ''] ?? 10;
  if (hasType('tabc') || hasType('tabc_event')) underwriting += 15; // breweries / venues / bars
  if (input.website) underwriting += 10;
  if (money >= 250_000) underwriting += 20; // has revenue ⇒ can commit 16 months
  else if (money > 0) underwriting += 10;
  // Prefer established over fragile day-one openings.
  if (!signals.has('brand_new') && !signals.has('opening_soon')) underwriting += 15;
  if (signals.has('multi_unit_operator')) underwriting += 10; // an independent local group
  if (signals.has('in_the_news')) underwriting += 10; // actively promoting itself ⇒ marketing-minded
  if (signals.has('active_advertiser')) underwriting += 20; // already buys ads — the strongest fit
  // Review tier: vertical-relative prominence predicts stability and ad budget.
  const UW_REVIEW = [5, 10, 16, 22] as const;
  if (tier > 0) underwriting += UW_REVIEW[tier - 1];

  // ── Naming: brand prominence + budget proxy — who could put their name on a building.
  // Money is still the anchor, but within-vertical prominence now surfaces recognizable
  // brands (e.g. a restaurant chain or dental group) even without Comptroller data. ──
  let naming = 0;
  if (money >= 5_000_000) naming += 60;
  else if (money >= 1_000_000) naming += 45;
  else if (money >= 250_000) naming += 25;
  else if (money >= 100_000) naming += 12;
  if (signals.has('large_nonprofit')) naming += 20;
  if (signals.has('multi_unit_operator')) naming += 15;
  if (signals.has('heavy_advertiser')) naming += 12; // proven ad budget
  if (signals.has('in_the_news')) naming += 8; // prominent / visible in the community
  if (signals.has('active_advertiser')) naming += 15; // proven they spend on advertising
  // Vertical-relative review tier: dominant businesses in ANY category have brand recognition.
  const NAMING_REVIEW = [8, 18, 30, 45] as const;
  if (tier > 0) naming += NAMING_REVIEW[tier - 1];

  return { underwriting: clamp(underwriting), naming: clamp(naming), football: clamp(football) };
}
