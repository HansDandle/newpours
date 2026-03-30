import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const PLACE_DETAILS_FIELDS =
  "name,rating,user_ratings_total,price_level,formatted_phone_number,website,opening_hours,photos,geometry";

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authorization.slice(7));
    if (decoded.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let body: { establishmentId?: string; placeId?: string } = {};
  try { body = await request.json(); } catch { /* empty body */ }

  const { establishmentId, placeId } = body;
  if (!establishmentId || !placeId) {
    return NextResponse.json({ error: "establishmentId and placeId are required" }, { status: 400 });
  }

  const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!mapsApiKey) {
    return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not configured" }, { status: 500 });
  }

  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${PLACE_DETAILS_FIELDS}&key=${mapsApiKey}`
  );
  if (!res.ok) {
    return NextResponse.json({ error: `Places API error: ${res.status}` }, { status: 502 });
  }
  const data = await res.json();
  if (data.status !== "OK") {
    return NextResponse.json({ error: `Places API: ${data.status}` }, { status: 502 });
  }

  const detail = data.result ?? {};
  const db = getAdminDb();

  // Check for duplicate placeId across other docs
  const dupSnap = await db.collection("establishments")
    .where("googlePlaces.placeId", "==", placeId)
    .limit(2)
    .get();

  const googlePlacesData = {
    placeId,
    name: detail.name ?? "",
    rating: detail.rating ?? null,
    reviewCount: detail.user_ratings_total ?? null,
    priceLevel: detail.price_level ?? null,
    phoneNumber: detail.formatted_phone_number ?? null,
    phone: detail.formatted_phone_number ?? null,
    website: detail.website ?? null,
    hours: detail.opening_hours ?? null,
    openingHours: detail.opening_hours ?? null,
    photoReference: detail.photos?.[0]?.photo_reference ?? null,
    lat: detail.geometry?.location?.lat ?? null,
    lng: detail.geometry?.location?.lng ?? null,
    confidence: 1.0,
    matchedVia: "manual_override",
    matchedAt: FieldValue.serverTimestamp(),
  };

  const updates: Record<string, any> = {
    googlePlaces: googlePlacesData,
    lat: googlePlacesData.lat,
    lng: googlePlacesData.lng,
    "enrichment.googlePlaces": "complete",
    "enrichment.lastEnrichedAt": FieldValue.serverTimestamp(),
  };

  if (dupSnap.size > 0 && dupSnap.docs[0].id !== establishmentId) {
    updates.duplicateFlag = true;
    updates.duplicatePlaceId = placeId;
    await dupSnap.docs[0].ref.update({ duplicateFlag: true, duplicatePlaceId: placeId });
  }

  await db.collection("establishments").doc(establishmentId).set(updates, { merge: true });

  // Log the override
  await db.collection("system/enrichmentLogs/items").add({
    timestamp: FieldValue.serverTimestamp(),
    establishmentId,
    source: "googlePlaces",
    status: "success",
    confidence: 1.0,
    matchMethod: "manual_override",
    message: `Manual override accepted: ${detail.name ?? placeId}`,
  });

  return NextResponse.json({ ok: true, name: detail.name ?? placeId });
}
