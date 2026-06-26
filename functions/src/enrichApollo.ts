/**
 * Apollo enrichment — find the decision-maker + verified work email for a lead.
 *
 * Two-step ("Search → Enrich"):
 *   1. People Search by the org's domain (or name) + role-appropriate titles to
 *      DISCOVER the right person (most leads have no contact yet).
 *   2. People Enrichment (bulk_match by Apollo id) to REVEAL the verified work
 *      email/title/LinkedIn for that person.
 *
 * The email is written back to the lead (emails[] + a contact), which the HubSpot
 * push then carries into campaigns. Phone numbers are async (webhook) and left
 * out of v1. Every reveal consumes Apollo credits, so this is gated to leads that
 * still lack an email and run on-demand / in capped batches.
 *
 * Key: settings/integrations.apollo.apiKey (x-api-key header).
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/search';
const MATCH_URL = 'https://api.apollo.io/api/v1/people/bulk_match';
const HEALTH_URL = 'https://api.apollo.io/api/v1/auth/health';

// Role titles to search for, by lead category — who actually buys radio ads.
const TITLES_BY_CATEGORY: Record<string, string[]> = {
  'Food & Drink': ['owner', 'general manager', 'marketing manager', 'proprietor', 'operator'],
  Medical: ['owner', 'practice manager', 'office manager', 'marketing director', 'administrator'],
  Nonprofit: ['executive director', 'development director', 'marketing director', 'communications director', 'founder'],
  'Kids & Family': ['owner', 'director', 'executive director', 'marketing director'],
  'Fitness & Beauty': ['owner', 'general manager', 'marketing manager'],
  'Retail & Services': ['owner', 'general manager', 'marketing manager'],
  Housing: ['property manager', 'community manager', 'regional manager', 'marketing director'],
};
const DEFAULT_TITLES = ['owner', 'general manager', 'president', 'marketing director'];

interface ApolloSettings {
  apiKey?: string;
  enabled?: boolean;
}

async function getApolloSettings(): Promise<ApolloSettings | null> {
  const snap = await db.doc('settings/integrations').get();
  if (!snap.exists) return null;
  return (snap.data() as Record<string, any>)?.apollo ?? null;
}

function domainOf(website?: string): string {
  if (!website) return '';
  try {
    const u = new URL(website.startsWith('http') ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRealEmail = (e?: string) => !!e && !/email_not_unlocked|not_unlocked|domain\.com$/i.test(e) && /@/.test(e);

interface ApolloPerson {
  id?: string;
  name?: string;
  title?: string;
  email?: string;
  email_status?: string;
  linkedin_url?: string;
}

const apolloHeaders = (apiKey: string) => ({
  'x-api-key': apiKey,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

/** Build a legible error from an Apollo non-OK response (includes Apollo's own message). */
async function apolloError(stage: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  const detail = body ? `: ${body.slice(0, 300)}` : '';
  if (res.status === 401) return `Apollo ${stage} rejected the API key (401). Check the key in Admin → Integrations.`;
  if (res.status === 403) {
    return `Apollo ${stage} returned 403 — your Apollo plan/key isn't authorized for the ${stage} API. ` +
      `Use a master API key from Apollo Settings → Integrations → API on a plan that includes API access${detail}`;
  }
  if (res.status === 429) return `Apollo ${stage} rate-limited (429). Wait and retry${detail}`;
  return `Apollo ${stage} HTTP ${res.status}${detail}`;
}

/** Step 1 — find candidate people at the org by domain (preferred) or name keyword. */
async function searchPeople(apiKey: string, opts: { domain?: string; orgName?: string; titles: string[] }): Promise<ApolloPerson[]> {
  const body: Record<string, any> = { page: 1, per_page: 5, person_titles: opts.titles };
  if (opts.domain) body.q_organization_domains_list = [opts.domain];
  else if (opts.orgName) body.q_keywords = opts.orgName;
  else return [];

  const res = await fetch(SEARCH_URL, { method: 'POST', headers: apolloHeaders(apiKey), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await apolloError('search', res));
  const json = (await res.json()) as { people?: ApolloPerson[] };
  return Array.isArray(json.people) ? json.people : [];
}

/** Step 2 — reveal the verified email for a matched Apollo person id. */
async function enrichById(apiKey: string, id: string): Promise<ApolloPerson | null> {
  const res = await fetch(MATCH_URL, {
    method: 'POST',
    headers: apolloHeaders(apiKey),
    body: JSON.stringify({ details: [{ id }] }),
  });
  if (!res.ok) throw new Error(await apolloError('match', res));
  const json = (await res.json()) as { matches?: ApolloPerson[] };
  return json.matches?.[0] ?? null;
}

export interface ApolloLeadResult {
  matched: boolean;
  name?: string;
  title?: string;
  email?: string;
}

/** Search→enrich a single lead and write the contact back. Returns what was found. */
export async function apolloEnrichOne(leadId: string, lead: Record<string, any>, apiKey: string): Promise<ApolloLeadResult> {
  const domain = domainOf(lead.website);
  const orgName = String(lead.businessName ?? '').trim();
  if (!domain && !orgName) return { matched: false };

  const titles = TITLES_BY_CATEGORY[lead.category] ?? DEFAULT_TITLES;
  const people = await searchPeople(apiKey, { domain, orgName, titles });
  if (!people.length) return { matched: false };

  // Prefer a candidate we can identify; reveal the email via enrichment.
  const candidate = people.find((p) => p.id) ?? people[0];
  let person: ApolloPerson = candidate;
  if (candidate.id && !isRealEmail(candidate.email)) {
    const revealed = await enrichById(apiKey, candidate.id);
    if (revealed) person = revealed;
  }

  const email = isRealEmail(person.email) ? String(person.email) : '';
  const name = person.name ?? '';
  const title = person.title ?? '';

  const updates: Record<string, any> = {
    'enrichment.apollo': {
      personId: candidate.id ?? null,
      name: name || null,
      title: title || null,
      email: email || null,
      emailStatus: person.email_status ?? null,
      linkedinUrl: person.linkedin_url ?? null,
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (email) updates.emails = admin.firestore.FieldValue.arrayUnion(email);
  await db.doc(`leads/${leadId}`).update(updates);

  // Add the discovered person as a contact (deduped by email when present).
  if (email || name) {
    const data = {
      name: name || null,
      role: 'manual',
      title: title || null,
      email: email || null,
      source: 'apollo',
      linkedinUrl: person.linkedin_url ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const col = db.collection('leads').doc(leadId).collection('contacts');
    if (email) await col.doc(`email_${email.toLowerCase().replace(/[^a-z0-9]/g, '')}`).set(data, { merge: true });
    else await col.add(data);
  }

  return { matched: true, name, title, email };
}

export interface ApolloJobResult {
  processed: number;
  withEmail: number;
  noMatch: number;
}

/** Batch: enrich leads that still lack an email. */
export async function runApolloJob(options?: { limit?: number }): Promise<ApolloJobResult> {
  const settings = await getApolloSettings();
  if (!settings?.apiKey) throw new Error('Apollo API key not configured');
  const limit = options?.limit ?? 100;

  // Pull a working set and filter to leads with no email yet and not already tried.
  const snap = await db.collection('leads').limit(2000).get();
  let processed = 0;
  let withEmail = 0;
  let noMatch = 0;
  for (const doc of snap.docs) {
    if (processed >= limit) break;
    const lead = doc.data() as Record<string, any>;
    if ((lead.emails ?? []).length > 0) continue; // already has an email
    if (lead.enrichment?.apollo) continue; // already attempted
    processed++;
    try {
      const r = await apolloEnrichOne(doc.id, lead, settings.apiKey);
      if (r.matched && r.email) withEmail++;
      else noMatch++;
    } catch (err) {
      console.error(`Apollo enrich failed for ${doc.id}:`, err);
      noMatch++;
    }
    await sleep(900); // stay well under per-minute rate limits
  }
  return { processed, withEmail, noMatch };
}

// ── Callables ─────────────────────────────────────────────────────────────────

export const apolloEnrichLead = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { leadId } = request.data as { leadId?: string };
  if (!leadId) throw new HttpsError('invalid-argument', 'leadId required');

  const settings = await getApolloSettings();
  if (!settings?.apiKey) throw new HttpsError('failed-precondition', 'Apollo API key not configured');

  const snap = await db.doc(`leads/${leadId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', `Lead ${leadId} not found`);
  try {
    return await apolloEnrichOne(leadId, snap.data() as Record<string, any>, settings.apiKey);
  } catch (err: any) {
    const msg = err?.message ?? 'Apollo enrichment failed';
    console.error('Apollo enrich failed:', msg);
    // Surface key/plan problems as a precondition failure (not a generic 500).
    const code = /\b(401|403)\b/.test(msg) ? 'failed-precondition' : 'internal';
    throw new HttpsError(code, msg);
  }
});

export const apolloTestConnection = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const apiKey = (request.data as { apiKey?: string })?.apiKey || (await getApolloSettings())?.apiKey;
  if (!apiKey) throw new HttpsError('failed-precondition', 'No API key provided');
  try {
    const res = await fetch(HEALTH_URL, { headers: { 'x-api-key': apiKey, 'Cache-Control': 'no-cache' } });
    if (res.ok) return { ok: true, message: 'Connected — Apollo key is valid.' };
    return { ok: false, message: `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? 'Connection failed' };
  }
});
