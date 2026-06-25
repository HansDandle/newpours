/**
 * Multifamily PM resolution — Phase B of the apartment lead source.
 *
 * A construction permit never names the property manager. But as a new community
 * nears completion it sets up a "Now Leasing" Google Business listing (leasing
 * office phone + website) — which is also the moment it becomes worth calling.
 * This job searches Google Places by the development's address and, on a match,
 * captures the community name, leasing phone, and website onto the lead.
 *
 * Reuses the GOOGLE_MAPS_API_KEY secret from enrich.ts.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { googleMapsApiKeySecret } from './enrich';

if (!admin.apps.length) admin.initializeApp();

const RESIDENTIAL_HINT = /\b(apartment|apartments|apts|residences?|lofts?|flats?|living|villas?|towers?|commons|place|cottages?|townhomes?)\b/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlacesResult {
  name?: string;
  formatted_address?: string;
  place_id?: string;
}

async function textSearch(query: string, apiKey: string): Promise<PlacesResult[]> {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`
  );
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
}

async function placeDetails(placeId: string, apiKey: string): Promise<PlaceDetail> {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_phone_number,website&key=${apiKey}`
  );
  const json = (await res.json()) as { result?: PlaceDetail };
  return json?.result ?? {};
}

export interface MultifamilyPmResult {
  processed: number;
  matched: number;
  noMatch: number;
}

/** Resolve the leasing office / PM for a single multifamily lead. Returns true on match. */
async function resolveOne(
  db: FirebaseFirestore.Firestore,
  leadId: string,
  lead: Record<string, any>,
  apiKey: string
): Promise<boolean> {
  const address = String(lead.address ?? '').trim();
  const city = String(lead.city ?? 'Austin').trim();
  const zip = String(lead.zipCode ?? '').trim();
  if (!address) return false;

  const queries = [
    `${address} ${city} TX apartments`,
    `${address} ${zip} apartments`,
    `${address} ${city} TX`,
  ];

  let results: PlacesResult[] = [];
  for (const q of queries) {
    results = await textSearch(q, apiKey);
    if (results.length) break;
  }
  if (!results.length) return false;

  // Accept a candidate when its zip matches the lead's, or its name reads residential.
  const pick = results.slice(0, 5).find((r) => {
    const placeZip = (String(r.formatted_address ?? '').match(/\b(\d{5})\b/) ?? [])[1] ?? '';
    const zipMatch = zip.length === 5 && placeZip === zip;
    return zipMatch || RESIDENTIAL_HINT.test(String(r.name ?? ''));
  });
  if (!pick?.place_id) return false;

  const detail = await placeDetails(pick.place_id, apiKey);
  const communityName = detail.name || pick.name || '';
  const phone = detail.formatted_phone_number ?? '';
  const website = detail.website ?? '';
  if (!phone && !website) return false; // nothing actionable

  const updates: Record<string, any> = {
    'enrichment.googlePlacesPm': {
      placeId: pick.place_id,
      name: communityName,
      phone: phone || null,
      website: website || null,
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (website) {
    updates.website = website;
    // Website found — this lead is no longer "under-marketed".
    updates.signals = admin.firestore.FieldValue.arrayRemove('no_website');
  }
  // Rename from the address-derived placeholder to the real community name.
  const looksLikePlaceholder = !lead.businessName || /^\d/.test(String(lead.businessName));
  if (communityName && looksLikePlaceholder) updates.businessName = communityName;

  await db.doc(`leads/${leadId}`).update(updates);

  // Add the leasing office as a contact (role 'google' = sourced from Places).
  if (phone) {
    await db.collection('leads').doc(leadId).collection('contacts').add({
      name: communityName ? `${communityName} Leasing Office` : 'Leasing Office',
      role: 'google',
      phone,
      source: 'google_places',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return true;
}

/** Batch-resolve PMs for multifamily leads that don't have one yet. */
export async function runMultifamilyPmJob(options?: { limit?: number }): Promise<MultifamilyPmResult> {
  const db = admin.firestore();
  const apiKey = googleMapsApiKeySecret.value();
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not configured');

  const limit = options?.limit ?? 200;
  const snap = await db.collection('leads').where('signals', 'array-contains', 'multifamily').limit(1000).get();

  let processed = 0;
  let matched = 0;
  let noMatch = 0;
  for (const doc of snap.docs) {
    if (processed >= limit) break;
    const lead = doc.data() as Record<string, any>;
    // Skip ones already resolved.
    if (lead.enrichment?.googlePlacesPm?.placeId) continue;
    processed++;
    try {
      const ok = await resolveOne(db, doc.id, lead, apiKey);
      if (ok) matched++;
      else noMatch++;
    } catch (err) {
      console.error(`Multifamily PM resolve failed for ${doc.id}:`, err);
      noMatch++;
    }
    await sleep(150);
  }
  return { processed, matched, noMatch };
}

/** Scheduled daily PM resolution for multifamily leads. */
export const enrichMultifamilyPm = onSchedule(
  { schedule: '30 8 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: [googleMapsApiKeySecret] },
  async () => {
    const result = await runMultifamilyPmJob();
    await admin.firestore().collection('runs').add({
      type: 'enrich_multifamily_pm',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
