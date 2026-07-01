/**
 * Food & Drink discovery — established restaurants/bars (200+ reviews) as ad
 * leads, plus a cleanup of the raw TABC-license dump in the leads pool.
 *
 * The TABC ingest drops *every* new alcohol license into the leads pool, which
 * buries the signal with brand-new, no-track-record places. The new-business
 * intel still lives in the alert feed (licenses/establishments) — so here we:
 *   1. Discover the genuinely established restaurants/bars via Google Places,
 *      gated to 200+ reviews (the advertising-worthy ones), and
 *   2. Prune leads whose ONLY source is a TABC license and that fall below the
 *      bar — while preserving anything you've worked (stage moved off "new") or
 *      that belongs to a tracked operator group.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { googleMapsApiKeySecret } from './enrich';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const MIN_REVIEWS = 200;
const MAX_LEADS = 2000;

// County-wide coverage across the 9 counties (shared with the other discovery ingests).
import { COVERAGE_CITY_COUNTY as CITY_COUNTY, parseCoverageAddress, resolveCoverageCity } from './coverageCities';

const FOOD_QUERIES = [
  'restaurant',
  'bar',
  'brewery',
  'bbq',
  'mexican restaurant',
  'italian restaurant',
  'steakhouse',
  'seafood restaurant',
  'sports bar',
  'coffee shop',
  'winery',
  'pizza',
];

// A lead that is ONLY these source types is a raw TABC-license record.
const TABC_ONLY = new Set(['tabc', 'tabc_event']);

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

export interface FoodDrinkJobResult {
  queries: number;
  scanned: number;
  matched: number;
  created: number;
  outOfArea: number;
  pruned: number;
}

/** Discover established restaurants/bars and prune the raw TABC-license dump. */
export async function runFoodDrinkJob(options?: {
  minReviews?: number;
  maxLeads?: number;
  county?: string;
  prune?: boolean;
}): Promise<FoodDrinkJobResult> {
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
  const seen = new Set<string>();
  let queries = 0;
  let scanned = 0;
  let matched = 0;
  let created = 0;
  let outOfArea = 0;

  for (const [queryCity] of cities) {
    for (const cuisine of FOOD_QUERIES) {
      if (created >= maxLeads) break;
      queries++;
      let results: PlacesResult[];
      try {
        results = await textSearch(`${cuisine} ${queryCity} TX`, apiKey);
      } catch (err) {
        console.error(`Food/drink text search failed for "${cuisine} ${queryCity}":`, err);
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
        if (reviews < minReviews) continue;

        const { street, city: rawCity, zip } = parseCoverageAddress(r.formatted_address ?? '');
        if (!street) continue;

        // Keep only businesses whose ACTUAL address city is inside coverage; tag
        // them with their true city/county (Google returns statewide matches).
        const coverage = resolveCoverageCity(rawCity);
        if (!coverage) { outOfArea++; continue; }
        const city = coverage.city;
        const county = coverage.county;
        matched++;

        let detail: PlaceDetail = {};
        try {
          detail = await placeDetails(placeId, apiKey);
          await sleep(110);
        } catch (err) {
          console.error(`Food/drink place details failed for ${placeId}:`, err);
        }

        const phone = detail.formatted_phone_number ?? '';
        const website = detail.website ?? '';
        const rating = Number(r.rating ?? 0);
        const name = detail.name || r.name || '';
        if (!name) continue;

        const source: LeadSource = {
          type: 'food_drink',
          sourceId: `gplace-${placeId}`,
          status: `${reviews.toLocaleString()} reviews${rating ? ` · ${rating}★` : ''}`,
          detailUrl: website || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
          raw: { placeId, rating, reviews, query: cuisine },
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
          console.error(`Food/drink upsert failed for ${placeId}:`, err);
        }
      }
    }
  }

  // Prune the raw TABC-license dump: leads whose ONLY source is a TABC license,
  // below the review bar, NOT worked (stage still "new"), and NOT operator-tagged.
  let pruned = 0;
  if (prune) {
    const snap = await db.collection('leads').get();
    let batch = db.batch();
    let ops = 0;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, any>;
      const srcs = (d.sources ?? []) as Array<{ type?: string }>;
      const onlyTabc = srcs.length > 0 && srcs.every((s) => TABC_ONLY.has(String(s.type)));
      if (!onlyTabc) continue;
      const rc = Number(d.enrichment?.googlePlaces?.reviewCount ?? 0);
      const worked = (d.crm?.stage ?? 'new') !== 'new';
      const grouped = !!d.operator;
      if (rc < minReviews && !worked && !grouped) {
        batch.delete(doc.ref);
        pruned++;
        if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
    }
    if (ops > 0) await batch.commit();
  }

  return { queries, scanned, matched, created, outOfArea, pruned };
}

/** Scheduled monthly food & drink discovery + TABC-dump cleanup. */
export const ingestFoodDrink = onSchedule(
  { schedule: '0 14 2 * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: [googleMapsApiKeySecret] },
  async () => {
    const result = await runFoodDrinkJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_food_drink',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
