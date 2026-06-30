/**
 * Bank / credit-union branch ingest — arms the HS-football sponsor campaign.
 *
 * The ideal football sponsor is a regional advertiser with branches across many of
 * the broadcast towns (a bank wanting goodwill in every small town it serves). The
 * FDIC BankFind "locations" API is a free, key-less, structured registry of every
 * bank branch. We pull Texas branches, keep the ones in Sun Radio's broadcast
 * cities, group them by institution, and upsert ONE lead per institution carrying
 * its broadcast footprint — which drives the football campaign-fit score.
 *
 * Credit unions (NCUA) are an even better community-sponsor fit but live in a
 * separate bulk dataset; this v1 covers FDIC banks and leaves NCUA as a follow-up.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { upsertLead } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';
import { BROADCAST_CITIES, canonicalBroadcastCity } from './broadcastCities';

if (!admin.apps.length) admin.initializeApp();

const FDIC_LOCATIONS = 'https://banks.data.fdic.gov/api/locations';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FdicBranch {
  NAME?: string;        // institution name
  CERT?: string | number; // FDIC certificate number (stable institution id)
  ADDRESS?: string;
  CITY?: string;
  COUNTY?: string;
  STALP?: string;
  ZIP?: string | number;
  MAINOFF?: number;     // 1 = institution main office
}

interface InstitutionAgg {
  cert: string;
  name: string;
  cities: Set<string>;       // canonical broadcast cities covered
  counties: Set<string>;     // counties of footprint branches
  main?: FdicBranch;         // representative (main office, else first) branch
  first?: FdicBranch;
}

export interface BanksJobResult {
  branches: number;
  inFootprint: number;
  institutions: number;
  created: number;
}

/** Fetch every Texas bank branch from FDIC (paged), grouped by institution. */
async function fetchTexasBranches(): Promise<FdicBranch[]> {
  const fields = 'NAME,CERT,ADDRESS,CITY,COUNTY,STALP,ZIP,MAINOFF';
  const pageSize = 10000;
  const out: FdicBranch[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const url =
      `${FDIC_LOCATIONS}?filters=STALP:TX&fields=${fields}` +
      `&limit=${pageSize}&offset=${offset}&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FDIC locations fetch failed: HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ data?: FdicBranch }> };
    const rows = Array.isArray(json?.data) ? json.data.map((d) => d.data ?? {}) : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    await sleep(200);
  }
  return out;
}

/** Pull TX bank branches, keep broadcast-footprint ones, upsert one lead per institution. */
export async function runBanksJob(options?: { minCities?: number; maxLeads?: number }): Promise<BanksJobResult> {
  const db = admin.firestore();
  const minCities = options?.minCities ?? 1;
  const maxLeads = options?.maxLeads ?? 2000;

  const branches = await fetchTexasBranches();

  const byInstitution = new Map<string, InstitutionAgg>();
  let inFootprint = 0;
  for (const b of branches) {
    const canonical = canonicalBroadcastCity(b.CITY);
    if (!canonical) continue; // only branches inside the broadcast footprint
    inFootprint++;
    const cert = String(b.CERT ?? b.NAME ?? '').trim();
    if (!cert) continue;
    let agg = byInstitution.get(cert);
    if (!agg) {
      agg = { cert, name: String(b.NAME ?? '').trim(), cities: new Set(), counties: new Set(), first: b };
      byInstitution.set(cert, agg);
    }
    agg.cities.add(canonical);
    const county = String(b.COUNTY ?? '').trim();
    if (county) agg.counties.add(county);
    if (b.MAINOFF === 1) agg.main = b;
  }

  const operators = await loadOperators(db);
  let created = 0;
  for (const agg of byInstitution.values()) {
    if (created >= maxLeads) break;
    if (agg.cities.size < minCities) continue;
    const rep = agg.main ?? agg.first ?? {};
    const footprintCities = BROADCAST_CITIES.filter((c) => agg.cities.has(c)); // canonical order

    const source: LeadSource = {
      type: 'bank_branch',
      sourceId: `fdic-${agg.cert}`,
      status: `${agg.cities.size} broadcast ${agg.cities.size === 1 ? 'city' : 'cities'}`,
      detailUrl: `https://banks.data.fdic.gov/bankfind-suite/bankfind?name=${encodeURIComponent(agg.name)}`,
      raw: { cert: agg.cert, footprintCities, branchCount: agg.cities.size, mainCity: rep.CITY ?? null },
    };

    try {
      await upsertLead(
        db,
        {
          businessName: agg.name,
          address: String(rep.ADDRESS ?? '').trim() || agg.name, // representative office
          city: String(rep.CITY ?? '').trim() || footprintCities[0],
          county: String(rep.COUNTY ?? '').trim(),
          zipCode: String(rep.ZIP ?? '').slice(0, 5),
          footprintCities,
          footprintCounties: [...agg.counties].sort(),
        },
        source,
        [],
        operators
      );
      created++;
      await sleep(40);
    } catch (err) {
      console.error(`Bank upsert failed for CERT ${agg.cert}:`, err);
    }
  }

  return { branches: branches.length, inFootprint, institutions: byInstitution.size, created };
}

/** Scheduled quarterly bank-branch ingest (branch networks change slowly). */
export const ingestBanks = onSchedule(
  { schedule: '0 11 1 1,4,7,10 *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const result = await runBanksJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_banks',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
