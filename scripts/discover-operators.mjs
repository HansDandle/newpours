/**
 * Discover restaurant/bar GROUPS operating in the target counties by clustering
 * TABC records on shared HQ mailing address (the signal that linked MML).
 *
 *   node scripts/discover-operators.mjs
 *
 * A mailing address with several DISTINCT trade names = a likely operator.
 * Very large clusters (dozens of unrelated names) are flagged as probable
 * registered agents / filing services to ignore.
 */
import matchPkg from '../functions/lib/match.js';
const { normalizeAddress, normalizeName } = matchPkg;

const COUNTIES = ['TRAVIS', 'WILLIAMSON', 'HAYS', 'BASTROP', 'BURNET', 'GILLESPIE'];
const ISSUED = 'https://data.texas.gov/resource/7hf9-qc9f.json';

const where = `upper(county) in (${COUNTIES.map((c) => `'${c}'`).join(',')})`;
const params = new URLSearchParams({
  '$select': 'owner,trade_name,mail_address,mail_city,county,city,license_type',
  '$where': where,
  '$limit': '50000',
});

console.log(`Fetching TABC issued records for ${COUNTIES.length} counties…`);
const res = await fetch(`${ISSUED}?${params}`);
const rows = await res.json();
console.log(`  ${rows.length} records.\n`);

// Cluster by normalized mailing address + mail city.
const clusters = new Map();
for (const r of rows) {
  const mail = String(r.mail_address ?? '').trim();
  if (!mail) continue;
  const key = `${normalizeAddress(mail)}::${String(r.mail_city ?? '').toLowerCase().trim()}`;
  if (key.startsWith('::')) continue;
  let c = clusters.get(key);
  if (!c) {
    c = { mail, mailCity: r.mail_city ?? '', brands: new Map(), counties: new Set(), owners: new Set() };
    clusters.set(key, c);
  }
  const brand = String(r.trade_name ?? r.owner ?? '').trim();
  const nb = normalizeName(brand);
  if (nb && !c.brands.has(nb)) c.brands.set(nb, brand);
  if (r.county) c.counties.add(r.county);
  if (r.owner) c.owners.add(String(r.owner).trim());
}

const ranked = [...clusters.values()]
  .map((c) => ({ ...c, brandCount: c.brands.size }))
  .filter((c) => c.brandCount >= 3)
  .sort((a, b) => b.brandCount - a.brandCount);

const groups = ranked.filter((c) => c.brandCount <= 25);
const mega = ranked.filter((c) => c.brandCount > 25);

console.log(`=== LIKELY OPERATOR GROUPS (3–25 distinct brands at one mailing address) ===\n`);
for (const c of groups.slice(0, 50)) {
  const brands = [...c.brands.values()];
  console.log(`▶ ${c.brandCount} brands · mail: ${c.mail}, ${c.mailCity} · counties: ${[...c.counties].join(', ')}`);
  console.log(`    brands: ${brands.slice(0, 12).join(' | ')}${brands.length > 12 ? ` … +${brands.length - 12} more` : ''}`);
  console.log(`    owners: ${[...c.owners].slice(0, 6).join(' / ')}\n`);
}

console.log(`\n=== MEGA CLUSTERS (>25 brands — likely registered agents / filing services, ignore) ===`);
for (const c of mega.slice(0, 15)) {
  console.log(`  ${c.brandCount} brands · ${c.mail}, ${c.mailCity}`);
}
process.exit(0);
