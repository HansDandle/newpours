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
const COMMUNITY_CATEGORIES = new Set(['Financial', 'Medical', 'Legal', 'Retail & Services', 'Housing']);

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
  const signals = new Set(input.signals ?? []);
  const sources = input.sources ?? [];
  const hasType = (t: string) => sources.some((s) => s.type === t);
  const footprint = Number(input.footprintCount ?? 0);
  const money = wealthProxy(input);

  // ── Football: driven by broadcast footprint, with a small floor for the kinds of
  // regional advertisers that sponsor local sports even before we know their map. ──
  let football = footprint * 5; // ~20 broadcast cities ⇒ maxed out
  if (football === 0 && COMMUNITY_CATEGORIES.has(input.category ?? '')) football = 12;
  if (hasType('bank_branch') && footprint >= 3) football += 15; // banks are prototypical sponsors
  if (signals.has('in_the_news')) football += 5; // active/visible — warmer to approach

  // ── Underwriting: independent + local + established + can pay. ──
  let underwriting = 0;
  if (input.category === 'Food & Drink') underwriting += 30; // core of the Sun Radio ethos
  if (hasType('tabc') || hasType('tabc_event')) underwriting += 15; // breweries / venues / bars
  if (input.website) underwriting += 10;
  if (money >= 250_000) underwriting += 20; // has revenue ⇒ can commit 16 months
  else if (money > 0) underwriting += 10;
  // Prefer established over fragile day-one openings.
  if (!signals.has('brand_new') && !signals.has('opening_soon')) underwriting += 15;
  if (signals.has('multi_unit_operator')) underwriting += 10; // an independent local group
  if (signals.has('in_the_news')) underwriting += 10; // actively promoting itself ⇒ marketing-minded

  // ── Naming: pure wealth/budget proxy — who can afford to name a building. ──
  let naming = 0;
  if (money >= 5_000_000) naming += 60;
  else if (money >= 1_000_000) naming += 45;
  else if (money >= 250_000) naming += 25;
  else if (money >= 100_000) naming += 12;
  if (signals.has('large_nonprofit')) naming += 20;
  if (signals.has('multi_unit_operator')) naming += 15;
  if (signals.has('heavy_advertiser')) naming += 12; // proven ad budget
  if (signals.has('in_the_news')) naming += 8; // prominent / visible in the community

  return { underwriting: clamp(underwriting), naming: clamp(naming), football: clamp(football) };
}
