/**
 * Background service worker — performs the actual RadioWorkflow lookup.
 *
 * Because this runs in the user's own browser with host permission for
 * radioworkflow.com, the fetch carries the user's live RW session cookies
 * (and Cloudflare clearance) automatically — no CORS, no datacenter-IP block.
 */

const RW_LOOKUP = 'https://www.radioworkflow.com/app/listeners/lookup_accounts.php';

/** RW returns some fields as HTML anchors (e.g. trading name, owner) — pull the text. */
function stripHtml(value) {
  if (value == null) return '';
  const s = String(value);
  const anchor = s.match(/>([^<]+)<\/a>/);
  if (anchor) return anchor[1].trim();
  return s.replace(/<[^>]*>/g, '').trim();
}

function normalize(rec) {
  return {
    id: rec.core_id,
    name: stripHtml(rec.core_trading_name) || stripHtml(rec.core_legal) || '',
    contactName: String(rec.core_contact_name || '').trim(),
    position: String(rec.core_position || '').trim(),
    email: String(rec.core_email || '').trim(),
    phone: String(rec.core_phone || rec.core_mobile || '').trim(),
    website: String(rec.core_website || '').trim(),
    owner: stripHtml(rec.core_owner),
    prospect: Number(rec.core_prospect) === 1,
    archived: Number(rec.core_archived) === 1,
  };
}

async function lookup(term) {
  const url = `${RW_LOOKUP}?term=${encodeURIComponent(term)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' },
    });
  } catch (e) {
    return { ok: false, error: 'Network error contacting RadioWorkflow.' };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, needsAuth: true, error: `RadioWorkflow returned ${res.status}. Log in to RadioWorkflow in this browser, then retry.` };
  }

  const text = (await res.text()).trim();
  // An HTML page (login screen / Cloudflare challenge) instead of JSON ⇒ not authenticated.
  if (!text || text[0] === '<') {
    return { ok: false, needsAuth: true, error: 'Not logged in to RadioWorkflow. Open RadioWorkflow in another tab, sign in, then retry.' };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'Unexpected (non-JSON) response from RadioWorkflow.' };
  }

  const arr = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : [];
  const results = arr.filter((r) => r && typeof r === 'object' && 'core_id' in r).map(normalize);
  return { ok: true, results };
}

// ── Meta Ad Library — "is this business running ads right now?" ──────────────
// The Ad Library has no commercial API, only a token-gated internal endpoint.
// Running from the user's browser (their IP/session) dodges the datacenter
// bot-block. Best-effort: any failure returns ok:false so PourScout falls back
// to the manual toggle rather than guessing.
async function metaAdsLookup(term) {
  const country = 'US';
  const q = encodeURIComponent(term);

  // 1) Load the Ad Library page to obtain a session LSD token.
  let lsd = '';
  try {
    const pageRes = await fetch(
      `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${q}&search_type=keyword_unordered`,
      { credentials: 'include' }
    );
    const html = await pageRes.text();
    const m = html.match(/"LSD",\[\],\{"token":"([^"]+)"/) || html.match(/name="lsd"\s+value="([^"]+)"/);
    if (m) lsd = m[1];
  } catch (e) {
    return { ok: false, error: 'Could not reach the Meta Ad Library.' };
  }
  if (!lsd) return { ok: false, error: 'Ad Library token not found (Meta may have changed its format).' };

  // 2) Query the async search endpoint with the token.
  try {
    const body = new URLSearchParams({
      q: term,
      count: '30',
      active_status: 'active',
      ad_type: 'all',
      countries: `["${country}"]`,
      search_type: 'keyword_unordered',
      media_type: 'all',
      lsd,
      __a: '1',
    });
    const res = await fetch('https://www.facebook.com/ads/library/async/search_ads/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-lsd': lsd },
      body: body.toString(),
    });
    let text = await res.text();
    text = text.replace(/^for \(;;\);/, '').replace(/^\)\]\}'/, '').trim();
    const json = JSON.parse(text);
    const payload = json.payload || json;
    let count = 0;
    if (Array.isArray(payload.results)) {
      for (const r of payload.results) count += Array.isArray(r) ? r.length : 1;
    }
    if (typeof payload.totalCount === 'number' && payload.totalCount > count) count = payload.totalCount;
    return { ok: true, count, active: count > 0 };
  } catch (e) {
    return { ok: false, error: 'Could not read Ad Library results (Meta may have changed its format).' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.kind === 'lookup') {
    lookup(String(msg.term || '')).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (msg && msg.kind === 'meta_ads') {
    metaAdsLookup(String(msg.term || '')).then(sendResponse);
    return true;
  }
  return false;
});
