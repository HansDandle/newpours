import { readFileSync } from 'fs';
import { resolve } from 'path';
for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  const k = t.slice(0, i).trim();
  const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[k]) process.env[k] = v;
}
const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
    clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }) });
}
const db = getFirestore();
const c = async (q) => (await q.count().get()).data().count;
console.log('Total leads:        ', await c(db.collection('leads')));
console.log('MML Hospitality:    ', await c(db.collection('leads').where('operator.key', '==', 'mml-hospitality')));
console.log('Construction (TABS):', await c(db.collection('leads').where('signals', 'array-contains', 'build_out')));
console.log('Event permits:      ', await c(db.collection('leads').where('signals', 'array-contains', 'event_upcoming')));
const snap = await db.collection('leads').where('signals', 'array-contains', 'build_out').limit(1).get();
if (!snap.empty) {
  const d = snap.docs[0].data();
  const cts = await snap.docs[0].ref.collection('contacts').get();
  console.log('\nSample TABS lead:', d.businessName, '|', [d.address, d.city].filter(Boolean).join(', '),
    '| contacts:', cts.size, '->', cts.docs.map((x) => x.data().phone).filter(Boolean).join(', '));
}
process.exit(0);
