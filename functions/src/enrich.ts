import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

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

export const enrichLicense = functions.firestore
  .document('licenses/{licenseNumber}')
  .onCreate(async (snap) => {
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
