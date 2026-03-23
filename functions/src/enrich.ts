import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

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

function addrSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
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
  mapsApiKey: string
): Promise<void> {
  const query = `"${businessName}" "${address}" "${city}" Texas`;

  // Text Search
  const searchRes = await fetch(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${mapsApiKey}`
  );
  const searchData = await searchRes.json();

  if (!searchData.results?.length) {
    await db.doc(`establishments/${docId}`).set(
      { 'enrichment.googlePlaces': 'no_match' },
      { merge: true }
    );
    await logEnrichment(docId, 'googlePlaces', 'skip', 'No results from Places Text Search');
    return;
  }

  const top = searchData.results[0];
  const placeName: string = top.name ?? '';
  const placeAddress: string = top.formatted_address ?? '';

  const nameSim = nameSimilarity(businessName, placeName);
  const addrSim = addrSimilarity(address, placeAddress);
  const confidence = nameSim * 0.6 + addrSim * 0.4;

  if (confidence < CONFIDENCE_THRESHOLD) {
    await db.doc(`establishments/${docId}`).set(
      { 'enrichment.googlePlaces': 'no_match' },
      { merge: true }
    );
    await logEnrichment(docId, 'googlePlaces', 'skip', `Confidence ${confidence.toFixed(2)} below threshold`, confidence, 'name+address');
    return;
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
    website: detail.website ?? null,
    hours: detail.opening_hours ?? null,
    photoReference: detail.photos?.[0]?.photo_reference ?? null,
    lat: detail.geometry?.location?.lat ?? top.geometry?.location?.lat ?? null,
    lng: detail.geometry?.location?.lng ?? top.geometry?.location?.lng ?? null,
    confidence,
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
  await logEnrichment(docId, 'googlePlaces', 'success', `Matched: ${placeName}`, confidence, 'name+address');
}

/** enrichNewEstablishment — triggered on new establishment doc creation */
export const enrichNewEstablishment = onDocumentCreated('establishments/{docId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  if (!data) return;

  const docId = snap.id;
  const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

  const licenseTypeLabel = LICENSE_TYPE_LABELS[data.licenseType] || data.licenseType || 'Unknown';
  const updates: Record<string, any> = { licenseTypeLabel };

  if (mapsApiKey) {
    try {
      await enrichWithGooglePlaces(
        docId,
        data.businessName ?? '',
        data.address ?? '',
        data.city ?? '',
        mapsApiKey
      );
    } catch (e: any) {
      console.error('Google Places enrichment failed:', e);
      await logEnrichment(docId, 'googlePlaces', 'error', e.message);
      await snap.ref.update({ 'enrichment.googlePlaces': 'error' });
    }
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

