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

/** Look up RadioWorkflow accounts matching `term`. Resolves (never rejects). */
export function lookupRadioWorkflow(term: string, timeoutMs = 9000): Promise<RwLookupResult> {
  if (typeof window === "undefined") return Promise.resolve({ ok: false, error: "No window" });

  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    let done = false;

    const finish = (r: RwLookupResult) => {
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
      if (d.kind === "result" && d.id === id) finish(d.payload as RwLookupResult);
    };

    window.addEventListener("message", onMsg);
    window.postMessage({ source: PAGE, kind: "lookup", id, term }, "*");

    setTimeout(
      () =>
        finish({
          ok: false,
          error: extReady
            ? "RadioWorkflow lookup timed out."
            : "RadioWorkflow extension not detected. Install it (see /extension) and reload.",
        }),
      timeoutMs
    );
  });
}
