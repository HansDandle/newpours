/**
 * Attorney ingest — successful law firms that advertise heavily as ad leads.
 *
 * Personal-injury, accident, DWI, and criminal-defense firms are the biggest
 * local advertisers (billboards, TV, radio, paid search), so they're prime
 * targets. There's no open registry of law firms, so we discover them via
 * Google Places Text Search across the coverage cities for the practice areas
 * that advertise the most, and use the firm's review count as the proxy for
 * size / marketing spend — a firm that blankets billboards also accumulates a
 * very high review count. Firms below the review threshold are skipped.
 *
 * Reuses the GOOGLE_MAPS_API_KEY secret + Places helpers pattern from enrich.ts.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { googleMapsApiKeySecret } from './enrich';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const MIN_REVIEWS = 100; // proxy for "advertises a lot" — heavy advertisers accrue lots of reviews
const MAX_LEADS = 500;

// Coverage cities -> county. Mirrors the nonprofit ingest's coverage counties
// (Travis, Williamson, Bastrop, Caldwell, Hays, Blanco, Burnet, Gillespie).
const CITY_COUNTY: Record<string, string> = {
  'Austin': 'Travis',
  'Pflugerville': 'Travis',
  'Lakeway': 'Travis',
  'Bee Cave': 'Travis',
  'Round Rock': 'Williamson',
  'Cedar Park': 'Williamson',
  'Georgetown': 'Williamson',
  'Leander': 'Williamson',
  'Kyle': 'Hays',
  'Buda': 'Hays',
  'San Marcos': 'Hays',
  'Dripping Springs': 'Hays',
  'Bastrop': 'Bastrop',
  'Lockhart': 'Caldwell',
  'Marble Falls': 'Burnet',
  'Fredericksburg': 'Gillespie',
  'Johnson City': 'Blanco',
};

// Practice areas whose firms advertise the most heavily.
const PRACTICE_QUERIES = [
  'personal injury attorney',
  'car accident lawyer',
  'truck accident lawyer',
  'injury lawyer',
  'DWI attorney',
  'criminal defense attorney',
  'workers compensation attorney',
  'wrongful death attorney',
  'motorcycle accident lawyer',
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

/** Pull the street portion + zip out of a Google formatted_address ("123 Main St, Austin, TX 78701, USA"). */
function parseAddress(formatted: string): { street: string; zip: string } {
  const parts = String(formatted ?? '').split(',').map((p) => p.trim());
  const zip = (String(formatted ?? '').match(/\b(\d{5})\b/) ?? [])[1] ?? '';
  return { street: parts[0] ?? '', zip };
}

export interface AttorneysJobResult {
  queries: number;
  scanned: number;
  matched: number;
  created: number;
}

/**
 * Discover advertising-heavy law firms across the coverage area and upsert each
 * as a lead. `minReviews` is the proxy gate for "advertises a lot".
 */
export async function runAttorneysJob(options?: {
  minReviews?: number;
  maxLeads?: number;
  county?: string;
}): Promise<AttorneysJobResult> {
  const db = admin.firestore();
  const apiKey = googleMapsApiKeySecret.value();
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not configured');

  const minReviews = options?.minReviews ?? MIN_REVIEWS;
  const maxLeads = options?.maxLeads ?? MAX_LEADS;
  const countyFilter = String(options?.county ?? '').trim().toLowerCase();

  const cities = Object.entries(CITY_COUNTY).filter(
    ([, county]) => !countyFilter || county.toLowerCase() === countyFilter
  );

  const operators = await loadOperators(db);
  const seen = new Set<string>(); // place_ids already handled this run
  let queries = 0;
  let scanned = 0;
  let matched = 0;
  let created = 0;

  for (const [city, county] of cities) {
    for (const practice of PRACTICE_QUERIES) {
      if (created >= maxLeads) break;
      queries++;
      let results: PlacesResult[];
      try {
        results = await textSearch(`${practice} ${city} TX`, apiKey);
      } catch (err) {
        console.error(`Attorney text search failed for "${practice} ${city}":`, err);
        continue;
      }
      await sleep(120);

      for (const r of results) {
        if (created >= maxLeads) break;
        scanned++;
        const placeId = r.place_id;
        if (!placeId || seen.has(placeId)) continue;
        seen.add(placeId);

        const reviews = Number(r.user_ratings_total ?? 0);
        if (reviews < minReviews) continue; // not a heavy advertiser
        matched++;

        const { street, zip } = parseAddress(r.formatted_address ?? '');
        if (!street) continue;

        let detail: PlaceDetail = {};
        try {
          detail = await placeDetails(placeId, apiKey);
          await sleep(120);
        } catch (err) {
          console.error(`Attorney place details failed for ${placeId}:`, err);
        }

        const phone = detail.formatted_phone_number ?? '';
        const website = detail.website ?? '';
        const rating = Number(r.rating ?? 0);
        const name = detail.name || r.name || '';
        if (!name) continue;

        const source: LeadSource = {
          type: 'attorney',
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
          // We already paid Google Places for this firm's details here — record it
          // in the shared enrichment shape so the nightly enrichLeadPlaces job skips
          // it instead of paying for a second text-search + details lookup.
          await db.doc(`leads/${leadId}`).set(
            {
              enrichment: {
                googlePlaces: {
                  placeId,
                  name,
                  website: website || null,
                  phone: phone || null,
                  rating: rating || null,
                  reviewCount: reviews,
                  matchedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
              },
            },
            { merge: true }
          );
          created++;
          await sleep(60);
        } catch (err) {
          console.error(`Attorney upsert failed for ${placeId}:`, err);
        }
      }
    }
  }

  return { queries, scanned, matched, created };
}

/** Scheduled monthly attorney ingest (firm rosters change slowly). */
export const ingestAttorneys = onSchedule(
  { schedule: '0 10 1 * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: [googleMapsApiKeySecret] },
  async () => {
    const result = await runAttorneysJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_attorneys',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
