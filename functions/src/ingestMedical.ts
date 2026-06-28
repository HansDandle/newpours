/**
 * Medical facility ingest — hospitals, urgent care, ERs, imaging, surgery,
 * dental/ortho, LASIK/eye, dermatology, med spas, etc. as ad leads.
 *
 * These are heavy local advertisers but never show up in TABC/TABS, and the
 * federal NPPES registry has no size/quality signal. Since the goal is the
 * ESTABLISHED, advertising facilities, we discover them the same way as law
 * firms: Google Places text search per practice area × coverage city, using the
 * Google review count as the proxy for "established / advertises a lot." Only
 * facilities at/above the review threshold (default 100) are kept.
 *
 * Reuses the GOOGLE_MAPS_API_KEY secret + Places pattern from enrich.ts. The
 * Places result is recorded under enrichment.googlePlaces so the nightly
 * enrichLeadPlaces job skips these (no double-pay).
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { googleMapsApiKeySecret } from './enrich';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const MIN_REVIEWS = 500; // proxy for an established, advertising facility (tuned down the small-practice tail)
const MAX_LEADS = 2000;

// Coverage cities -> county (the core 8-county market).
const CITY_COUNTY: Record<string, string> = {
  'Austin': 'Travis', 'Pflugerville': 'Travis', 'Lakeway': 'Travis', 'Bee Cave': 'Travis',
  'Round Rock': 'Williamson', 'Cedar Park': 'Williamson', 'Georgetown': 'Williamson', 'Leander': 'Williamson',
  'Kyle': 'Hays', 'Buda': 'Hays', 'San Marcos': 'Hays', 'Dripping Springs': 'Hays',
  'Bastrop': 'Bastrop', 'Lockhart': 'Caldwell', 'Marble Falls': 'Burnet',
  'Fredericksburg': 'Gillespie', 'Johnson City': 'Blanco',
};

// Practice areas worth calling — the original four plus the widened set.
const MEDICAL_QUERIES = [
  'hospital',
  'urgent care',
  'emergency room',
  'imaging center',
  'surgery center',
  'dentist',
  'orthodontist',
  'dental implants',
  'lasik eye surgery',
  'optometrist',
  'dermatologist',
  'med spa',
  'plastic surgeon',
  'chiropractor',
  'physical therapy',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlacesResult {
  name?: string;
  formatted_address?: string;
  place_id?: string;
  rating?: number;
  user_ratings_total?: number;
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

/** Pull the street portion + zip out of a Google formatted_address. */
function parseAddress(formatted: string): { street: string; zip: string } {
  const parts = String(formatted ?? '').split(',').map((p) => p.trim());
  const zip = (String(formatted ?? '').match(/\b(\d{5})\b/) ?? [])[1] ?? '';
  return { street: parts[0] ?? '', zip };
}

export interface MedicalJobResult {
  queries: number;
  scanned: number;
  matched: number;
  created: number;
  pruned: number;
}

/**
 * Discover established medical facilities (>= minReviews) across the coverage
 * area and upsert each as a lead. With `prune`, removes medical-only leads that
 * fall below the review bar (e.g. leftovers from an earlier registry import).
 */
export async function runMedicalJob(options?: {
  minReviews?: number;
  maxLeads?: number;
  county?: string;
  prune?: boolean;
}): Promise<MedicalJobResult> {
  const db = admin.firestore();
  const apiKey = googleMapsApiKeySecret.value();
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not configured');

  const minReviews = options?.minReviews ?? MIN_REVIEWS;
  const maxLeads = options?.maxLeads ?? MAX_LEADS;
  const countyFilter = String(options?.county ?? '').trim().toLowerCase();
  const prune = options?.prune ?? true;

  const cities = Object.entries(CITY_COUNTY).filter(
    ([, county]) => !countyFilter || county.toLowerCase() === countyFilter
  );

  const operators = await loadOperators(db);
  const seen = new Set<string>(); // place_ids handled this run
  let queries = 0;
  let scanned = 0;
  let matched = 0;
  let created = 0;

  for (const [city, county] of cities) {
    for (const practice of MEDICAL_QUERIES) {
      if (created >= maxLeads) break;
      queries++;
      let results: PlacesResult[];
      try {
        results = await textSearch(`${practice} ${city} TX`, apiKey);
      } catch (err) {
        console.error(`Medical text search failed for "${practice} ${city}":`, err);
        continue;
      }
      await sleep(110);

      for (const r of results) {
        if (created >= maxLeads) break;
        scanned++;
        const placeId = r.place_id;
        if (!placeId || seen.has(placeId)) continue;
        seen.add(placeId);

        const reviews = Number(r.user_ratings_total ?? 0);
        if (reviews < minReviews) continue; // not established enough
        matched++;

        const { street, zip } = parseAddress(r.formatted_address ?? '');
        if (!street) continue;

        let detail: PlaceDetail = {};
        try {
          detail = await placeDetails(placeId, apiKey);
          await sleep(110);
        } catch (err) {
          console.error(`Medical place details failed for ${placeId}:`, err);
        }

        const phone = detail.formatted_phone_number ?? '';
        const website = detail.website ?? '';
        const rating = Number(r.rating ?? 0);
        const name = detail.name || r.name || '';
        if (!name) continue;

        const source: LeadSource = {
          type: 'medical_npi',
          sourceId: `gplace-${placeId}`,
          status: `${reviews.toLocaleString()} reviews${rating ? ` · ${rating}★` : ''}`,
          detailUrl: website || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
          raw: { placeId, rating, reviews, practiceArea: practice },
        };

        const contacts: SeedContact[] = [];
        if (phone) contacts.push({ name, role: 'google', phone, source: 'google_places' });

        try {
          const leadId = await upsertLead(
            db,
            {
              businessName: name,
              address: street,
              city,
              county,
              zipCode: zip,
              phones: phone ? [phone] : undefined,
              website: website || undefined,
            },
            source,
            contacts,
            operators
          );
          // Record the Places result so the nightly enrichLeadPlaces job skips it.
          await db.doc(`leads/${leadId}`).set(
            {
              enrichment: {
                googlePlaces: {
                  placeId, name, website: website || null, phone: phone || null,
                  rating: rating || null, reviewCount: reviews,
                  matchedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
              },
            },
            { merge: true }
          );
          created++;
          await sleep(50);
        } catch (err) {
          console.error(`Medical upsert failed for ${placeId}:`, err);
        }
      }
    }
  }

  // Prune medical-only leads below the review bar (e.g. an earlier registry import
  // with no review data) so the Medical pool is strictly established advertisers.
  let pruned = 0;
  if (prune) {
    const snap = await db.collection('leads').where('category', '==', 'Medical').get();
    let batch = db.batch();
    let ops = 0;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, any>;
      const srcs = (d.sources ?? []) as Array<{ type?: string }>;
      const onlyMedical = srcs.length > 0 && srcs.every((s) => s.type === 'medical_npi');
      const rc = Number(d.enrichment?.googlePlaces?.reviewCount ?? 0);
      if (onlyMedical && rc < minReviews) {
        batch.delete(doc.ref);
        pruned++;
        if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
    }
    if (ops > 0) await batch.commit();
  }

  return { queries, scanned, matched, created, pruned };
}

/** Scheduled monthly medical ingest. */
export const ingestMedical = onSchedule(
  { schedule: '0 12 2 * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: [googleMapsApiKeySecret] },
  async () => {
    const result = await runMedicalJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_medical',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
