/**
 * Shared lead identity + merge helpers used by every ingest source so that
 * TABC, TABS permits, and event permits dedupe onto the same `leads` doc
 * identically. Pure functions only — no Firestore/admin SDK here.
 *
 * Consolidates the address/name normalization previously duplicated in
 * ingest.ts (normalizeKey) and enrichBuildingPermits.ts (normalizeText).
 */

import * as crypto from 'crypto';

export type LeadSourceType = 'tabc' | 'tabc_event' | 'tabs_permit' | 'event' | 'building_permit' | 'nonprofit_990' | 'attorney' | 'bank_branch' | 'medical_npi';
export type LeadSignal =
  | 'opening_soon'
  | 'brand_new'
  | 'build_out'
  | 'event_upcoming'
  | 'no_website'
  | 'multi_unit_operator'
  | 'high_value_buildout'
  | 'multifamily'
  | 'large_nonprofit'
  | 'heavy_advertiser'
  | 'in_the_news'
  | 'active_advertiser';

export interface LeadSource {
  type: LeadSourceType;
  sourceId: string;
  status?: string;
  registeredDate?: string | null;
  openingDate?: string | null;
  estimatedCost?: number | null;
  licenseType?: string;
  detailUrl?: string;
  firstSeenAt?: any;
  raw?: Record<string, any>;
}

const ORG_SUFFIX = /\b(llc|l l c|lp|l p|inc|incorporated|corp|corporation|co|company|ltd|holdings|group|enterprises|enterprise|partners|partnership|llp|the)\b/g;

const ADDRESS_ABBR: Array<[RegExp, string]> = [
  [/\bstreet\b/g, 'st'],
  [/\bavenue\b/g, 'ave'],
  [/\bdrive\b/g, 'dr'],
  [/\bboulevard\b/g, 'blvd'],
  [/\broad\b/g, 'rd'],
  [/\blane\b/g, 'ln'],
  [/\bhighway\b/g, 'hwy'],
  [/\bparkway\b/g, 'pkwy'],
  [/\bcove\b/g, 'cv'],
  [/\bcourt\b/g, 'ct'],
  [/\bplace\b/g, 'pl'],
  [/\bnorth\b/g, 'n'],
  [/\bsouth\b/g, 's'],
  [/\beast\b/g, 'e'],
  [/\bwest\b/g, 'w'],
];

/** Normalize a business name to a comparable core (drops org suffixes/punctuation). */
export function normalizeName(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(ORG_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STREET_SUFFIX = /^(.*?\b(?:st|ave|dr|blvd|rd|ln|hwy|pkwy|cv|ct|pl|cir|trl|way|loop|run|row|sq|ter|xing|pass|bnd|holw|path|walk|plz)\b)/;

/**
 * Normalize a street address to a comparable core. Strips unit/suite designators,
 * then truncates at the first street-type suffix so a trailing city/building token
 * present in one source but not another doesn't break the match.
 */
export function normalizeAddress(value: string): string {
  let s = String(value ?? '').toLowerCase().replace(/#/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  for (const [re, to] of ADDRESS_ABBR) s = s.replace(re, to);
  s = s.replace(/\b(ste|suite|unit|apt|apartment|fl|floor|rm|room|bldg|building)\b.*$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  // Keep only the house-number + street portion (drops trailing city/state/zip).
  const m = s.match(STREET_SUFFIX);
  if (m) return m[1].trim();
  // No street suffix: fall back to stripping a trailing state/zip.
  return s.replace(/\b(texas|tx)\b/g, '').replace(/\b\d{5}(?:\s*\d{4})?\b/g, '').replace(/\s+/g, ' ').trim();
}

/** First significant token of a normalized business name (used for dedupe). */
export function nameToken(name: string): string {
  return normalizeName(name).split(' ')[0] ?? '';
}

/**
 * Stable lead doc id. Keys on normalized (suite-stripped) address + the first
 * name token. This merges the same business arriving from two sources even when
 * one spells it "Hopdoddy" and the other "Hopdoddy Burger Bar LLC", while still
 * keeping distinct tenants in one building separate (e.g. "Cava" vs "Hopdoddy").
 */
export function leadKey(name: string, address: string): string {
  const core = `${normalizeAddress(address)}|${nameToken(name)}`;
  return crypto.createHash('sha1').update(core).digest('hex').slice(0, 24);
}

/** Case-insensitive de-duplicated union of string arrays (drops empties). */
export function unionStrings(...lists: Array<Array<string | undefined | null> | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const v = String(raw ?? '').trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (!seen.has(k)) seen.set(k, v);
    }
  }
  return Array.from(seen.values());
}

/** Replace any existing source with the same type+sourceId, else append. */
export function mergeSources(existing: LeadSource[] | undefined, incoming: LeadSource): LeadSource[] {
  const out = (existing ?? []).filter(
    (s) => !(s.type === incoming.type && s.sourceId === incoming.sourceId)
  );
  out.push(incoming);
  return out;
}

const NEW_CLASSES = new Set(['TRULY_NEW', 'PENDING_NEW', 'REOPENED', 'TRANSFER_OR_CHANGE']);
const HIGH_VALUE_BUILDOUT = 250000;
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

/** Recompute advertising signals from a lead's merged sources + identity. */
export function computeSignals(lead: {
  sources?: LeadSource[];
  website?: string;
}): LeadSignal[] {
  const signals = new Set<LeadSignal>();
  const now = Date.now();

  for (const s of lead.sources ?? []) {
    if (s.type === 'tabs_permit') {
      signals.add('build_out');
      if (Number(s.estimatedCost ?? 0) >= HIGH_VALUE_BUILDOUT) signals.add('high_value_buildout');
      const opening = s.openingDate ? new Date(s.openingDate).getTime() : NaN;
      if (Number.isFinite(opening) && opening > now && opening - now <= NINETY_DAYS) {
        signals.add('opening_soon');
      }
    } else if (s.type === 'tabc') {
      const cls = String(s.raw?.classification ?? '');
      if (NEW_CLASSES.has(cls)) signals.add('brand_new');
      if (String(s.status ?? '').toLowerCase().includes('pending')) signals.add('opening_soon');
    } else if (s.type === 'tabc_event') {
      signals.add('event_upcoming');
    } else if (s.type === 'event') {
      signals.add('event_upcoming');
    } else if (s.type === 'building_permit') {
      signals.add('multifamily');
      const opening = s.openingDate ? new Date(s.openingDate).getTime() : NaN;
      if (Number.isFinite(opening) && opening > now && opening - now <= NINETY_DAYS) {
        signals.add('opening_soon');
      }
    } else if (s.type === 'nonprofit_990') {
      signals.add('large_nonprofit');
    } else if (s.type === 'attorney') {
      signals.add('heavy_advertiser');
    }
  }

  if (!lead.website) signals.add('no_website');
  return Array.from(signals);
}

/**
 * The lead's "record date" — most recent filing/registration across its sources
 * (TABS registration date, TABC issue/application date). Used for the free-tier
 * recency gate. Ignores TABS completion (future) dates by preferring registeredDate.
 */
export function recordDateOf(sources: LeadSource[] | undefined): Date | null {
  let max: Date | null = null;
  for (const s of sources ?? []) {
    const raw = s.registeredDate ?? s.openingDate;
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    if (!max || d > max) max = d;
  }
  return max;
}
