/**
 * Medical facility ingest — hospitals, urgent care, imaging/diagnostic, and
 * surgical centers as ad leads. These are heavy local advertisers (urgent care
 * and imaging especially) but never show up in TABC/TABS, so we pull them from
 * the federal NPPES registry — the free, public CMS database of every provider
 * and facility with an NPI.
 *
 * We query ORGANIZATION NPIs (entity type 2) by coverage city + facility
 * taxonomy, take the practice location + phone, and upsert one lead per NPI.
 * Google Places enrichment (the nightly enrichLeadPlaces job) then fills
 * website/reviews, and campaign-fit scores them like every other source.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const NPPES_API = 'https://npiregistry.cms.hhs.gov/api/';
const MAX_LEADS = 2000;

// Coverage cities -> county (the core 8-county market).
const CITY_COUNTY: Record<string, string> = {
  'Austin': 'Travis', 'Pflugerville': 'Travis', 'Lakeway': 'Travis', 'Bee Cave': 'Travis',
  'Round Rock': 'Williamson', 'Cedar Park': 'Williamson', 'Georgetown': 'Williamson', 'Leander': 'Williamson',
  'Kyle': 'Hays', 'Buda': 'Hays', 'San Marcos': 'Hays', 'Dripping Springs': 'Hays',
  'Bastrop': 'Bastrop', 'Lockhart': 'Caldwell', 'Marble Falls': 'Burnet',
  'Fredericksburg': 'Gillespie', 'Johnson City': 'Blanco',
};

// NPPES taxonomy descriptions for the facility types worth calling.
const TAXONOMIES = [
  'General Acute Care Hospital',
  'Urgent Care',
  'Radiology',            // diagnostic imaging centers
  'Ambulatory Surgical',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();
}

interface NppesAddress {
  address_purpose?: string;
  address_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
}
interface NppesResult {
  number?: number | string;
  basic?: { organization_name?: string };
  addresses?: NppesAddress[];
  taxonomies?: Array<{ desc?: string; code?: string; primary?: boolean }>;
}

async function nppesSearch(city: string, taxonomy: string): Promise<NppesResult[]> {
  const params = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-2', // organizations only
    state: 'TX',
    city,
    taxonomy_description: taxonomy,
    limit: '200',
  });
  const res = await fetch(`${NPPES_API}?${params.toString()}`);
  if (!res.ok) throw new Error(`NPPES search failed: HTTP ${res.status}`);
  const json = (await res.json()) as { results?: NppesResult[]; Errors?: Array<{ description?: string }> };
  if (Array.isArray(json?.Errors) && json.Errors.length) {
    throw new Error(`NPPES error: ${json.Errors[0]?.description ?? 'unknown'}`);
  }
  return Array.isArray(json?.results) ? json.results : [];
}

export interface MedicalJobResult {
  queries: number;
  scanned: number;
  created: number;
}

/** Pull coverage-area medical facilities from NPPES and upsert each as a lead. */
export async function runMedicalJob(options?: { maxLeads?: number; county?: string }): Promise<MedicalJobResult> {
  const db = admin.firestore();
  const maxLeads = options?.maxLeads ?? MAX_LEADS;
  const countyFilter = String(options?.county ?? '').trim().toLowerCase();

  const cities = Object.entries(CITY_COUNTY).filter(
    ([, county]) => !countyFilter || county.toLowerCase() === countyFilter
  );

  const operators = await loadOperators(db);
  const seen = new Set<string>(); // NPI numbers already handled this run
  let queries = 0;
  let scanned = 0;
  let created = 0;

  for (const [city, county] of cities) {
    for (const taxonomy of TAXONOMIES) {
      if (created >= maxLeads) break;
      queries++;
      let results: NppesResult[];
      try {
        results = await nppesSearch(city, taxonomy);
      } catch (err) {
        console.error(`NPPES search failed for "${taxonomy} ${city}":`, err);
        continue;
      }
      await sleep(120);

      for (const r of results) {
        if (created >= maxLeads) break;
        scanned++;
        const npi = String(r.number ?? '').trim();
        if (!npi || seen.has(npi)) continue;
        seen.add(npi);

        const name = String(r.basic?.organization_name ?? '').trim();
        if (!name) continue;

        const addrs = r.addresses ?? [];
        const loc = addrs.find((a) => a.address_purpose === 'LOCATION') ?? addrs[0] ?? {};
        // Keep only facilities whose practice location is the city we queried.
        if (String(loc.city ?? '').trim().toLowerCase() !== city.toLowerCase()) continue;

        const phone = String(loc.telephone_number ?? '').trim();
        const primaryTax = r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];

        const source: LeadSource = {
          type: 'medical_npi',
          sourceId: `npi-${npi}`,
          status: primaryTax?.desc ?? taxonomy,
          detailUrl: `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
          raw: { npi, taxonomy: primaryTax?.desc ?? taxonomy, taxonomyCode: primaryTax?.code ?? null, queriedAs: taxonomy },
        };

        const contacts: SeedContact[] = [];
        if (phone) contacts.push({ name, role: 'manual', phone, source: 'nppes' });

        try {
          await upsertLead(
            db,
            {
              businessName: titleCase(name),
              address: titleCase(String(loc.address_1 ?? '')),
              city,
              county,
              zipCode: String(loc.postal_code ?? '').slice(0, 5),
              phones: phone ? [phone] : undefined,
            },
            source,
            contacts,
            operators
          );
          created++;
          await sleep(50);
        } catch (err) {
          console.error(`Medical upsert failed for NPI ${npi}:`, err);
        }
      }
    }
  }

  return { queries, scanned, created };
}

/** Scheduled monthly medical ingest (NPPES refreshes weekly; monthly is plenty). */
export const ingestMedical = onSchedule(
  { schedule: '0 12 2 * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const result = await runMedicalJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_medical',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
