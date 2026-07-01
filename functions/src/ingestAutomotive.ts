/**
 * Automotive ingest — car dealerships, collision/body shops, and independent
 * repair shops (tire, transmission, brake, general auto repair) as ad leads.
 * These are heavy local-radio advertisers but never appear in TABC/TABS.
 *
 * Same Google Places discovery pattern as the medical/home-services ingests
 * (trade × coverage city, review count as the established-advertiser proxy),
 * with one addition: the big national quick-lube / oil-change chains are
 * explicitly excluded — they buy media nationally, not from a local station,
 * and aren't the independent operators Sun Radio sells to.
 *
 * Records the Places result under enrichment.googlePlaces so the nightly
 * enrichLeadPlaces job skips these (no double-pay).
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { googleMapsApiKeySecret } from './enrich';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const MIN_REVIEWS = 150;
const MAX_LEADS = 2000;

// County-wide coverage across the 9 counties (shared with the other discovery ingests).
import { COVERAGE_CITY_COUNTY as CITY_COUNTY } from './coverageCities';

// Automotive segments that advertise locally: dealerships + collision + independent repair.
const AUTO_QUERIES = [
  'car dealership',
  'used car dealer',
  'auto repair shop',
  'collision center',
  'auto body shop',
  'tire shop',
  'transmission repair',
  'brake repair',
  'auto detailing',
  'muffler and brake shop',
];

// Big national quick-lube / oil-change chains — excluded. They advertise
// nationally, not on a local station, and aren't independent operators.
// Matched against the business name (case-insensitive).
const EXCLUDE_NAME = /\b(jiffy lube|valvoline|take 5|grease monkey|kwik kar|express oil|oil can henry|midas|meineke|mr\.? lube|pennzoil|havoline (?:xpress|express)|strickland|super lube|quick lube|quik lube|10 minute oil|5 minute oil|now oil|drive[- ]?time oil)\b/i;
// Also drop anything whose name is centered on oil changes (the segment the user excluded).
const OIL_CHANGE = /\boil change\b/i;

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

function parseAddress(formatted: string): { street: string; zip: string } {
  const parts = String(formatted ?? '').split(',').map((p) => p.trim());
  const zip = (String(formatted ?? '').match(/\b(\d{5})\b/) ?? [])[1] ?? '';
  return { street: parts[0] ?? '', zip };
}

export interface AutomotiveJobResult {
  queries: number;
  scanned: number;
  matched: number;
  created: number;
  excluded: number;
  pruned: number;
}

/** Discover established automotive businesses (>= minReviews, non-chain) and upsert each as a lead. */
export async function runAutomotiveJob(options?: {
  minReviews?: number;
  maxLeads?: number;
  county?: string;
  prune?: boolean;
}): Promise<AutomotiveJobResult> {
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
  let excluded = 0;

  for (const [city, county] of cities) {
    for (const trade of AUTO_QUERIES) {
      if (created >= maxLeads) break;
      queries++;
      let results: PlacesResult[];
      try {
        results = await textSearch(`${trade} ${city} TX`, apiKey);
      } catch (err) {
        console.error(`Automotive text search failed for "${trade} ${city}":`, err);
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

        // Drop the national quick-lube / oil-change chains before spending a details call.
        const rawName = r.name ?? '';
        if (EXCLUDE_NAME.test(rawName) || OIL_CHANGE.test(rawName)) {
          excluded++;
          continue;
        }
        matched++;

        const { street, zip } = parseAddress(r.formatted_address ?? '');
        if (!street) continue;

        let detail: PlaceDetail = {};
        try {
          detail = await placeDetails(placeId, apiKey);
          await sleep(110);
        } catch (err) {
          console.error(`Automotive place details failed for ${placeId}:`, err);
        }

        const name = detail.name || r.name || '';
        if (!name) continue;
        // Re-check the resolved name (details can return a fuller brand name).
        if (EXCLUDE_NAME.test(name) || OIL_CHANGE.test(name)) {
          excluded++;
          continue;
        }

        const phone = detail.formatted_phone_number ?? '';
        const website = detail.website ?? '';
        const rating = Number(r.rating ?? 0);

        const source: LeadSource = {
          type: 'automotive',
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
          console.error(`Automotive upsert failed for ${placeId}:`, err);
        }
      }
    }
  }

  // Prune automotive-only leads below the review bar (not worked, not operator-tagged).
  let pruned = 0;
  if (prune) {
    const snap = await db.collection('leads').where('category', '==', 'Automotive').get();
    let batch = db.batch();
    let ops = 0;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, any>;
      const srcs = (d.sources ?? []) as Array<{ type?: string }>;
      const onlyAuto = srcs.length > 0 && srcs.every((s) => s.type === 'automotive');
      const rc = Number(d.enrichment?.googlePlaces?.reviewCount ?? 0);
      const worked = (d.crm?.stage ?? 'new') !== 'new';
      const grouped = !!d.operator;
      if (onlyAuto && rc < minReviews && !worked && !grouped) {
        batch.delete(doc.ref);
        pruned++;
        if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
    }
    if (ops > 0) await batch.commit();
  }

  return { queries, scanned, matched, created, excluded, pruned };
}

/** Scheduled monthly automotive ingest. */
export const ingestAutomotive = onSchedule(
  { schedule: '0 15 2 * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: [googleMapsApiKeySecret] },
  async () => {
    const result = await runAutomotiveJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_automotive',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
