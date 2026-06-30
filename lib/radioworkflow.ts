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
 */
export async function lookupRadioWorkflowMany(terms: string[], timeoutMs = 9000): Promise<RwLookupResult> {
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
  return { ok: true, results: Array.from(merged.values()) };
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
