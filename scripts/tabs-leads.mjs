#!/usr/bin/env node
/**
 * TABS lead scraper — TDLR Architectural Barriers project registrations.
 *
 * WHY: A TABS registration is filed when a business does a >$50k build-out,
 * typically 6–12 months before opening, and the public record includes the
 * owner + tenant names and PHONE NUMBERS. That's an early, contactable lead —
 * far ahead of (and broader than) a TABC alcohol license. There is no Socrata
 * feed or bulk file for this data, so we query the same public endpoints the
 * tdlr.texas.gov/tabs/search page uses:
 *   1. POST /TABS/Search/SearchProjects  -> DataTables JSON, enumerate projects
 *      in a county + registration-date window.
 *   2. GET  /TABS/Search/Project/{num}   -> server-rendered detail page with the
 *      full owner/tenant/address/phone fields.
 *
 * Usage:
 *   node scripts/tabs-leads.mjs                 # last 60 days, all 3 counties
 *   node scripts/tabs-leads.mjs --days 30
 *   node scripts/tabs-leads.mjs --min-cost 250000
 *   node scripts/tabs-leads.mjs --counties Travis,Hays --out leads.csv
 *
 * Output: a timestamped CSV in scripts/out/ (override with --out).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.tdlr.texas.gov';
const SEARCH_URL = `${BASE}/TABS/Search/SearchProjects`;
const DETAIL_URL = (num) => `${BASE}/TABS/Search/Project/${num}`;

// Location-county <option> values from the public search form.
const COUNTY_IDS = { Travis: 2227, Williamson: 2246, Hays: 2105 };

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const a = { days: 60, minCost: 0, counties: ['Travis', 'Williamson', 'Hays'], out: null, concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--min-cost') a.minCost = Number(argv[++i]);
    else if (k === '--counties') a.counties = argv[++i].split(',').map((s) => s.trim());
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--concurrency') a.concurrency = Number(argv[++i]);
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const iso = (s) => (s ? new Date(s).toISOString().slice(0, 10) : '');

// ---- step 1: enumerate projects in a county/date window ------------------
async function searchCounty(countyName, countyId, beginStr, endStr) {
  const rows = [];
  const pageSize = 100;
  let start = 0;
  let total = Infinity;
  let draw = 1;
  while (start < total) {
    const body = new URLSearchParams({
      draw: String(draw++),
      start: String(start),
      length: String(pageSize),
      'order[0][column]': '3',
      'order[0][dir]': 'desc',
      LocationCounty: String(countyId),
      RegistrationDateBegin: beginStr,
      RegistrationDateEnd: endStr,
    });
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'newpours-tabs-leads/1.0',
      },
      body,
    });
    if (!res.ok) throw new Error(`SearchProjects ${countyName} HTTP ${res.status}`);
    const json = await res.json();
    total = json.recordsFiltered ?? json.recordsTotal ?? 0;
    for (const r of json.data ?? []) rows.push({ county: countyName, ...r });
    if (!json.data || json.data.length === 0) break;
    start += pageSize;
    await sleep(200); // be polite
  }
  return rows;
}

// ---- step 2: parse a detail page -----------------------------------------
function stripTags(s) {
  return s
    .replace(/<sup>[\s\S]*?<\/sup>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function section(html, name) {
  const open = `project-details-${name}"`;
  const i = html.indexOf(open);
  if (i === -1) return '';
  const close = html.indexOf(`<!--/.project-details-${name}-->`, i);
  return html.slice(i, close === -1 ? undefined : close);
}

/** Parse <dt>label</dt><dd>v</dd>... into { label: [values] } (in order). */
function parseDL(html) {
  const out = {};
  let label = null;
  const re = /<dt>([\s\S]*?)<\/dt>|<dd>([\s\S]*?)<\/dd>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      label = stripTags(m[1]).replace(/:$/, '').trim();
      if (!out[label]) out[label] = [];
    } else if (label) {
      const v = stripTags(m[2]);
      if (v) out[label].push(v);
    }
  }
  return out;
}

function splitCityStateZip(line) {
  const m = (line || '').match(/^(.*),\s*([A-Za-z]{2,})\s+(\d{5})(?:-\d{4})?$/);
  if (!m) return { city: '', state: '', zip: '' };
  return { city: m[1].trim(), state: m[2].trim(), zip: m[3] };
}

async function fetchDetail(projectNumber) {
  const res = await fetch(DETAIL_URL(projectNumber), {
    headers: { 'User-Agent': 'newpours-tabs-leads/1.0' },
  });
  if (!res.ok) throw new Error(`detail ${projectNumber} HTTP ${res.status}`);
  const html = await res.text();

  const proj = parseDL(section(html, 'project'));
  const owner = parseDL(section(html, 'owner'));
  const tenant = parseDL(section(html, 'tenant'));
  const ras = parseDL(section(html, 'ras'));
  const designerSec = section(html, 'designer');
  const designFirm = /Not Assigned/.test(designerSec)
    ? ''
    : stripTags((designerSec.match(/<p>([\s\S]*?)<\/p>/) || [, ''])[1]);

  const locLines = proj['Location Address'] || [];
  const csz = splitCityStateZip(locLines[1]);
  const ownerLines = owner['Owner Address'] || [];

  const get = (o, k) => (o[k] && o[k][0]) || '';

  return {
    projectName: get(proj, 'Project Name'),
    facilityName: get(proj, 'Facility Name'),
    address: locLines[0] || '',
    city: csz.city,
    state: csz.state,
    zip: csz.zip,
    county: get(proj, 'Location County'),
    startDate: get(proj, 'Start Date'),
    completionDate: get(proj, 'Completion Date'),
    estimatedCost: get(proj, 'Estimated Cost'),
    typeOfWork: get(proj, 'Type of Work'),
    scopeOfWork: get(proj, 'Scope of Work'),
    squareFootage: get(proj, 'Square Footage'),
    status: get(proj, 'Current Status'),
    ownerName: get(owner, 'Owner Name'),
    ownerAddress: [ownerLines[0], ownerLines[1]].filter(Boolean).join(', '),
    ownerPhone: get(owner, 'Owner Phone'),
    tenantName: get(tenant, 'Tenant Name'),
    tenantPhone: get(tenant, 'Tenant Phone'),
    designFirm,
    rasName: get(ras, 'RAS Name'),
    rasPhone: get(ras, 'RAS Phone'),
  };
}

// ---- pool ----------------------------------------------------------------
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: String(e?.message || e) };
      }
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r  detail pages: ${done}/${items.length}`);
      }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write('\n');
  return results;
}

// ---- csv -----------------------------------------------------------------
const CSV_COLUMNS = [
  ['projectNumber', 'Project #'],
  ['registrationDate', 'Registered'],
  ['projectName', 'Project Name'],
  ['facilityName', 'Facility'],
  ['address', 'Address'],
  ['city', 'City'],
  ['state', 'State'],
  ['zip', 'Zip'],
  ['county', 'County'],
  ['estimatedCost', 'Est. Cost'],
  ['costNumeric', 'Cost ($)'],
  ['startDate', 'Start'],
  ['completionDate', 'Completion'],
  ['typeOfWork', 'Type of Work'],
  ['scopeOfWork', 'Scope'],
  ['squareFootage', 'Sq Ft'],
  ['status', 'Status'],
  ['ownerName', 'Owner'],
  ['ownerAddress', 'Owner Address'],
  ['ownerPhone', 'Owner Phone'],
  ['tenantName', 'Tenant'],
  ['tenantPhone', 'Tenant Phone'],
  ['designFirm', 'Design Firm'],
  ['rasName', 'RAS'],
  ['rasPhone', 'RAS Phone'],
  ['detailUrl', 'Detail URL'],
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(records) {
  const header = CSV_COLUMNS.map(([, h]) => csvCell(h)).join(',');
  const lines = records.map((r) => CSV_COLUMNS.map(([k]) => csvCell(r[k])).join(','));
  return [header, ...lines].join('\r\n');
}

// ---- main ----------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const end = new Date();
  const begin = new Date();
  begin.setDate(begin.getDate() - args.days);
  const beginStr = fmtDate(begin);
  const endStr = fmtDate(end);

  console.log(
    `TABS leads — counties: ${args.counties.join(', ')} | registered ${beginStr}–${endStr}` +
      (args.minCost ? ` | min cost $${args.minCost.toLocaleString()}` : ''),
  );

  // 1. enumerate
  let projects = [];
  for (const name of args.counties) {
    const id = COUNTY_IDS[name];
    if (!id) {
      console.warn(`  ! unknown county "${name}" (known: ${Object.keys(COUNTY_IDS).join(', ')})`);
      continue;
    }
    const rows = await searchCounty(name, id, beginStr, endStr);
    console.log(`  ${name}: ${rows.length} projects`);
    projects.push(...rows);
  }

  if (args.minCost) {
    projects = projects.filter((p) => Number(p.EstimatedCost || 0) >= args.minCost);
  }
  // newest registration first
  projects.sort((a, b) => new Date(b.ProjectCreatedOn) - new Date(a.ProjectCreatedOn));
  console.log(`  total to enrich: ${projects.length}`);

  // 2. enrich from detail pages
  const enriched = await mapPool(projects, args.concurrency, async (p) => {
    const d = await fetchDetail(p.ProjectNumber);
    return {
      projectNumber: p.ProjectNumber,
      registrationDate: iso(p.ProjectCreatedOn),
      costNumeric: Number(p.EstimatedCost || 0),
      detailUrl: DETAIL_URL(p.ProjectNumber),
      ...d,
      // prefer list values where the detail page is blank
      projectName: d.projectName || p.ProjectName || '',
      facilityName: d.facilityName || p.FacilityName || '',
    };
  });

  const records = enriched.filter((r) => r && !r.__error);
  const errors = enriched.filter((r) => r && r.__error).length;
  if (errors) console.warn(`  ${errors} detail page(s) failed`);

  // 3. write
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = args.out
    ? join(process.cwd(), args.out)
    : join(__dirname, 'out', `tabs-leads-${stamp}.csv`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, '﻿' + toCsv(records), 'utf8'); // BOM so Excel reads UTF-8

  console.log(`\n✓ ${records.length} leads -> ${outPath}`);
  const withPhone = records.filter((r) => r.ownerPhone || r.tenantPhone).length;
  console.log(`  ${withPhone} have an owner or tenant phone number`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
