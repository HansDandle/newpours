/**
 * Home-services ingest — pest control, HVAC, roofing, plumbing, restoration, etc.
 * as ad leads. These are among the heaviest local radio advertisers, but they
 * never appear in TABC/TABS. Same approach as the medical/attorney ingests:
 * Google Places discovery by trade × coverage city, using the review count as
 * the proxy for an established, advertising company. Only companies at/above the
 * review threshold (default 250) are kept.
 *
 * Reuses the GOOGLE_MAPS_API_KEY secret + Places pattern from enrich.ts, and
 * records the Places result under enrichment.googlePlaces so the nightly
 * enrichLeadPlaces job skips these (no double-pay).
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { googleMapsApiKeySecret } from './enrich';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const MIN_REVIEWS = 250;
const MAX_LEADS = 2000;

// County-wide coverage across the 9 counties (shared with the other discovery ingests).
import { COVERAGE_CITY_COUNTY as CITY_COUNTY, parseCoverageAddress, resolveCoverageCity } from './coverageCities';

// The home-service trades that advertise the most heavily.
const HOME_SERVICE_QUERIES = [
  'pest control',
  'air conditioning repair',
  'roofing',
  'plumber',
  'foundation repair',
  'water damage restoration',
  'garage door repair',
  'window replacement',
  'solar company',
  'tree service',
  'landscaping',
  'electrician',
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

export interface HomeServicesJobResult {
  queries: number;
  scanned: number;
  matched: number;
  created: number;
  outOfArea: number;
  pruned: number;
}

/** Discover established home-services companies (>= minReviews) and upsert each as a lead. */
export async function runHomeServicesJob(options?: {
  minReviews?: number;
  maxLeads?: number;
  county?: string;
  prune?: boolean;
}): Promise<HomeServicesJobResult> {
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
    for (const trade of HOME_SERVICE_QUERIES) {
      if (created >= maxLeads) break;
      queries++;
      let results: PlacesResult[];
      try {
        results = await textSearch(`${trade} ${queryCity} TX`, apiKey);
      } catch (err) {
        console.error(`Home-services text search failed for "${trade} ${queryCity}":`, err);
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
          console.error(`Home-services place details failed for ${placeId}:`, err);
        }

        const phone = detail.formatted_phone_number ?? '';
        const website = detail.website ?? '';
        const rating = Number(r.rating ?? 0);
        const name = detail.name || r.name || '';
        if (!name) continue;

        const source: LeadSource = {
          type: 'home_services',
          sourceId: `gplace-${placeId}`,
          status: `${reviews.toLocaleString()} reviews${rating ? ` · ${rating}★` : ''}`,
          detailUrl: website || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
          raw: { placeId, rating, reviews, trade },
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
          console.error(`Home-services upsert failed for ${placeId}:`, err);
        }
      }
    }
  }

  // Prune home-services-only leads below the review bar.
  let pruned = 0;
  if (prune) {
    const snap = await db.collection('leads').where('category', '==', 'Home Services').get();
    let batch = db.batch();
    let ops = 0;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, any>;
      const srcs = (d.sources ?? []) as Array<{ type?: string }>;
      const onlyHome = srcs.length > 0 && srcs.every((s) => s.type === 'home_services');
      const rc = Number(d.enrichment?.googlePlaces?.reviewCount ?? 0);
      if (onlyHome && rc < minReviews) {
        batch.delete(doc.ref);
        pruned++;
        if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
    }
    if (ops > 0) await batch.commit();
  }

  return { queries, scanned, matched, created, outOfArea, pruned };
}

/** Scheduled monthly home-services ingest. */
export const ingestHomeServices = onSchedule(
  { schedule: '0 13 2 * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: [googleMapsApiKeySecret] },
  async () => {
    const result = await runHomeServicesJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_home_services',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
