import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
export const googleMapsApiKeySecret = defineSecret('GOOGLE_MAPS_API_KEY');

const CONFIDENCE_THRESHOLD = 0.85;

// License type code → human-readable label mapping
const LICENSE_TYPE_LABELS: Record<string, string> = {
  BQ: 'Beer/Ale - Retailer (Bar)',
  MB: 'Mixed Beverage',
  N: 'Wine & Beer Retailer',
  BF: 'Beer/Ale - Off-Premise (Package Store)',
  P: 'Private Club',
  CL: 'Caterer',
  LD: 'Late Hours (Bar)',
  GS: 'General Class B',
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|inc|lp|ltd|dba|corp|co\.?)\b/gi, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a), nb = normalizeName(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

function normalizeAddress(value: string): string {
  return value
    .toLowerCase()
    .split(',')[0]
    .replace(/\b(texas|tx|usa)\b/g, '')
    .replace(/\b(suite|ste|unit|apt|apartment|fl|floor|rm|room)\b/g, '')
    .replace(/\b(blvd)\b/g, 'boulevard')
    .replace(/\b(st)\b/g, 'street')
    .replace(/\b(rd)\b/g, 'road')
    .replace(/\b(dr)\b/g, 'drive')
    .replace(/\b(ln)\b/g, 'lane')
    .replace(/\b(ave)\b/g, 'avenue')
    .replace(/\b(hwy)\b/g, 'highway')
    .replace(/\b(pkwy)\b/g, 'parkway')
    .replace(/\b(n)\b/g, 'north')
    .replace(/\b(s)\b/g, 'south')
    .replace(/\b(e)\b/g, 'east')
    .replace(/\b(w)\b/g, 'west')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b\d{5}(?:\s*\d{4})?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityFromNormalized(left: string, right: string): number {
  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(left, right) / maxLen;
}

function addrSimilarity(a: string, b: string): number {
  const leftFull = normalizeAddress(a);
  const rightFull = normalizeAddress(b);
  const fullScore = similarityFromNormalized(leftFull, rightFull);

  const leftStreet = leftFull.split(',')[0]?.trim() ?? leftFull;
  const rightStreet = rightFull.split(',')[0]?.trim() ?? rightFull;
  const streetScore = similarityFromNormalized(leftStreet, rightStreet);

  return Math.max(fullScore, streetScore);
}

async function logEnrichment(
  id: string,
  source: string,
  status: 'success' | 'skip' | 'error',
  message: string,
  confidence?: number,
  matchMethod?: string
) {
  try {
    await db.collection('system/enrichmentLogs/items').add({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      establishmentId: id,
      source,
      status,
      confidence: confidence ?? null,
      matchMethod: matchMethod ?? null,
      message,
    });
  } catch (e) {
    console.error('Failed to write enrichment log', e);
  }
}

async function enrichWithGooglePlaces(
  docId: string,
  businessName: string,
  address: string,
  city: string,
  mapsApiKey: string,
  zipCode?: string,
  mailAddress?: string,
  mailCity?: string,
): Promise<'complete' | 'no_match'> {
  const queries = [
    `${businessName} ${address} ${city} Texas`,
    `${businessName} ${city} Texas`,
    `${businessName} ${address} Texas`,
  ];
  // Fallback: try mailing address (useful for event/temp permits where venue is a park)
  const mailQueries: string[] = [];
  if (mailAddress && mailCity) {
    mailQueries.push(`${businessName} ${mailAddress} ${mailCity}`);
    mailQueries.push(`${businessName} ${mailCity}`);
  }

  let searchData: any = null;
  let matchedVia: 'venue' | 'mail' = 'venue';
  for (const query of queries) {
    const searchRes = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${mapsApiKey}`
    );
    const candidate = await searchRes.json();

    const status = String(candidate?.status ?? 'UNKNOWN_ERROR');
    if (status === 'REQUEST_DENIED' || status === 'OVER_DAILY_LIMIT' || status === 'OVER_QUERY_LIMIT' || status === 'INVALID_REQUEST') {
      const message = candidate?.error_message ? `${status}: ${candidate.error_message}` : status;
      throw new Error(`Google Places Text Search failed (${message})`);
    }

    if (Array.isArray(candidate?.results) && candidate.results.length > 0) {
      searchData = candidate;
      break;
    }
  }

  // If venue address queries failed, try mailing address queries
  if (!searchData?.results?.length && mailQueries.length > 0) {
    for (const query of mailQueries) {
      const searchRes = await fetch(
        `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${mapsApiKey}`
      );
      const candidate = await searchRes.json();
      const status = String(candidate?.status ?? 'UNKNOWN_ERROR');
      if (status === 'REQUEST_DENIED' || status === 'OVER_DAILY_LIMIT' || status === 'OVER_QUERY_LIMIT' || status === 'INVALID_REQUEST') {
        const message = candidate?.error_message ? `${status}: ${candidate.error_message}` : status;
        throw new Error(`Google Places Text Search failed (${message})`);
      }
      if (Array.isArray(candidate?.results) && candidate.results.length > 0) {
        searchData = candidate;
        matchedVia = 'mail';
        break;
      }
    }
  }

  if (!searchData?.results?.length) {
    await db.doc(`establishments/${docId}`).set(
      { 'enrichment.googlePlaces': 'no_match' },
      { merge: true }
    );
    await logEnrichment(docId, 'googlePlaces', 'skip', 'No results from Places Text Search across fallback queries');
    return 'no_match';
  }

  const rankedCandidates = searchData.results
    .slice(0, 5)
    .map((candidate: any) => {
      const placeName: string = candidate.name ?? '';
      const placeAddress: string = candidate.formatted_address ?? '';
      const nameSim = nameSimilarity(businessName, placeName);
      // When matched via mailing address, score address similarity against the mail address
      // (not the venue address, which may be a park in a different city).
      const compareAddress = matchedVia === 'mail' ? (mailAddress ? `${mailAddress} ${mailCity}` : address) : address;
      const addrSim = addrSimilarity(compareAddress, placeAddress);
      const confidence = nameSim * 0.6 + addrSim * 0.4;
      const placeZip = (placeAddress.match(/\b(\d{5})\b/) ?? [])[1] ?? '';
      return { candidate, placeName, placeAddress, nameSim, addrSim, confidence, placeZip };
    })
    .sort((left: any, right: any) => right.confidence - left.confidence);

  const best = rankedCandidates[0];
  const top = best.candidate;
  const placeName: string = best.placeName;
  const confidence = best.confidence;

  // Override: zip match + strong signals is sufficient regardless of overall confidence.
  // For mail matches, use the mail zip code for the zip override check.
  const checkZip = matchedVia === 'mail' ? ((zipCode ?? '').trim() || '') : (zipCode ?? '').trim();
  const estZip = checkZip;
  const zipMatch = estZip.length === 5 && best.placeZip === estZip;
  const exactNameMatch = best.nameSim >= 0.99;
  const sameAddress = best.addrSim >= 0.80;
  // Accept if: (exact name + zip) OR (same address + zip) — different business name branding is common
  const overrideThreshold = zipMatch && (exactNameMatch || sameAddress);

  // When matching via mailing address the business name may differ from the venue name,
  // so use a lower confidence threshold and name-only matching.
  const effectiveThreshold = matchedVia === 'mail' ? 0.3 : CONFIDENCE_THRESHOLD;
  if (!overrideThreshold && confidence < effectiveThreshold) {
    await db.doc(`establishments/${docId}`).set(
      { 'enrichment.googlePlaces': 'no_match' },
      { merge: true }
    );
    await logEnrichment(
      docId,
      'googlePlaces',
      'skip',
      `Confidence ${confidence.toFixed(2)} below threshold (name=${best.nameSim.toFixed(2)}, address=${best.addrSim.toFixed(2)}, zip_match=${zipMatch})`,  
      confidence,
      'name+address'
    );
    return 'no_match';
  }

  // Place Details
  const placeId: string = top.place_id;
  const detailRes = await fetch(
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,user_ratings_total,price_level,formatted_phone_number,website,opening_hours,photos,geometry&key=${mapsApiKey}`
  );
  const detailData = await detailRes.json();
  const detail = detailData.result ?? {};

  const googlePlacesData = {
    placeId,
    name: detail.name ?? placeName,
    rating: detail.rating ?? null,
    reviewCount: detail.user_ratings_total ?? null,
    priceLevel: detail.price_level ?? null,
    phoneNumber: detail.formatted_phone_number ?? null,
    phone: detail.formatted_phone_number ?? null,
    website: detail.website ?? null,
    hours: detail.opening_hours ?? null,
    openingHours: detail.opening_hours ?? null,
    photoReference: detail.photos?.[0]?.photo_reference ?? null,
    lat: detail.geometry?.location?.lat ?? top.geometry?.location?.lat ?? null,
    lng: detail.geometry?.location?.lng ?? top.geometry?.location?.lng ?? null,
    confidence,
    matchedVia,
    matchedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Check for duplicate placeId across other docs
  const dupSnap = await db.collection('establishments')
    .where('googlePlaces.placeId', '==', placeId)
    .limit(2)
    .get();

  const updates: Record<string, any> = {
    googlePlaces: googlePlacesData,
    lat: googlePlacesData.lat,
    lng: googlePlacesData.lng,
    'enrichment.googlePlaces': 'complete',
    'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
  };

  if (dupSnap.size > 0 && dupSnap.docs[0].id !== docId) {
    updates.duplicateFlag = true;
    updates.duplicatePlaceId = placeId;
    console.warn(`Duplicate placeId ${placeId} — flagging ${docId} and ${dupSnap.docs[0].id}`);
    await dupSnap.docs[0].ref.update({ duplicateFlag: true, duplicatePlaceId: placeId });
  }

  await db.doc(`establishments/${docId}`).set(updates, { merge: true });
  await logEnrichment(docId, 'googlePlaces', 'success', `Matched: ${placeName} (via ${matchedVia} address)`, confidence, 'name+address');
  return 'complete';
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRevenueForMonth(estData: Record<string, any>, revenueMonth?: string): number | null {
  if (!revenueMonth) {
    const latest = Number(estData.comptroller?.latestMonthRevenue ?? estData['comptroller.latestMonthRevenue']);
    return Number.isFinite(latest) ? latest : null;
  }

  // Monthly records now live in the revenue subcollection; only latestMonthRevenue is on the parent.
  // For historical month lookups, return latestMonthRevenue if it matches; otherwise null.
  const latestMonth = String(estData.comptroller?.revenueDataThrough ?? estData['comptroller.revenueDataThrough'] ?? '');
  if (latestMonth === revenueMonth) {
    const latest = Number(estData.comptroller?.latestMonthRevenue ?? estData['comptroller.latestMonthRevenue']);
    return Number.isFinite(latest) ? latest : null;
  }

  return null;
}

export async function enrichGooglePlacesForEstablishment(
  establishmentId: string,
  estData: Record<string, any>,
  mapsApiKey = process.env.GOOGLE_MAPS_API_KEY
): Promise<'complete' | 'no_match' | 'error'> {
  const businessName = String(estData.businessName ?? estData.tradeName ?? '').trim();
  const address = String(estData.address ?? '').trim();
  const city = String(estData.city ?? '').trim();
  const zipCode = String(estData.zipCode ?? '').trim();
  let mailAddress = String(estData.mailAddress ?? '').trim();
  let mailCity = String(estData.mailCity ?? '').trim();

  // Pending application establishments docs are created by the backfill without mail address.
  // Fall back to the licenses collection (same doc ID) which may have it from the ingest.
  if (!mailAddress || !mailCity) {
    try {
      const licSnap = await db.doc(`licenses/${establishmentId}`).get();
      if (licSnap.exists) {
        const licData = licSnap.data() ?? {};
        if (!mailAddress) mailAddress = String(licData.mailAddress ?? '').trim();
        if (!mailCity) mailCity = String(licData.mailCity ?? '').trim();
      }
    } catch {
      // non-fatal — continue without mail address
    }
  }

  if (!mapsApiKey) {
    await db.doc(`establishments/${establishmentId}`).set(
      { 'enrichment.googlePlaces': 'error' },
      { merge: true }
    );
    await logEnrichment(establishmentId, 'googlePlaces', 'error', 'GOOGLE_MAPS_API_KEY is not configured');
    return 'error';
  }

  if (!businessName || !address || !city) {
    await db.doc(`establishments/${establishmentId}`).set(
      { 'enrichment.googlePlaces': 'no_match' },
      { merge: true }
    );
    await logEnrichment(establishmentId, 'googlePlaces', 'skip', 'Missing business name, address, or city');
    return 'no_match';
  }

  try {
    return await enrichWithGooglePlaces(establishmentId, businessName, address, city, mapsApiKey, zipCode, mailAddress, mailCity);
  } catch (e: any) {
    console.error('Google Places enrichment failed:', e);
    await logEnrichment(establishmentId, 'googlePlaces', 'error', e?.message ?? String(e));
    await db.doc(`establishments/${establishmentId}`).set(
      { 'enrichment.googlePlaces': 'error' },
      { merge: true }
    );
    return 'error';
  }
}

export async function runGooglePlacesJob(options?: {
  county?: string;
  lookbackMonths?: number;
  revenueMonth?: string;
  minRevenue?: number;
  onlyMissingGoogle?: boolean;
  establishmentIds?: string[];
}): Promise<{
  processed: number;
  complete: number;
  noMatch: number;
  error: number;
  skipped: number;
}> {
  const countyFilter = options?.county?.trim().toLowerCase();
  const lookbackMonths = options?.lookbackMonths ?? 24;
  const revenueMonth = options?.revenueMonth?.trim() || undefined;
  const minRevenue = Number.isFinite(options?.minRevenue) ? Number(options?.minRevenue) : undefined;
  const onlyMissingGoogle = options?.onlyMissingGoogle === true;
  const establishmentIdSet = Array.isArray(options?.establishmentIds)
    ? new Set(
      options.establishmentIds
        .map((id) => String(id ?? '').trim())
        .filter((id) => id.length > 0)
    )
    : null;
  const since = new Date();
  since.setMonth(since.getMonth() - lookbackMonths);

  const snapshot = await db.collection('establishments').get();

  let processed = 0;
  let complete = 0;
  let noMatch = 0;
  let error = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    if (establishmentIdSet && !establishmentIdSet.has(doc.id)) continue;

    const data = doc.data();
    const estCounty = String(data.county ?? '').trim().toLowerCase();
    if (countyFilter && estCounty !== countyFilter) continue;

    // Skip the date filter when targeting specific IDs — the caller explicitly wants those docs enriched.
    if (!establishmentIdSet) {
      const recordDate = toDate(data.applicationDate) ?? toDate(data.firstSeenAt) ?? toDate(data.effectiveDate);
      if (recordDate && recordDate < since) continue;
    }

    if (onlyMissingGoogle) {
      const currentGoogleStatus = String(data.enrichment?.googlePlaces ?? data['enrichment.googlePlaces'] ?? '').trim().toLowerCase();
      if (currentGoogleStatus === 'complete') {
        skipped++;
        continue;
      }
    }

    if (revenueMonth || minRevenue != null) {
      const revenueForMonth = getRevenueForMonth(data, revenueMonth);
      if (revenueForMonth == null || (minRevenue != null && revenueForMonth < minRevenue)) {
        skipped++;
        continue;
      }
    }

    const status = await enrichGooglePlacesForEstablishment(doc.id, data);
    processed++;
    if (status === 'complete') complete++;
    else if (status === 'no_match') noMatch++;
    else error++;
  }

  return { processed, complete, noMatch, error, skipped };
}

/** enrichNewEstablishment — triggered on new establishment doc creation */
export const enrichNewEstablishment = onDocumentCreated({
  document: 'establishments/{docId}',
  secrets: [googleMapsApiKeySecret],
}, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  if (!data) return;

  const docId = snap.id;
  const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

  const licenseTypeLabel = LICENSE_TYPE_LABELS[data.licenseType] || data.licenseType || 'Unknown';
  const updates: Record<string, any> = { licenseTypeLabel };

  if (mapsApiKey) {
    await enrichGooglePlacesForEstablishment(docId, data, mapsApiKey);
  } else {
    try {
      const address = `${data.address}, ${data.city}, TX ${data.zipCode}`;
      const geoRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=`
      );
      const geoData = await geoRes.json();
      if (geoData.results?.[0]?.geometry?.location) {
        updates.lat = geoData.results[0].geometry.location.lat;
        updates.lng = geoData.results[0].geometry.location.lng;
      }
    } catch (e) {
      console.error('Geocoding failed:', e);
    }
  }

  updates.enrichedAt = admin.firestore.FieldValue.serverTimestamp();
  await snap.ref.update(updates);
});

/** enrichLicense — legacy trigger on the licenses collection */
export const enrichLicense = onDocumentCreated('licenses/{licenseNumber}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  if (!data) return;

  const address = `${data.address}, ${data.city}, TX ${data.zipCode}`;
  const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

  let lat: number | null = null;
  let lng: number | null = null;

  if (mapsApiKey) {
    try {
      const geoRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${mapsApiKey}`
      );
      const geoData = await geoRes.json();
      if (geoData.results?.[0]?.geometry?.location) {
        lat = geoData.results[0].geometry.location.lat;
        lng = geoData.results[0].geometry.location.lng;
      }
    } catch (e) {
      console.error('Geocoding failed:', e);
    }
  }

  const licenseTypeLabel = LICENSE_TYPE_LABELS[data.licenseType] || data.licenseType || 'Unknown';

  await snap.ref.update({
    lat,
    lng,
    licenseTypeLabel,
    enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

