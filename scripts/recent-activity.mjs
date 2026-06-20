import { readFileSync } from 'fs';
import { resolve } from 'path';
for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i === -1) continue;
  const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[k]) process.env[k] = v;
}
const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
if (!getApps().length) initializeApp({ credential: cert({
  projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
  clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
}) });
const db = getFirestore();
const snap = await db.collection('runs').orderBy('at', 'desc').limit(20).get();
console.log('Most recent ingest/job runs:');
for (const d of snap.docs) {
  const r = d.data();
  const when = r.at?.toDate ? r.at.toDate().toISOString().slice(0, 16).replace('T', ' ') : '?';
  console.log(`  ${when}  ${r.type ?? '?'}${r.count != null ? `  (+${r.count})` : ''}${r.created != null ? `  created=${r.created}` : ''}`);
}
process.exit(0);
