/**
 * Run the TABC ingest manually against your real Firestore project.
 * Usage: node scripts/ingest-now.mjs
 *
 * Reads FIREBASE_ADMIN_* vars from .env.local automatically.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

// ── Firebase Admin ───────────────────────────────────────────────────────────
const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');

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

// ── Ingest ───────────────────────────────────────────────────────────────────
const TABC_ISSUED_API  = 'https://data.texas.gov/resource/7hf9-qc9f.json';
const TABC_PENDING_API = 'https://data.texas.gov/resource/mxm5-tdpj.json';
const LIMIT = 10000; // fetch the most recently issued records statewide

console.log(`Fetching up to ${LIMIT} issued licenses from TABC API (ordered by most recent)...`);
const res = await fetch(`${TABC_ISSUED_API}?$limit=${LIMIT}&$order=current_issued_date DESC`);
if (!res.ok) throw new Error(`TABC API error: ${res.status} ${res.statusText}`);
const data = await res.json();
console.log(`  Got ${data.length} records.`);

const snapshot = await db.collection('licenses').get();
const existing = new Set(snapshot.docs.map(d => d.id));
console.log(`  ${existing.size} licenses already in Firestore.`);

const { FieldValue } = await import('firebase-admin/firestore');

let added = 0;
let updated = 0;

// ── 1. Pending applications ──────────────────────────────────────────────────
console.log('\nFetching pending applications...');
const pendingRes = await fetch(`${TABC_PENDING_API}?$limit=${LIMIT}&$order=submission_date DESC`);
if (!pendingRes.ok) throw new Error(`Pending API error: ${pendingRes.status}`);
const pendingData = await pendingRes.json();
console.log(`  Got ${pendingData.length} pending application records.`);

for (const record of pendingData) {
  const id = `app-${record.applicationid}`;
  if (!record.applicationid) continue;
  const isExisting = existing.has(id);
  const payload = {
    licenseNumber: id,
    businessName: record.trade_name ?? record.owner ?? '',
    ownerName: record.owner ?? '',
    address: record.address ?? '',
    address2: record.address_2 ?? '',
    city: record.city ?? '',
    county: record.county ?? '',
    zipCode: (record.zip ?? '').slice(0, 5),
    licenseType: record.license_type ?? '',
    licenseTypeLabel: 'Pending Application',
    status: record.applicationstatus ?? 'Pending',
    applicationDate: record.submission_date ?? null,
    effectiveDate: null,
    expirationDate: null,
    tradeName: record.trade_name ?? '',
    phone: record.phone ?? '',
    winePercent: record.wine_percent ?? '',
    masterFileId: record.master_file_id ?? null,
    subordinateLicenseId: record.subordinate_license_id ?? null,
    primaryLicenseId: record.primary_license_id ?? null,
  };
  await db.collection('licenses').doc(id).set(
    isExisting
      ? payload
      : {
          ...payload,
          isNew: true,
          firstSeenAt: FieldValue.serverTimestamp(),
        },
    { merge: true }
  );
  if (isExisting) {
    updated++;
  } else {
    added++;
  }
  process.stdout.write(`\r  Added ${added} records, updated ${updated}...`);
}

// ── 2. Issued licenses ───────────────────────────────────────────────────────
console.log('\n\nFetching issued licenses...');
for (const record of data) {
  const id = `lic-${record.license_id}`;
  if (!record.license_id) continue;
  const isExisting = existing.has(id);
  const payload = {
    licenseNumber: id,
    businessName: record.trade_name ?? record.owner ?? '',
    ownerName: record.owner ?? '',
    address: record.address ?? '',
    address2: record.address_2 ?? '',
    city: record.city ?? '',
    county: record.county ?? '',
    zipCode: (record.zip ?? '').slice(0, 5),
    licenseType: record.license_type ?? '',
    licenseTypeLabel: record.tier ?? '',
    status: record.primary_status ?? '',
    tradeName: record.trade_name ?? '',
    phone: record.phone ?? '',
    winePercent: record.wine_percent ?? '',
    legacyClp: record.legacy_clp ?? '',
    secondaryStatus: record.secondary_status ?? '',
    subordinates: record.subordinates ?? '',
    statusChangeDate: record.status_change_date ?? null,
    masterFileId: record.master_file_id ?? null,
    mailAddress: record.mail_address ?? '',
    mailAddress2: record.mail_address_2 ?? '',
    mailCity: record.mail_city ?? '',
    mailZip: (record.mail_zip ?? '').slice(0, 5),
    originalIssueDate: record.original_issue_date ?? null,
    applicationDate: record.current_issued_date ?? null,
    effectiveDate: record.current_issued_date ?? null,
    expirationDate: record.expiration_date ?? null,
    newEstablishmentClassification: (() => {
      const sec = (record.secondary_status ?? '').toLowerCase();
      if (sec.includes('renew')) return 'RENEWAL';
      if (sec.includes('transfer') || sec.includes('change')) return 'TRANSFER_OR_CHANGE';
      const orig = record.original_issue_date ? new Date(record.original_issue_date).getTime() : null;
      const curr = record.current_issued_date ? new Date(record.current_issued_date).getTime() : null;
      const delta = (orig && curr) ? Math.abs(curr - orig) / 86400000 : null;
      if (delta !== null && delta > 120) return 'RENEWAL';
      if (!record.original_issue_date || delta === 0) return 'TRULY_NEW';
      return 'UNKNOWN';
    })(),
  };
  await db.collection('licenses').doc(id).set(
    isExisting
      ? payload
      : {
          ...payload,
          isNew: true,
          firstSeenAt: FieldValue.serverTimestamp(),
        },
    { merge: true }
  );
  if (isExisting) {
    updated++;
  } else {
    added++;
  }
  process.stdout.write(`\r  Added ${added} records, updated ${updated}...`);
}

// ── 3. Deduplication: remove pending apps that now have an issued license ────
// Case A (renewals): pending.primaryLicenseId matches an issued license_id.
// Case B (new apps): pending.masterFileId matches an issued master_file_id.
console.log('\n\nDeduplicating pending apps vs issued licenses...');
const pendingSnap = await db.collection('licenses')
  .where('licenseTypeLabel', '==', 'Pending Application')
  .get();
const issuedLicenseIds = new Set(data.map(r => r.license_id).filter(Boolean));
const issuedMasterFileIds = new Set(data.map(r => r.master_file_id).filter(Boolean));
// Fallback: match on owner + county + licenseType for permits without a master_file_id (e.g. NT)
const issuedOwnerKeys = new Set(
  data
    .map(r => `${(r.owner ?? '').trim().toLowerCase()}::${(r.county ?? '').trim().toLowerCase()}::${(r.license_type ?? '').trim().toLowerCase()}`)
    .filter(k => !k.startsWith('::'))
);
let deduped = 0;
for (const doc of pendingSnap.docs) {
  const d = doc.data();
  const byRenewal = d.primaryLicenseId && issuedLicenseIds.has(d.primaryLicenseId);
  const byMasterFile = d.masterFileId && issuedMasterFileIds.has(d.masterFileId);
  const ownerKey = `${(d.ownerName ?? '').trim().toLowerCase()}::${(d.county ?? '').trim().toLowerCase()}::${(d.licenseType ?? '').trim().toLowerCase()}`;
  const byOwner = !d.masterFileId && ownerKey.length > 2 && issuedOwnerKeys.has(ownerKey);
  if (byRenewal || byMasterFile || byOwner) {
    await doc.ref.delete();
    deduped++;
  }
}
if (deduped) console.log(`  Removed ${deduped} pending apps that now have an issued license.`);
else console.log('  No duplicates found.');

console.log(`\nDone. Added ${added} new licenses and updated ${updated} existing licenses.`);

await db.collection('runs').add({
  type: 'ingest-manual',
  count: added,
  updatedCount: updated,
  at: FieldValue.serverTimestamp(),
});
process.exit(0);
