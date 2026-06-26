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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.kind === 'lookup') {
    lookup(String(msg.term || '')).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  return false;
});
