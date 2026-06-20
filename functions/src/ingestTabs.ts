/**
 * TABS ingest — TDLR Architectural Barriers construction-permit leads.
 *
 * A TABS registration is filed for a >$50k build-out, typically 6–12 months
 * before a business opens, and the public record carries owner + tenant names
 * and phone numbers. No Socrata/bulk feed exists, so we query the same public
 * endpoints the tdlr.texas.gov/tabs/search page uses (robots.txt allows /tabs/):
 *   1. POST /TABS/Search/SearchProjects  -> DataTables JSON (enumerate by county+date)
 *   2. GET  /TABS/Search/Project/{num}   -> detail page (owner/tenant/phone/address)
 *
 * Ported from scripts/tabs-leads.mjs; writes merged leads via upsertLead().
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';

if (!admin.apps.length) admin.initializeApp();

const BASE = 'https://www.tdlr.texas.gov';
const SEARCH_URL = `${BASE}/TABS/Search/SearchProjects`;
const DETAIL_URL = (num: string) => `${BASE}/TABS/Search/Project/${num}`;

// Location-county <option> values from the public TABS search form.
const COUNTY_IDS: Record<string, number> = {
  travis: 2227,
  williamson: 2246,
  hays: 2105,
  bastrop: 2011,
  burnet: 2027,
  gillespie: 2086,
};
const DEFAULT_COUNTIES = ['Travis', 'Williamson', 'Hays', 'Bastrop', 'Burnet', 'Gillespie'];
const MAX_DETAILS_PER_RUN = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtMdy = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const isoDay = (s?: string | null) => (s ? new Date(s).toISOString().slice(0, 10) : null);

/** fetch() with an abort timeout so one slow TDLR response can't stall the run. */
async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface TabsListRow {
  ProjectNumber: string;
  FacilityName?: string;
  ProjectName?: string;
  EstimatedCost?: number;
  ProjectCreatedOn?: string;
  EstimatedEndDate?: string;
}

async function searchCounty(countyId: number, beginStr: string, endStr: string): Promise<TabsListRow[]> {
  const rows: TabsListRow[] = [];
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
    const res = await fetchWithTimeout(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'newpours-tabs-ingest/1.0',
      },
      body,
    }, 20000);
    if (!res.ok) throw new Error(`SearchProjects HTTP ${res.status}`);
    const json = (await res.json()) as { recordsFiltered?: number; recordsTotal?: number; data?: TabsListRow[] };
    total = json.recordsFiltered ?? json.recordsTotal ?? 0;
    const data = json.data ?? [];
    rows.push(...data);
    if (data.length === 0) break;
    start += pageSize;
    await sleep(200);
  }
  return rows;
}

// ── Detail page parsing (ported from scripts/tabs-leads.mjs) ──────────────────
function stripTags(s: string): string {
  return s
    .replace(/<sup>[\s\S]*?<\/sup>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function section(html: string, name: string): string {
  const open = `project-details-${name}"`;
  const i = html.indexOf(open);
  if (i === -1) return '';
  const close = html.indexOf(`<!--/.project-details-${name}-->`, i);
  return html.slice(i, close === -1 ? undefined : close);
}

function parseDL(html: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let label: string | null = null;
  const re = /<dt>([\s\S]*?)<\/dt>|<dd>([\s\S]*?)<\/dd>/g;
  let m: RegExpExecArray | null;
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

function splitCityStateZip(line?: string): { city: string; state: string; zip: string } {
  const m = (line || '').match(/^(.*),\s*([A-Za-z]{2,})\s+(\d{5})(?:-\d{4})?$/);
  if (!m) return { city: '', state: '', zip: '' };
  return { city: m[1].trim(), state: m[2].trim(), zip: m[3] };
}

interface TabsDetail {
  businessName: string;
  address: string;
  city: string;
  zip: string;
  county: string;
  openingDate: string | null;
  estimatedCost: number | null;
  status: string;
  ownerName: string;
  ownerPhone: string;
  tenantName: string;
  tenantPhone: string;
}

async function fetchDetail(projectNumber: string): Promise<TabsDetail | null> {
  const res = await fetchWithTimeout(DETAIL_URL(projectNumber), {
    headers: { 'User-Agent': 'newpours-tabs-ingest/1.0' },
  }, 15000);
  if (!res.ok) return null;
  const html = await res.text();

  const proj = parseDL(section(html, 'project'));
  const owner = parseDL(section(html, 'owner'));
  const tenant = parseDL(section(html, 'tenant'));
  const get = (o: Record<string, string[]>, k: string) => (o[k] && o[k][0]) || '';

  const locLines = proj['Location Address'] || [];
  const csz = splitCityStateZip(locLines[1]);
  const costStr = get(proj, 'Estimated Cost').replace(/[^0-9.]/g, '');
  const completion = get(proj, 'Completion Date');

  return {
    businessName: get(proj, 'Project Name') || get(proj, 'Facility Name'),
    address: locLines[0] || '',
    city: csz.city,
    zip: csz.zip,
    county: get(proj, 'Location County'),
    openingDate: completion ? isoDay(completion) : null,
    estimatedCost: costStr ? Number(costStr) : null,
    status: get(proj, 'Current Status'),
    ownerName: get(owner, 'Owner Name'),
    ownerPhone: get(owner, 'Owner Phone'),
    tenantName: get(tenant, 'Tenant Name'),
    tenantPhone: get(tenant, 'Tenant Phone'),
  };
}

export interface TabsJobResult {
  processed: number;
  created: number;
  failed: number;
  counties: string[];
}

/** Enumerate + enrich TABS projects for the given counties/window and upsert leads. */
export async function runTabsJob(options?: {
  counties?: string[];
  days?: number;
  minCost?: number;
  /** Cap on detail-page fetches per run. Defaults to the scheduled-run cap; raise for backfills. */
  maxDetails?: number;
}): Promise<TabsJobResult> {
  const db = admin.firestore();
  const counties = (options?.counties && options.counties.length ? options.counties : DEFAULT_COUNTIES)
    .filter((c) => COUNTY_IDS[c.trim().toLowerCase()] != null);
  const days = options?.days ?? 45;
  const minCost = options?.minCost ?? 0;
  const maxDetails = options?.maxDetails ?? MAX_DETAILS_PER_RUN;

  const end = new Date();
  const begin = new Date();
  begin.setDate(begin.getDate() - days);
  const beginStr = fmtMdy(begin);
  const endStr = fmtMdy(end);

  // 1. enumerate (one county failing shouldn't abort the others)
  let projects: TabsListRow[] = [];
  for (const name of counties) {
    const id = COUNTY_IDS[name.trim().toLowerCase()];
    try {
      const rows = await searchCounty(id, beginStr, endStr);
      projects.push(...rows);
    } catch (err) {
      console.error(`TABS search failed for ${name}:`, err);
    }
  }
  if (minCost) projects = projects.filter((p) => Number(p.EstimatedCost ?? 0) >= minCost);
  projects.sort((a, b) => new Date(b.ProjectCreatedOn ?? 0).getTime() - new Date(a.ProjectCreatedOn ?? 0).getTime());
  projects = projects.slice(0, maxDetails);

  // 2. enrich + upsert
  let created = 0;
  let failed = 0;
  for (const p of projects) {
    try {
      const d = await fetchDetail(p.ProjectNumber);
      if (!d || !d.address) {
        failed++;
        continue;
      }
      const source: LeadSource = {
        type: 'tabs_permit',
        sourceId: p.ProjectNumber,
        status: d.status,
        registeredDate: isoDay(p.ProjectCreatedOn),
        openingDate: d.openingDate,
        estimatedCost: d.estimatedCost ?? (Number(p.EstimatedCost ?? 0) || null),
        detailUrl: DETAIL_URL(p.ProjectNumber),
        raw: { facilityName: p.FacilityName ?? '', projectName: p.ProjectName ?? '' },
      };
      const contacts: SeedContact[] = [];
      if (d.ownerPhone || d.ownerName) {
        contacts.push({ name: d.ownerName, role: 'owner', phone: d.ownerPhone, source: 'tabs' });
      }
      if (d.tenantPhone || d.tenantName) {
        contacts.push({ name: d.tenantName, role: 'tenant', phone: d.tenantPhone, source: 'tabs' });
      }
      await upsertLead(
        db,
        {
          businessName: d.businessName || p.FacilityName || p.ProjectName || 'Unnamed Project',
          ownerName: d.ownerName,
          address: d.address,
          city: d.city,
          county: d.county,
          zipCode: d.zip,
          phones: [d.ownerPhone, d.tenantPhone].filter(Boolean) as string[],
        },
        source,
        contacts
      );
      created++;
      await sleep(120);
    } catch (err) {
      console.error(`TABS ${p.ProjectNumber} failed:`, err);
      failed++;
    }
  }

  return { processed: projects.length, created, failed, counties };
}

/** Scheduled daily TABS ingest for the default metro counties. */
export const ingestTABS = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const result = await runTabsJob({ days: 45 });
    await admin.firestore().collection('runs').add({
      type: 'ingest_tabs',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
