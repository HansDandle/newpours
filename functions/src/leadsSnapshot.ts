/**
 * Leads snapshot — writes all leads as one gzipped JSON to Cloud Storage
 * (`cache/leads-summary.json.gz`, public + CDN-cached). The Leads page loads
 * that file over HTTP instead of scanning the whole `leads` collection, so a
 * page view costs ZERO Firestore reads.
 *
 * Fail-safe by design: the snapshot carries a `generatedAt` timestamp, and the
 * client falls back to a live Firestore read if it's missing or older than a
 * threshold. So a broken/skipped refresh costs more reads — never stale leads.
 *
 * Refreshed every 12h on a schedule AND right after any lead-mutating job, so
 * new/changed leads show up without waiting. Writes (operator tags, "running
 * ads", stage changes) always go to the live docs — this only affects reads.
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

/** Recursively convert Firestore Timestamps to epoch-ms so the JSON is portable. */
function deepSerialize(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value?.toMillis === 'function') return value.toMillis(); // Firestore Timestamp
  if (Array.isArray(value)) return value.map(deepSerialize);
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = deepSerialize(value[k]);
    return out;
  }
  return value;
}

export async function runGenerateLeadsSnapshot(): Promise<{ count: number; sizeBytes: number }> {
  const snap = await db.collection('leads').get();
  const leads = snap.docs.map((d) => ({ id: d.id, ...deepSerialize(d.data()) }));

  const payload = { generatedAt: Date.now(), count: leads.length, leads };
  const compressed = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));

  const file = admin.storage().bucket().file('cache/leads-summary.json.gz');
  await file.save(compressed, {
    metadata: {
      contentType: 'application/json',
      contentEncoding: 'gzip',
      cacheControl: 'public, max-age=300',
    },
  });
  await file.makePublic();

  console.log(`leadsSnapshot: wrote ${leads.length} leads, ${compressed.byteLength} bytes gzipped`);
  return { count: leads.length, sizeBytes: compressed.byteLength };
}

/** Scheduled refresh every 12h (the client falls back to live reads if it's ever stale). */
export const generateLeadsSnapshot = onSchedule(
  { schedule: '0 */12 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const r = await runGenerateLeadsSnapshot();
    await db.collection('runs').add({
      type: 'leads_snapshot',
      ...r,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
