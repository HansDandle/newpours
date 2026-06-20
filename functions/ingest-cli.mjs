/**
 * Command-line ingest — runs the same lead ingest as the scheduled functions,
 * against live Firestore, using the FIREBASE_ADMIN_* creds in ../.env.local.
 *
 * Lives in functions/ so it resolves the SAME firebase-admin + compiled job
 * code (./lib/*) that the deployed functions use.
 *
 * Usage:
 *   node functions/ingest-cli.mjs tabs [--counties Travis,Williamson,Hays] [--days 45] [--min-cost 0]
 *   node functions/ingest-cli.mjs tabc [--county Travis] [--days 180]
 *   node functions/ingest-cli.mjs all
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load ../.env.local
for (const line of readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  const k = t.slice(0, i).trim();
  const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[k]) process.env[k] = v;
}

// Initialize admin BEFORE importing compiled jobs (they skip init if an app exists).
const admin = (await import('firebase-admin')).default;
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

const TABC_ISSUED = 'https://data.texas.gov/resource/7hf9-qc9f.json';
const TABC_PENDING = 'https://data.texas.gov/resource/mxm5-tdpj.json';

function classifyIssued(r) {
  const sec = (r.secondary_status ?? '').toLowerCase();
  if (sec.includes('renew')) return 'RENEWAL';
  if (sec.includes('transfer') || sec.includes('change')) return 'TRANSFER_OR_CHANGE';
  const orig = r.original_issue_date ? new Date(r.original_issue_date).getTime() : null;
  const curr = r.current_issued_date ? new Date(r.current_issued_date).getTime() : null;
  const delta = orig && curr ? Math.abs(curr - orig) / 86400000 : null;
  if (delta !== null && delta > 120) return 'RENEWAL';
  if (!r.original_issue_date || delta === 0) return 'TRULY_NEW';
  return 'UNKNOWN';
}

async function runTabc({ county, days }) {
  const { upsertTabcLead } = await import('./lib/tabcLeads.js');
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString().slice(0, 19);
  const countyClause = county ? ` AND upper(county)=upper('${county.replace(/'/g, "''")}')` : '';

  let created = 0;
  // Pending applications
  const pRes = await fetch(`${TABC_PENDING}?$limit=10000&$order=submission_date DESC&$where=submission_date>='${sinceIso}'${countyClause}`);
  const pending = await pRes.json();
  for (const r of pending) {
    if (!r.applicationid) continue;
    await upsertTabcLead(db, {
      id: `app-${r.applicationid}`,
      businessName: r.trade_name ?? r.owner ?? '',
      ownerName: r.owner ?? '',
      address: r.address ?? '',
      mailAddress: r.mail_address ?? '',
      city: r.city ?? '',
      county: r.county ?? '',
      zip: (r.zip ?? '').slice(0, 5),
      phone: r.phone ?? '',
      licenseType: r.license_type ?? '',
      status: r.applicationstatus ?? 'Pending',
      effectiveDate: null,
      classification: r.primary_license_id ? 'RENEWAL' : 'PENDING_NEW',
    });
    created++;
    if (created % 50 === 0) process.stdout.write(`\r  TABC pending processed ${created}…`);
  }
  // Issued licenses
  const iRes = await fetch(`${TABC_ISSUED}?$limit=10000&$order=current_issued_date DESC&$where=current_issued_date>='${sinceIso}'${countyClause}`);
  const issued = await iRes.json();
  for (const r of issued) {
    if (!r.license_id) continue;
    await upsertTabcLead(db, {
      id: `lic-${r.license_id}`,
      businessName: r.trade_name ?? r.owner ?? '',
      ownerName: r.owner ?? '',
      address: r.address ?? '',
      mailAddress: r.mail_address ?? '',
      city: r.city ?? '',
      county: r.county ?? '',
      zip: (r.zip ?? '').slice(0, 5),
      phone: r.phone ?? '',
      licenseType: r.license_type ?? '',
      status: r.primary_status ?? '',
      effectiveDate: r.current_issued_date ?? null,
      classification: classifyIssued(r),
    });
    created++;
    if (created % 50 === 0) process.stdout.write(`\r  TABC processed ${created}…`);
  }
  process.stdout.write('\n');
  return created;
}

async function runTabs() {
  const { runTabsJob } = await import('./lib/ingestTabs.js');
  const counties = flag('counties', '').split(',').map((s) => s.trim()).filter(Boolean);
  const result = await runTabsJob({
    counties: counties.length ? counties : undefined,
    days: Number(flag('days', '45')),
    minCost: Number(flag('min-cost', '0')),
    maxDetails: Number(flag('max', '5000')),
  });
  return result;
}

// ── dispatch ────────────────────────────────────────────────────────────────
if (cmd === 'tabs' || cmd === 'all') {
  console.log('Running TABS construction-permit ingest…');
  const r = await runTabs();
  console.log(`  TABS: created/updated ${r.created} lead(s) from ${r.processed} permit(s) (${r.failed} failed) across ${r.counties.join('/')}`);
}
if (cmd === 'tabc' || cmd === 'all') {
  console.log('Running TABC license ingest…');
  const n = await runTabc({ county: flag('county', ''), days: Number(flag('days', '180')) });
  console.log(`  TABC: upserted ${n} record(s) into leads (new/event only).`);
}
if (!['tabs', 'tabc', 'all'].includes(cmd)) {
  console.log('Usage: node functions/ingest-cli.mjs <tabs|tabc|all> [--counties a,b] [--county X] [--days N] [--min-cost N]');
  process.exit(1);
}

await db.collection('runs').add({ type: `ingest_cli_${cmd}`, at: admin.firestore.FieldValue.serverTimestamp() });
console.log('Done.');
process.exit(0);
