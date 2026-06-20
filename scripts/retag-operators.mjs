/**
 * Re-tag the `operator` field on existing leads after the operator registry
 * changes. Touches ONLY lead.operator — never crm/sources/contacts.
 *
 *   node scripts/retag-operators.mjs            # apply
 *   node scripts/retag-operators.mjs --dry      # report only
 *
 * Run `npm --prefix functions run build` first so the compiled registry is current.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import operatorsPkg from '../functions/lib/operators.js';
const { resolveOperator } = operatorsPkg;

const DRY = process.argv.includes('--dry');

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

console.log('Reading leads…');
const snap = await db.collection('leads').get();
console.log(`  ${snap.size} leads.`);

const counts = new Map();
let changed = 0;
let batch = db.batch();
let ops = 0;

for (const doc of snap.docs) {
  const d = doc.data();
  const op = resolveOperator({ owner: d.ownerName, mailAddress: d.mailAddress, businessName: d.businessName });
  const curKey = d.operator?.key ?? null;
  const newKey = op?.key ?? null;
  if (curKey === newKey) continue;
  changed++;
  if (op) counts.set(op.name, (counts.get(op.name) ?? 0) + 1);
  if (!DRY) {
    batch.update(doc.ref, { operator: op ?? null });
    if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
}
if (!DRY && ops > 0) await batch.commit();

console.log(`\n${DRY ? '[dry] would change' : 'Changed'} operator on ${changed} lead(s).`);
for (const [name, n] of counts) console.log(`  ${name}: ${n}`);
process.exit(0);
