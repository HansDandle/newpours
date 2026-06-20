/**
 * Backfill `recordDate` (most recent filing/registration date) on existing leads
 * so the free-tier recency gate works. Run `npm --prefix functions run build` first.
 *
 *   node scripts/backfill-recorddate.mjs [--dry]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import matchPkg from '../functions/lib/match.js';
const { recordDateOf } = matchPkg;

const DRY = process.argv.includes('--dry');

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i === -1) continue;
  const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[k]) process.env[k] = v;
}
const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
if (!getApps().length) initializeApp({ credential: cert({
  projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
  clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
}) });
const db = getFirestore();

const snap = await db.collection('leads').get();
console.log(`${snap.size} leads.`);
let set = 0, none = 0;
let batch = db.batch(); let ops = 0;
for (const doc of snap.docs) {
  const d = doc.data();
  const rd = recordDateOf(d.sources);
  if (!rd) { none++; continue; }
  set++;
  if (!DRY) {
    batch.update(doc.ref, { recordDate: Timestamp.fromDate(rd) });
    if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
}
if (!DRY && ops > 0) await batch.commit();
console.log(`${DRY ? '[dry] ' : ''}recordDate set on ${set} leads; ${none} had no source date.`);
process.exit(0);
