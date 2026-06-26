/**
 * Content script — the bridge between the PourScout page and the extension.
 *
 * PourScout (page world) can't talk to the extension directly, so it posts
 * window messages; this script (injected only on PourScout) relays them to the
 * background worker and posts the reply back. It also announces the extension's
 * presence so PourScout can show the lookup button only when installed.
 */

const PAGE = 'pourscout-rw'; // page  -> extension
const EXT = 'pourscout-rw-ext'; // extension -> page

function announce() {
  window.postMessage({ source: EXT, kind: 'ready', version: chrome.runtime.getManifest().version }, '*');
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.source !== PAGE) return;

  if (d.kind === 'ping') {
    announce();
    return;
  }

  if (d.kind === 'lookup') {
    chrome.runtime.sendMessage({ kind: 'lookup', term: d.term }, (resp) => {
      const payload = chrome.runtime.lastError
        ? { ok: false, error: chrome.runtime.lastError.message }
        : resp;
      window.postMessage({ source: EXT, kind: 'result', id: d.id, payload }, '*');
    });
  }
});

announce(); // in case the page is already listening
