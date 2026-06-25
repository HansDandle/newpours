/**
 * Multifamily ingest — Austin residential 5+ unit new-construction permits.
 *
 * A new apartment community pulls a "C- 105 Five or More Family Bldgs" building
 * permit 12–24 months before lease-up. We ingest these as leads so the radio
 * station is tracking the development long before its leasing office opens.
 *
 * Caveats baked into this code (see sales-strategy notes):
 *  - City of Austin only (data.austintexas.gov). Other jurisdictions need their
 *    own sources.
 *  - One development files MANY permits (one per building). We collapse them by
 *    normalized street address (normalizeAddress already strips "BLDG x") and
 *    sum the unit counts, so a complex is one lead, not ten.
 *  - The permit names a contractor (often a subcontractor) / applicant, never the
 *    property manager. The PM is resolved later by a Google Places enrichment as
 *    the community's "now leasing" presence goes public.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { upsertLead, type SeedContact } from './leads';
import { normalizeAddress, type LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const DATASET = 'https://data.austintexas.gov/resource/3syk-w9eu.json';
const MULTIFAMILY_CLASS_PREFIX = 'C- 105'; // "C- 105 Five or More Family Bldgs"
const DEFAULT_MIN_UNITS = 50;
const PAGE_SIZE = 1000;
const MAX_ROWS = 10000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isoDay = (s?: string | null) => (s ? String(s).slice(0, 10) : null);

interface PermitRow {
  permit_number?: string;
  description?: string;
  status_current?: string;
  issue_date?: string;
  completed_date?: string;
  total_job_valuation?: string;
  housing_units?: string;
  original_address1?: string;
  original_city?: string;
  original_zip?: string;
  contractor_company_name?: string;
  contractor_phone?: string;
  applicant_full_name?: string;
  applicant_org?: string;
  applicant_phone?: string;
  link?: { url?: string };
  project_id?: string;
}

async function fetchWithTimeout(url: string, ms = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: { 'User-Agent': 'newpours-multifamily-ingest/1.0' }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Strip a trailing "BLDG x" / unit designator for a clean display address. */
function cleanAddress(addr: string): string {
  return String(addr ?? '')
    .replace(/\b(bldg|building|unit|ste|suite|apt|#)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

async function fetchPermits(sinceIso: string): Promise<PermitRow[]> {
  const rows: PermitRow[] = [];
  const where = `permit_class like '${MULTIFAMILY_CLASS_PREFIX}%' AND work_class='New' AND issue_date >= '${sinceIso}'`;
  const select = [
    'permit_number', 'description', 'status_current', 'issue_date', 'completed_date',
    'total_job_valuation', 'housing_units', 'original_address1', 'original_city', 'original_zip',
    'contractor_company_name', 'contractor_phone', 'applicant_full_name', 'applicant_org', 'applicant_phone',
    'link', 'project_id',
  ].join(',');

  let offset = 0;
  while (offset < MAX_ROWS) {
    const url =
      `${DATASET}?$select=${encodeURIComponent(select)}` +
      `&$where=${encodeURIComponent(where)}` +
      `&$order=${encodeURIComponent('issue_date DESC')}` +
      `&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Austin permits HTTP ${res.status}`);
    const page = (await res.json()) as PermitRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(200);
  }
  return rows;
}

interface Project {
  rows: PermitRow[];
  units: number;
  valuation: number;
}

export interface MultifamilyJobResult {
  processed: number; // projects that passed the unit threshold
  created: number;
  skipped: number; // groups below the unit threshold
  permits: number; // raw permit rows fetched
}

/** Enumerate Austin multifamily permits, collapse per-building rows, and upsert one lead per development. */
export async function runMultifamilyJob(options?: {
  days?: number;
  minUnits?: number;
  maxProjects?: number;
}): Promise<MultifamilyJobResult> {
  const db = admin.firestore();
  const days = options?.days ?? 730; // apartments move slowly — default 2-year window
  const minUnits = options?.minUnits ?? DEFAULT_MIN_UNITS;
  const maxProjects = options?.maxProjects ?? 1000;

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString().slice(0, 19);

  const permits = await fetchPermits(sinceIso);

  // Collapse per-building permits into one project, keyed by normalized street address.
  const projects = new Map<string, Project>();
  for (const r of permits) {
    const key = normalizeAddress(r.original_address1 ?? '');
    if (!key) continue;
    const p = projects.get(key) ?? { rows: [], units: 0, valuation: 0 };
    p.rows.push(r);
    p.units += Number(r.housing_units ?? 0) || 0;
    p.valuation += Number(r.total_job_valuation ?? 0) || 0;
    projects.set(key, p);
  }

  const operators = await loadOperators(db);
  let created = 0;
  let skipped = 0;
  let processed = 0;

  for (const [key, p] of projects) {
    if (p.units < minUnits) {
      skipped++;
      continue;
    }
    if (processed >= maxProjects) break;
    processed++;

    // Representative row = earliest issued (the project's first filing).
    const sorted = [...p.rows].sort(
      (a, b) => new Date(a.issue_date ?? 0).getTime() - new Date(b.issue_date ?? 0).getTime()
    );
    const first = sorted[0];
    const display = titleCase(cleanAddress(first.original_address1 ?? ''));
    const completed = sorted.map((r) => r.completed_date).filter(Boolean).sort().pop() ?? null;
    const description = p.rows.map((r) => r.description ?? '').sort((a, b) => b.length - a.length)[0] ?? '';

    // Best-effort permit contact — flagged as a placeholder; the PM comes from enrichment.
    const contactName = first.applicant_org || first.applicant_full_name || first.contractor_company_name || '';
    const contactPhone = first.applicant_phone || first.contractor_phone || '';

    const source: LeadSource = {
      type: 'building_permit',
      sourceId: `austin-mf-${key.replace(/\s+/g, '-')}`,
      status: first.status_current ?? '',
      registeredDate: isoDay(first.issue_date),
      openingDate: isoDay(completed),
      estimatedCost: p.valuation || null,
      detailUrl: first.link?.url ?? undefined,
      raw: {
        housingUnits: p.units,
        permitCount: p.rows.length,
        description,
        applicantOrg: first.applicant_org ?? '',
        contractor: first.contractor_company_name ?? '',
        city: 'Austin',
      },
    };

    const contacts: SeedContact[] = [];
    if (contactName || contactPhone) {
      contacts.push({ name: contactName, role: 'rep', phone: contactPhone, source: 'austin_permits' });
    }

    try {
      await upsertLead(
        db,
        {
          businessName: display || `Apartments at ${first.original_zip ?? 'Austin'}`,
          address: display,
          city: first.original_city ? titleCase(first.original_city) : 'Austin',
          county: 'Travis',
          zipCode: first.original_zip ?? '',
          phones: contactPhone ? [contactPhone] : [],
        },
        source,
        contacts,
        operators
      );
      created++;
      await sleep(80);
    } catch (err) {
      console.error(`Multifamily upsert failed for ${key}:`, err);
    }
  }

  return { processed, created, skipped, permits: permits.length };
}

/** Scheduled weekly multifamily ingest (apartments move slowly). */
export const ingestMultifamily = onSchedule(
  { schedule: '0 8 * * 1', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const result = await runMultifamilyJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_multifamily',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
