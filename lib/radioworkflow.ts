/**
 * Client-side bridge to the PourScout × RadioWorkflow browser extension.
 *
 * The extension (if installed) injects a content script on pourscout.com that
 * listens for these window messages, performs the lookup against RadioWorkflow
 * using the user's own logged-in session, and posts the result back. If the
 * extension isn't installed, lookups resolve with a friendly "not detected" error.
 */

export interface RwAccount {
  id: number | string;
  name: string;
  contactName: string;
  position: string;
  email: string;
  phone: string;
  website: string;
  owner: string; // the RadioWorkflow rep who owns the account
  prospect: boolean;
  archived: boolean;
  /** Direct URL to the account profile page — returned by the extension when available. */
  url?: string;
  /** Confidence score vs. the lead (set client-side after lookup), higher = better. */
  matchScore?: number;
  /** Which lead fields this account agreed on (e.g. ["phone", "name"]). */
  matchedOn?: string[];
}

/** The lead identity used to score RW results and reject fuzzy false positives. */
export interface RwMatchInput {
  name?: string;
  phones?: string[];
  emails?: string[];
  website?: string;
}

const RW_STOPWORDS = new Set([
  'the', 'and', 'llc', 'inc', 'co', 'corp', 'ltd', 'llp', 'lp', 'company', 'group',
  'injury', 'law', 'lawyers', 'attorney', 'attorneys', 'firm', 'pllc', 'pc', 'services',
  'tx', 'texas', 'austin', 'of', 'for',
]);

const rwDigits = (s?: string) => String(s ?? '').replace(/\D/g, '');
function rwDomain(website?: string): string {
  if (!website) return '';
  try {
    return new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}
function rwTokens(name?: string): Set<string> {
  return new Set(
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !RW_STOPWORDS.has(t))
  );
}

/**
 * Score one RW account against the lead. Concrete identifiers (phone/email/domain)
 * are strong; shared distinctive name tokens are medium. Accounts that agree on
 * nothing score 0 — those are the fuzzy false positives (e.g. an unrelated
 * dancehall, or a blank-named record) we want to drop.
 */
export function scoreRwAccount(acc: RwAccount, lead: RwMatchInput): { score: number; matchedOn: string[] } {
  const matchedOn: string[] = [];
  let score = 0;

  const leadPhones = new Set((lead.phones ?? []).map(rwDigits).filter((p) => p.length >= 10));
  if (leadPhones.size && rwDigits(acc.phone).length >= 10 && leadPhones.has(rwDigits(acc.phone))) {
    score += 5; matchedOn.push('phone');
  }
  const leadEmails = new Set((lead.emails ?? []).map((e) => e.toLowerCase().trim()).filter(Boolean));
  if (acc.email && leadEmails.has(acc.email.toLowerCase().trim())) { score += 5; matchedOn.push('email'); }

  const ld = rwDomain(lead.website);
  const ad = rwDomain(acc.website);
  if (ld && ad && ld === ad) { score += 5; matchedOn.push('website'); }

  const leadTokens = rwTokens(lead.name);
  const accTokens = rwTokens(acc.name);
  const overlap = [...accTokens].filter((t) => leadTokens.has(t));
  if (overlap.length >= 2) { score += 3; matchedOn.push('name'); }
  else if (overlap.length === 1) { score += 1; matchedOn.push('name~'); }

  return { score, matchedOn };
}

export interface RwLookupResult {
  ok: boolean;
  results?: RwAccount[];
  error?: string;
  needsAuth?: boolean;
}

const PAGE = "pourscout-rw"; // page -> extension
const EXT = "pourscout-rw-ext"; // extension -> page

let extReady = false;

if (typeof window !== "undefined") {
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = (e as MessageEvent).data;
    if (d && d.source === EXT && d.kind === "ready") extReady = true;
  });
  // Prompt any installed extension to announce itself.
  try {
    window.postMessage({ source: PAGE, kind: "ping" }, "*");
  } catch {
    /* no-op */
  }
}

/** Whether the browser extension has announced itself in this session. */
export function rwExtensionReady(): boolean {
  return extReady;
}

/**
 * Look up across several terms (business name + known emails/phones) and merge the
 * matches, de-duplicated by account id. RadioWorkflow's `term` search is already
 * fuzzy on the name; searching the emails/phones too catches accounts filed under
 * a different name. Resolves (never rejects).
 *
 * Pass `match` (the lead identity) to score results and drop fuzzy false positives:
 * accounts that agree on nothing (no shared phone/email/domain/name token) are
 * removed, and the rest are ranked best-first with a `matchedOn` reason. When no
 * account clears the bar we still return everything (flagged score 0) so a genuine
 * match filed under an odd name isn't hidden — the UI can show it as unverified.
 */
export async function lookupRadioWorkflowMany(
  terms: string[],
  match?: RwMatchInput,
  timeoutMs = 9000
): Promise<RwLookupResult> {
  const unique = Array.from(
    new Set(terms.map((t) => String(t ?? "").trim()).filter((t) => t.length >= 3))
  ).slice(0, 6); // cap the number of round-trips
  if (!unique.length) return { ok: false, error: "Nothing to search on (no name, email, or phone)." };

  const settled = await Promise.all(unique.map((t) => lookupRadioWorkflow(t, timeoutMs)));

  const merged = new Map<string, RwAccount>();
  let anyOk = false;
  let needsAuth = false;
  let firstError: string | undefined;
  for (const r of settled) {
    if (r.ok) {
      anyOk = true;
      for (const a of r.results ?? []) merged.set(String(a.id), a);
    } else {
      if (r.needsAuth) needsAuth = true;
      if (!firstError) firstError = r.error;
    }
  }

  if (!anyOk) return { ok: false, needsAuth, error: firstError ?? "Lookup failed." };

  let results = Array.from(merged.values());
  if (match) {
    for (const a of results) {
      const { score, matchedOn } = scoreRwAccount(a, match);
      a.matchScore = score;
      a.matchedOn = matchedOn;
    }
    const strong = results.filter((a) => (a.matchScore ?? 0) > 0);
    // Keep only real matches when we have any; otherwise return all (score 0) so a
    // genuine but oddly-filed account isn't silently dropped.
    results = (strong.length ? strong : results).sort((x, y) => (y.matchScore ?? 0) - (x.matchScore ?? 0));
  }
  return { ok: true, results };
}

/** Send one request to the extension and await its reply (resolves, never rejects). */
function extensionRequest<T>(kind: string, term: string, timeoutMs: number, onTimeout: T): Promise<T> {
  if (typeof window === "undefined") return Promise.resolve(onTimeout);
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    let done = false;
    const finish = (r: T) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      resolve(r);
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== EXT) return;
      if (d.kind === "ready") extReady = true;
      if (d.kind === "result" && d.id === id) finish(d.payload as T);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ source: PAGE, kind, id, term }, "*");
    setTimeout(() => finish(onTimeout), timeoutMs);
  });
}

/** Look up RadioWorkflow accounts matching `term`. Resolves (never rejects). */
export function lookupRadioWorkflow(term: string, timeoutMs = 9000): Promise<RwLookupResult> {
  return extensionRequest<RwLookupResult>("lookup", term, timeoutMs, {
    ok: false,
    error: extReady
      ? "RadioWorkflow lookup timed out."
      : "RadioWorkflow extension not detected. Install it (see /extension) and reload.",
  });
}

export interface MetaAdsResult {
  ok: boolean;
  count?: number;
  active?: boolean;
  error?: string;
}

/** Check the Meta Ad Library for active ads from `term`. Resolves (never rejects). */
export function lookupMetaAds(term: string, timeoutMs = 12000): Promise<MetaAdsResult> {
  return extensionRequest<MetaAdsResult>("meta_ads", term, timeoutMs, {
    ok: false,
    error: extReady ? "Meta ad check timed out." : "Extension not detected.",
  });
}
