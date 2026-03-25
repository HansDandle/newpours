/**
 * Daily Summary Snapshot — writes a lightweight gzip-compressed JSON of all
 * establishment summaries to Firebase Storage at `cache/establishments-summary.json.gz`.
 *
 * Dashboard and Explorer pages load from this Storage URL (CDN-cached) rather
 * than doing a full Firestore collection scan on every fresh page load. Full
 * establishment documents are only fetched when a user drills into a record.
 *
 * Schedule: nightly at 2 AM CST (after daily TABC ingest at 6 AM the prior day).
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import * as zlib from 'zlib';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function gzip(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    zlib.gzip(buf, (err, result) => (err ? reject(err) : resolve(result)))
  );
}

/** Fields included in the summary — enough for list views, filtering, and sorting */
export interface EstablishmentSummary {
  id: string;
  businessName: string;
  tradeName?: string;
  address: string;
  city: string;
  county: string;
  zipCode: string;
  licenseType: string;
  licenseTypeLabel: string;
  status: string;
  classification?: string;
  firstSeenAt?: number; // Unix ms for JSON serialization
  latestMonthRevenue?: number;
  avgMonthlyRevenue?: number;
  revenueTrend?: string;
  rating?: number;
  reviewCount?: number;
  website?: string;
  phone?: string;
  lat?: number;
  lng?: number;
  healthScore?: number;
  hasSignificantRecentWork?: boolean;
  vendorSignals?: string[];
  enrichmentComptroller?: string;
  enrichmentGooglePlaces?: string;
}

export async function runGenerateSummary(): Promise<{ count: number; sizeBytes: number }> {
  const snap = await db.collection('establishments').get();

  const summaries: EstablishmentSummary[] = snap.docs.map((docSnap) => {
    const d = docSnap.data();
    const firstSeenRaw = d.firstSeenAt;
    const firstSeenMs = typeof firstSeenRaw?.toDate === 'function'
      ? (firstSeenRaw.toDate() as Date).getTime()
      : typeof firstSeenRaw === 'string' ? new Date(firstSeenRaw).getTime() : undefined;

    return {
      id: docSnap.id,
      businessName: d.businessName ?? d.tradeName ?? '',
      tradeName: d.tradeName ?? undefined,
      address: d.address ?? '',
      city: d.city ?? '',
      county: d.county ?? '',
      zipCode: d.zipCode ?? '',
      licenseType: d.licenseType ?? '',
      licenseTypeLabel: d.licenseTypeLabel ?? '',
      status: d.status ?? '',
      classification: d.newEstablishmentClassification ?? undefined,
      firstSeenAt: Number.isFinite(firstSeenMs) ? firstSeenMs : undefined,
      latestMonthRevenue: d.comptroller?.latestMonthRevenue ?? d['comptroller.latestMonthRevenue'] ?? undefined,
      avgMonthlyRevenue: d.comptroller?.avgMonthlyRevenue ?? d['comptroller.avgMonthlyRevenue'] ?? undefined,
      revenueTrend: d.comptroller?.revenueTrend ?? d['comptroller.revenueTrend'] ?? undefined,
      rating: d.googlePlaces?.rating ?? undefined,
      reviewCount: d.googlePlaces?.reviewCount ?? undefined,
      website: d.googlePlaces?.website ?? undefined,
      phone: d.phone ?? d.googlePlaces?.phoneNumber ?? undefined,
      lat: d.googlePlaces?.lat ?? undefined,
      lng: d.googlePlaces?.lng ?? undefined,
      healthScore: d.healthInspection?.latestScore ?? undefined,
      hasSignificantRecentWork: d.buildingPermits?.hasSignificantRecentWork ?? undefined,
      vendorSignals: d.vendorSignals ?? undefined,
      enrichmentComptroller: d.enrichment?.comptroller ?? d['enrichment.comptroller'] ?? undefined,
      enrichmentGooglePlaces: d.enrichment?.googlePlaces ?? d['enrichment.googlePlaces'] ?? undefined,
    };
  });

  const json = JSON.stringify(summaries);
  const compressed = await gzip(Buffer.from(json, 'utf8'));

  const bucket = admin.storage().bucket();
  const file = bucket.file('cache/establishments-summary.json.gz');
  await file.save(compressed, {
    metadata: {
      contentType: 'application/json',
      contentEncoding: 'gzip',
      cacheControl: 'public, max-age=86400',
    },
  });

  // Make it publicly readable (read-only, no sensitive data)
  await file.makePublic();

  console.log(`generateSummary: wrote ${summaries.length} establishments, ${compressed.byteLength} bytes gzipped`);
  return { count: summaries.length, sizeBytes: compressed.byteLength };
}

export const generateDailySummary = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'America/Chicago' },
  async () => {
    const startedAt = Date.now();
    const result = await runGenerateSummary();
    await db.collection('system/jobRuns/items').add({
      jobName: 'generate_summary',
      startedAt: new Date(startedAt),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      durationMs: Date.now() - startedAt,
      status: 'success',
      recordsProcessed: result.count,
      notes: `Summary snapshot: ${result.count} establishments, ${result.sizeBytes} bytes gzipped`,
    });
  }
);
