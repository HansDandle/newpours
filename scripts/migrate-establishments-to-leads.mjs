/**
 * One-time migration: fold every `establishments` doc into the unified `leads`
 * collection as a `tabc` (or `tabc_event`) source, carrying enrichment over.
 * Idempotent — keyed by leadKey(name,address); safe to re-run. Multiple
 * establishments at the same business merge into one lead.
 *
 * Usage:
 *   node scripts/migrate-establishments-to-leads.mjs           # write
 *   node scripts/migrate-establishments-to-leads.mjs --dry     # report only
 *
 * Reuses the compiled match helpers (run `npm --prefix functions run build` first).
 * Reads FIREBASE_ADMIN_* from .env.local.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── compiled, shared dedupe/merge helpers (single source of truth) ───────────
import matchPkg from '../functions/lib/match.js';
const { leadKey, computeSignals, mergeSources, unionStrings } = matchPkg;
import operatorsPkg from '../functions/lib/operators.js';
const { resolveOperator } = operatorsPkg;

const DRY = process.argv.includes('--dry');
const EVENT_LICENSE_TYPES = new Set(['ET', 'NT', 'TR', 'NB', 'NE']);

// ── Load .env.local ──────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[key]) process.env[key] = val;
}

const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore();

const firstNonEmpty = (...vals) => {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return undefined;
};

console.log('Reading establishments…');
const snap = await db.collection('establishments').get();
console.log(`  ${snap.size} establishments.`);

// Aggregate in memory so multiple establishments collapse onto one lead.
const leads = new Map(); // leadId -> { doc, contacts: Map(phone->contact) }

for (const docSnap of snap.docs) {
  const e = docSnap.data();
  const businessName = firstNonEmpty(e.businessName, e.tradeName, e.ownerName) ?? 'Unnamed Venue';
  const address = String(e.address ?? '').trim();
  if (!address) continue;

  const id = leadKey(businessName, address);
  const isEvent = EVENT_LICENSE_TYPES.has(String(e.licenseType ?? '').toUpperCase());
  const website = firstNonEmpty(e.googlePlaces?.website);
  const phone = firstNonEmpty(e.googlePlaces?.phoneNumber, e.phone);
  const mailAddress = firstNonEmpty(e.mailAddress);
  const operator = resolveOperator({ owner: e.ownerName, mailAddress, businessName });

  const source = {
    type: isEvent ? 'tabc_event' : 'tabc',
    sourceId: e.licenseNumber ?? docSnap.id,
    status: e.status ?? null,
    registeredDate: null,
    openingDate: e.effectiveDate ?? e.applicationDate ?? null,
    estimatedCost: null,
    licenseType: e.licenseType ?? null,
    raw: { classification: e.newEstablishmentClassification ?? null },
  };

  const enrichment = {};
  for (const k of ['googlePlaces', 'comptroller', 'healthInspection', 'buildingPermits', 'propertyData', 'enrichment']) {
    if (e[k] != null) enrichment[k] = e[k];
  }

  let entry = leads.get(id);
  if (!entry) {
    entry = {
      doc: {
        businessName,
        dba: null,
        ownerName: e.ownerName ?? null,
        operator: operator ?? null,
        mailAddress: mailAddress ?? null,
        address,
        city: e.city ?? null,
        county: e.county ?? null,
        zipCode: e.zipCode ?? null,
        phones: [],
        emails: [],
        website: website ?? null,
        sources: [],
        signals: [],
        enrichment,
        crm: { stage: 'new', assignedTo: null, followUpDate: null },
      },
      contacts: new Map(),
    };
    leads.set(id, entry);
  }

  const d = entry.doc;
  d.businessName = firstNonEmpty(d.businessName, businessName) ?? d.businessName;
  d.ownerName = firstNonEmpty(d.ownerName, e.ownerName) ?? d.ownerName;
  d.operator = d.operator ?? operator ?? null;
  d.mailAddress = firstNonEmpty(d.mailAddress, mailAddress) ?? d.mailAddress ?? null;
  d.city = firstNonEmpty(d.city, e.city) ?? d.city;
  d.county = firstNonEmpty(d.county, e.county) ?? d.county;
  d.zipCode = firstNonEmpty(d.zipCode, e.zipCode) ?? d.zipCode;
  d.website = firstNonEmpty(d.website, website) ?? d.website;
  d.phones = unionStrings(d.phones, [phone]);
  d.emails = unionStrings(d.emails, [e.email]);
  d.sources = mergeSources(d.sources, source);
  d.enrichment = { ...d.enrichment, ...enrichment };

  // Seed contacts
  const seed = (c) => {
    const key = (c.phone || c.email || c.name || '').toString().trim();
    if (key && !entry.contacts.has(key)) entry.contacts.set(key, c);
  };
  if (phone || e.ownerName) seed({ name: e.ownerName ?? null, role: 'owner', phone: phone ?? null, source: 'tabc' });
}

// finalize signals
for (const entry of leads.values()) {
  entry.doc.signals = computeSignals({ sources: entry.doc.sources, website: entry.doc.website });
}

console.log(`Aggregated into ${leads.size} unique leads (from ${snap.size} establishments).`);
if (DRY) {
  const withMulti = [...leads.values()].filter((l) => l.doc.sources.length > 1).length;
  console.log(`  ${withMulti} leads merge 2+ source records.`);
  const opCounts = new Map();
  for (const l of leads.values()) {
    if (l.doc.operator) opCounts.set(l.doc.operator.name, (opCounts.get(l.doc.operator.name) ?? 0) + 1);
  }
  console.log(`  Operator-tagged leads:`);
  if (opCounts.size === 0) console.log('    (none)');
  else for (const [name, n] of opCounts) console.log(`    ${name}: ${n}`);
  console.log('Dry run — no writes.');
  process.exit(0);
}

let written = 0;
let batch = db.batch();
let ops = 0;
for (const [id, entry] of leads) {
  const ref = db.collection('leads').doc(id);
  batch.set(
    ref,
    { ...entry.doc, firstSeenAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  ops++;
  for (const c of entry.contacts.values()) {
    const cid = c.phone ? `phone_${String(c.phone).replace(/[^0-9]/g, '')}` : `name_${String(c.name ?? 'x').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    batch.set(ref.collection('contacts').doc(cid), { ...c, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    ops++;
  }
  // Firestore batch cap is 500 ops
  if (ops >= 400) {
    await batch.commit();
    batch = db.batch();
    ops = 0;
  }
  written++;
  process.stdout.write(`\r  wrote ${written}/${leads.size} leads…`);
}
if (ops > 0) await batch.commit();

console.log(`\nDone. Wrote ${written} leads.`);
process.exit(0);
