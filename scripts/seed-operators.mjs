/**
 * Seed the Firestore `operators` collection. For each group, auto-derive its
 * HQ mailing-address pattern(s) by looking up its known venue names in the TABC
 * data (the same shared-mail-address signal that links a portfolio), then write
 * the operator doc. Run `npm --prefix functions run build` first.
 *
 *   node scripts/seed-operators.mjs --dry   # show derived patterns, no writes
 *   node scripts/seed-operators.mjs         # write operators
 *
 * Order matters: resolveOperator returns the FIRST match, so list confident /
 * specific groups before broader ones.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import matchPkg from '../functions/lib/match.js';
const { normalizeAddress, normalizeName } = matchPkg;

const DRY = process.argv.includes('--dry');

// name, aliases, venue keywords (normalized substrings of trade names), and
// optional explicit mail/owner patterns. Venue keywords drive auto-derivation.
const GROUPS = [
  { name: 'MML Hospitality', aliases: ['mml', 'mml hospitality', 'mcguire moorman', 'mcguire moorman lambert'],
    mail: ['1711 s congress'], venues: ['jeffrey', 'josephine house', 'perla', 'clark', 'lambert', 'elizabeth street', 'sammie', 'pecan square', 'swedish hill'] },
  { name: 'Hai Hospitality', aliases: ['hai', 'hai hospitality', 'tyson cole', 'uchi'],
    venues: ['uchi', 'uchiko', 'uchiba', 'oheya', 'loro'] },
  { name: 'Emmer & Rye Hospitality Group', aliases: ['emmer', 'emmer rye', 'kevin fink'],
    venues: ['emmer', 'hestia', 'canje', 'ezov', 'kalimotxo'] },
  { name: 'Guy + Larry Restaurants', aliases: ['guy larry', 'guy and larry'],
    venues: ['atx cocina', 'bulevar', 'roaring fork', 'salty sow'] },
  { name: 'Parkside Projects', aliases: ['parkside', 'fork garden', 'cirkiel', 'shawn cirkiel'],
    venues: ['parkside', 'backspace', 'olive and june', 'olive june'] },
  { name: 'New Waterloo', aliases: ['new waterloo'],
    venues: ['la condesa', 'condesa', 'otoko', 'maie day', 'south congress hotel'] },
  { name: 'La Corsha Hospitality Group', aliases: ['la corsha', 'corsha'],
    venues: ['mattie', 'green pastures', 'second bar', 'east austin hotel'] },
  { name: 'Bunkhouse Group', aliases: ['bunkhouse'],
    venues: ['hotel san jose', 'austin motel'] },
  { name: 'Excelsior Hospitality', aliases: ['excelsior', 'travis tober', 'nickel city'],
    venues: ['uncle nicky', 'murray', 'dirdie birdie', 'nickel city'] },
  { name: 'MaieB Hospitality', aliases: ['maieb', 'fojtasek', 'edgerton', 'olamaie'],
    venues: ['olamaie'] },
  // "este" omitted as a keyword — too short, substring-matches unrelated names.
  { name: 'Suerte Restaurant Group', aliases: ['suerte', 'bar toti', 'hellman mass', 'fermin nunez'],
    venues: ['suerte', 'bar toti', 'karaz'] },
  { name: 'Lenoir', aliases: ['lenoir', 'duplechan', 'jessica maher'],
    venues: ['lenoir', 'vixen'] },
  { name: 'TC4 & Co.', aliases: ['tc4', 'tony ciola', 'creed ford'],
    venues: ['mighty fine', 'league kitchen', 'tony c', 'cousin louie'] },
  { name: 'ELM Restaurant Group', aliases: ['elm', 'elm restaurant'],
    venues: ['24 diner', 'irene'] },
  { name: 'FBR Management', aliases: ['fbr', 'fbr management', '801 springdale'], mail: ['801 springdale'],
    venues: ['lavaca street bar', 'scoot inn', 'mean eyed cat', 'cain abel'] },
  { name: 'MoonlightATX', aliases: ['moonlightatx', 'moonlight atx', 'twin bar management', 'twin bar', 'dirty 6th'], mail: ['407 e 6th'],
    venues: ['thirsty nickel', 'toulouse', 'jackalope', 'dizzy rooster'] },
  // Leona Botanical Café & Bar — Dee Dee × Veracruz partnership (single, new venue).
  // Alias-only: too new to have a reliable TABC mailing-address cluster.
  { name: 'Leona Botanical', aliases: ['leona botanical', 'leona cafe'] },
  // Multi-location independent brands.
  { name: 'Veracruz All Natural', aliases: ['veracruz all natural', 'veracruz'], owner: ['veracruz'] },
  { name: 'Dee Dee', aliases: ['dee dee'], owner: ['dee dee'] },
  // Single-concept local chains — match by brand name (alias + owner), NOT
  // mailing address (locations mail to varied/airport-concession addresses).
  { name: 'Kerbey Lane Cafe', aliases: ['kerbey lane', 'kerbey'], owner: ['kerbey lane'] },
  { name: "Maudie's Tex-Mex", aliases: ['maudie'], owner: ['maudie'] },
  { name: 'Pluckers Wing Bar', aliases: ['pluckers'], owner: ['pluckers'] },
  { name: "Amy's Ice Creams", aliases: ["amy's ice cream", 'amy ice cream'], owner: ['amys ice cream'] },
  { name: 'Thundercloud Subs', aliases: ['thundercloud'], owner: ['thundercloud'] },
];

// ── load env + admin ─────────────────────────────────────────────────────────
for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i === -1) continue;
  const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[k]) process.env[k] = v;
}
const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
if (!getApps().length) initializeApp({ credential: cert({
  projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
  clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
}) });
const db = getFirestore();

// ── fetch TABC records to derive mailing-address patterns ────────────────────
const COUNTIES = ['TRAVIS', 'WILLIAMSON', 'HAYS', 'BASTROP', 'BURNET', 'GILLESPIE'];
const url = `https://data.texas.gov/resource/7hf9-qc9f.json?` + new URLSearchParams({
  '$select': 'trade_name,owner,mail_address,mail_city',
  '$where': `upper(county) in (${COUNTIES.map((c) => `'${c}'`).join(',')})`,
  '$limit': '50000',
});
console.log('Fetching TABC records to derive mail patterns…');
const records = await (await fetch(url)).json();
console.log(`  ${records.length} records.\n`);

function deriveMailPatterns(venues) {
  const tally = new Map();
  for (const r of records) {
    const nn = normalizeName(r.trade_name ?? r.owner ?? '');
    if (!venues.some((v) => nn.includes(normalizeName(v)))) continue;
    const core = normalizeAddress(r.mail_address ?? '');
    if (!core) continue;
    tally.set(core, (tally.get(core) ?? 0) + 1);
  }
  // keep mail cores that back at least 1 venue, most common first; cap at 3.
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([core]) => core);
}

// ── build + write ────────────────────────────────────────────────────────────
const existing = await db.collection('operators').get();
const byName = new Map(existing.docs.map((d) => [d.data().name, d.id]));

for (const g of GROUPS) {
  const derived = g.venues ? deriveMailPatterns(g.venues) : [];
  const mailPatterns = Array.from(new Set([...(g.mail ?? []), ...derived]));
  const doc = {
    name: g.name,
    aliases: g.aliases ?? [],
    mailPatterns,
    ownerPatterns: g.owner ?? [],
    updatedAt: FieldValue.serverTimestamp(),
  };
  console.log(`▶ ${g.name}`);
  console.log(`    mailPatterns: ${mailPatterns.join(' | ') || '(none — alias/owner match only)'}`);
  if (!DRY) {
    const id = byName.get(g.name);
    if (id) await db.collection('operators').doc(id).set(doc, { merge: true });
    else await db.collection('operators').add({ ...doc, venueCount: 0, createdAt: FieldValue.serverTimestamp() });
  }
}

console.log(`\n${DRY ? '[dry] ' : ''}${GROUPS.length} operators ${DRY ? 'previewed' : 'seeded'}.`);
process.exit(0);
