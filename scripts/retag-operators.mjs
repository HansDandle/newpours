/**
 * Re-tag the `operator` field on existing leads from the Firestore `operators`
 * registry. Touches ONLY lead.operator — never crm/sources/contacts — and skips
 * manually-locked leads. Also refreshes each operator's venueCount.
 *
 *   node scripts/retag-operators.mjs            # apply
 *   node scripts/retag-operators.mjs --dry      # report only
 *
 * Run `npm --prefix functions run build` first so the matcher is current.
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

const opsSnap = await db.collection('operators').get();
const operators = opsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
console.log(`${operators.length} operators. Reading leads…`);
const snap = await db.collection('leads').get();
console.log(`  ${snap.size} leads.`);

const counts = new Map();
let changed = 0;
let batch = db.batch();
let ops = 0;

for (const doc of snap.docs) {
  const d = doc.data();
  if (d.operatorLocked === true) {
    if (d.operator?.name) counts.set(d.operator.name, (counts.get(d.operator.name) ?? 0) + 1);
    continue;
  }
  const op = resolveOperator({ owner: d.ownerName, mailAddress: d.mailAddress, businessName: d.businessName }, operators);
  if (op) counts.set(op.name, (counts.get(op.name) ?? 0) + 1);
  if ((d.operator?.key ?? null) !== (op?.key ?? null)) {
    changed++;
    if (!DRY) {
      batch.update(doc.ref, { operator: op ?? null });
      if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
  }
}
if (!DRY && ops > 0) await batch.commit();

// Refresh venueCount on each operator.
if (!DRY) {
  let vb = db.batch(); let v = 0;
  for (const op of operators) {
    vb.set(db.collection('operators').doc(op.id), { venueCount: counts.get(op.name) ?? 0 }, { merge: true });
    if (++v >= 400) { await vb.commit(); vb = db.batch(); v = 0; }
  }
  if (v > 0) await vb.commit();
}

console.log(`\n${DRY ? '[dry] would change' : 'Changed'} operator on ${changed} lead(s).`);
for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${name}: ${n}`);
process.exit(0);
