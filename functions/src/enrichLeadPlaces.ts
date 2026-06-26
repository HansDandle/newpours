/**
 * Universal Google Places enrichment for leads.
 *
 * Resolves website + phone + rating for any lead by searching its business name
 * and address. This is the prerequisite for Apollo (which needs a domain) and
 * gives every lead a callable phone number. Complements enrichMultifamilyPm
 * (address-only, apartment-specific) — this one is name-driven and source-agnostic.
 *
 * Reuses the GOOGLE_MAPS_API_KEY secret from enrich.ts.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { googleMapsApiKeySecret } from './enrich';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\b(llc|inc|lp|ltd|dba|corp|co)\b/gi, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}
function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a), nb = normalizeName(b);
  const max = Math.max(na.length, nb.length);
  return max === 0 ? 0 : 1 - levenshtein(na, nb) / max;
}

interface PlacesResult { name?: string; formatted_address?: string; place_id?: string; }

async function textSearch(query: string, apiKey: string): Promise<PlacesResult[]> {
  const res = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`);
  const json = (await res.json()) as { status?: string; results?: PlacesResult[]; error_message?: string };
  const status = String(json?.status ?? 'UNKNOWN_ERROR');
  if (['REQUEST_DENIED', 'OVER_DAILY_LIMIT', 'OVER_QUERY_LIMIT', 'INVALID_REQUEST'].includes(status)) {
    throw new Error(`Places Text Search failed: ${json?.error_message ? `${status}: ${json.error_message}` : status}`);
  }
  return Array.isArray(json?.results) ? json.results : [];
}

interface PlaceDetail {
  name?: string;
  formatted_phone_number?: string;
  website?: string;
  rating?: number;
  user_ratings_total?: number;
  geometry?: { location?: { lat?: number; lng?: number } };
}
async function placeDetails(placeId: string, apiKey: string): Promise<PlaceDetail> {
  const res = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_phone_number,website,rating,user_ratings_total,geometry&key=${apiKey}`);
  const json = (await res.json()) as { result?: PlaceDetail };
  return json?.result ?? {};
}

export interface LeadPlacesResult { matched: boolean; website?: string; phone?: string; }

/** Resolve website/phone/rating for one lead by name + address. */
export async function enrichLeadPlacesOne(leadId: string, lead: Record<string, any>, apiKey: string): Promise<LeadPlacesResult> {
  const name = String(lead.businessName ?? '').trim();
  const address = String(lead.address ?? '').trim();
  const city = String(lead.city ?? '').trim();
  const zip = String(lead.zipCode ?? '').trim();
  if (!name && !address) return { matched: false };

  const queries = [
    [name, address, city, 'TX'].filter(Boolean).join(' '),
    [name, city, 'TX'].filter(Boolean).join(' '),
    [name, address].filter(Boolean).join(' '),
  ].filter(Boolean);

  let results: PlacesResult[] = [];
  for (const q of queries) {
    results = await textSearch(q, apiKey);
    if (results.length) break;
  }
  if (!results.length) {
    await db.doc(`leads/${leadId}`).update({ 'enrichment.googlePlaces': { noMatch: true, triedAt: admin.firestore.FieldValue.serverTimestamp() } });
    return { matched: false };
  }

  // Pick the best of the top results: strong name match, or a zip match.
  const ranked = results.slice(0, 5).map((r) => {
    const placeZip = (String(r.formatted_address ?? '').match(/\b(\d{5})\b/) ?? [])[1] ?? '';
    return { r, sim: nameSimilarity(name, r.name ?? ''), zipMatch: zip.length === 5 && placeZip === zip };
  }).sort((a, b) => Number(b.zipMatch) - Number(a.zipMatch) || b.sim - a.sim);
  const best = ranked[0];
  if (!best?.r.place_id || (!best.zipMatch && best.sim < 0.45)) {
    await db.doc(`leads/${leadId}`).update({ 'enrichment.googlePlaces': { noMatch: true, triedAt: admin.firestore.FieldValue.serverTimestamp() } });
    return { matched: false };
  }

  const detail = await placeDetails(best.r.place_id, apiKey);
  const website = detail.website ?? '';
  const phone = detail.formatted_phone_number ?? '';

  const updates: Record<string, any> = {
    'enrichment.googlePlaces': {
      placeId: best.r.place_id,
      name: detail.name ?? best.r.name ?? null,
      website: website || null,
      phone: phone || null,
      rating: detail.rating ?? null,
      reviewCount: detail.user_ratings_total ?? null,
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (website && !lead.website) {
    updates.website = website;
    updates.signals = admin.firestore.FieldValue.arrayRemove('no_website');
  }
  if (phone) updates.phones = admin.firestore.FieldValue.arrayUnion(phone);
  const lat = detail.geometry?.location?.lat;
  const lng = detail.geometry?.location?.lng;
  if (typeof lat === 'number' && lead.lat == null) updates.lat = lat;
  if (typeof lng === 'number' && lead.lng == null) updates.lng = lng;

  await db.doc(`leads/${leadId}`).update(updates);

  if (phone) {
    await db.collection('leads').doc(leadId).collection('contacts').doc(`phone_${phone.replace(/[^0-9]/g, '')}`).set({
      name: detail.name ? `${detail.name} (main line)` : 'Main line',
      role: 'google',
      phone,
      source: 'google_places',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  return { matched: true, website, phone };
}

export interface LeadPlacesJobResult { processed: number; matched: number; noMatch: number; }

/** Batch: enrich leads that have no website yet (the Apollo prerequisite). */
export async function runLeadPlacesJob(options?: { limit?: number }): Promise<LeadPlacesJobResult> {
  const apiKey = googleMapsApiKeySecret.value();
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not configured');
  const limit = options?.limit ?? 200;

  const snap = await db.collection('leads').limit(3000).get();
  let processed = 0, matched = 0, noMatch = 0;
  for (const doc of snap.docs) {
    if (processed >= limit) break;
    const lead = doc.data() as Record<string, any>;
    if (lead.website) continue; // already has a site
    if (lead.enrichment?.googlePlaces) continue; // already attempted (match or no-match)
    processed++;
    try {
      const r = await enrichLeadPlacesOne(doc.id, lead, apiKey);
      if (r.matched) matched++;
      else noMatch++;
    } catch (err) {
      console.error(`Lead Places enrich failed for ${doc.id}:`, err);
      noMatch++;
    }
    await sleep(150);
  }
  return { processed, matched, noMatch };
}

export const enrichLeadPlaces = onSchedule(
  { schedule: '0 6 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: [googleMapsApiKeySecret] },
  async () => {
    const result = await runLeadPlacesJob();
    await admin.firestore().collection('runs').add({ type: 'enrich_lead_places', ...result, at: admin.firestore.FieldValue.serverTimestamp() });
  }
);

export const enrichLeadPlacesLead = onCall({ cors: true, secrets: [googleMapsApiKeySecret] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { leadId } = request.data as { leadId?: string };
  if (!leadId) throw new HttpsError('invalid-argument', 'leadId required');
  const apiKey = googleMapsApiKeySecret.value();
  if (!apiKey) throw new HttpsError('failed-precondition', 'GOOGLE_MAPS_API_KEY not configured');
  const snap = await db.doc(`leads/${leadId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', `Lead ${leadId} not found`);
  try {
    return await enrichLeadPlacesOne(leadId, snap.data() as Record<string, any>, apiKey);
  } catch (err: any) {
    throw new HttpsError('internal', err?.message ?? 'Google Places enrichment failed');
  }
});
