/**
 * Nonprofit ingest — large 501-exempt orgs in the coverage area as ad leads.
 *
 * $1MM+ nonprofits run galas, capital campaigns, and awareness drives — they buy
 * media. Source is the IRS Exempt Organizations Business Master File (EO BMF),
 * the complete registry of exempt orgs. `REVENUE_AMT` is the revenue from the
 * org's most recent Form 990, so "more than $1MM on their latest 990" is a clean
 * one-pass filter. Texas lives in the eo3.csv regional file.
 *
 * County isn't in the BMF, so we map ZIP -> county via a Census ZCTA crosswalk
 * (baked in below) for the coverage area. The BMF has no phone; the org's main
 * line/website is resolved later by the same Google Places pass used for PMs.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { upsertLead, type SeedContact } from './leads';
import type { LeadSource } from './match';
import { loadOperators } from './operators';

if (!admin.apps.length) admin.initializeApp();

const BMF_URL = 'https://www.irs.gov/pub/irs-soi/eo3.csv'; // Texas region
const MIN_REVENUE = 1_000_000;

const FIPS_COUNTY: Record<string, string> = {
  '48453': 'Travis', '48491': 'Williamson', '48021': 'Bastrop', '48055': 'Caldwell',
  '48209': 'Hays', '48031': 'Blanco', '48053': 'Burnet', '48171': 'Gillespie',
};

// ZIP -> dominant county FIPS for the coverage area (Census 2020 ZCTA/county crosswalk).
const ZIP_FIPS: Record<string, string> = {
  '76511': '48491', '76527': '48491', '76530': '48491', '76537': '48491', '76539': '48053',
  '76549': '48053', '76550': '48053', '76573': '48491', '76574': '48491', '76577': '48491',
  '76578': '48491', '78028': '48171', '78058': '48171', '78070': '48031', '78130': '48209',
  '78602': '48021', '78605': '48053', '78606': '48031', '78608': '48053', '78610': '48209',
  '78611': '48053', '78612': '48021', '78613': '48491', '78615': '48491', '78616': '48055',
  '78617': '48453', '78618': '48171', '78619': '48209', '78620': '48209', '78621': '48021',
  '78622': '48055', '78623': '48209', '78624': '48171', '78626': '48491', '78628': '48491',
  '78631': '48171', '78632': '48055', '78633': '48491', '78634': '48491', '78635': '48031',
  '78636': '48031', '78639': '48053', '78640': '48209', '78641': '48453', '78642': '48491',
  '78644': '48055', '78645': '48453', '78648': '48055', '78650': '48021', '78652': '48453',
  '78653': '48453', '78654': '48053', '78655': '48055', '78656': '48055', '78657': '48053',
  '78659': '48021', '78660': '48453', '78661': '48055', '78662': '48021', '78663': '48031',
  '78664': '48491', '78665': '48491', '78666': '48209', '78669': '48453', '78671': '48171',
  '78674': '48491', '78675': '48171', '78676': '48209', '78681': '48491', '78701': '48453',
  '78702': '48453', '78703': '48453', '78704': '48453', '78705': '48453', '78712': '48453',
  '78717': '48491', '78719': '48453', '78721': '48453', '78722': '48453', '78723': '48453',
  '78724': '48453', '78725': '48453', '78726': '48453', '78727': '48453', '78728': '48453',
  '78729': '48491', '78730': '48453', '78731': '48453', '78732': '48453', '78733': '48453',
  '78734': '48453', '78735': '48453', '78736': '48453', '78737': '48209', '78738': '48453',
  '78739': '48453', '78741': '48453', '78742': '48453', '78744': '48453', '78745': '48453',
  '78746': '48453', '78747': '48453', '78748': '48453', '78749': '48453', '78750': '48453',
  '78751': '48453', '78752': '48453', '78753': '48453', '78754': '48453', '78756': '48453',
  '78757': '48453', '78758': '48453', '78759': '48453', '78941': '48021', '78942': '48021',
  '78945': '48021', '78953': '48021', '78957': '48021', '78959': '48055',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();
}

interface NonprofitCandidate {
  ein: string;
  name: string;
  ico: string;
  street: string;
  city: string;
  zip: string;
  county: string;
  revenue: number;
  assets: number;
  ntee: string;
  taxPeriod: string;
}

export interface NonprofitJobResult {
  scanned: number;
  matched: number;
  created: number;
}

/** Stream the BMF, filter to coverage-area $1MM+ orgs, and upsert each as a lead. */
export async function runNonprofitsJob(options?: { minRevenue?: number; maxLeads?: number }): Promise<NonprofitJobResult> {
  const db = admin.firestore();
  const minRevenue = options?.minRevenue ?? MIN_REVENUE;
  const maxLeads = options?.maxLeads ?? 5000;

  const res = await fetch(BMF_URL);
  if (!res.ok || !res.body) throw new Error(`IRS BMF fetch failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let isHeader = true;
  let scanned = 0;
  const candidates: NonprofitCandidate[] = [];

  const handleLine = (line: string) => {
    if (isHeader) {
      isHeader = false;
      return;
    }
    if (!line) return;
    scanned++;
    // BMF is simple unquoted CSV; org names carry no commas.
    const f = line.split(',');
    if (f.length < 27) return;
    if (f[5] !== 'TX') return;
    const zip = (f[6] ?? '').slice(0, 5);
    const fips = ZIP_FIPS[zip];
    if (!fips) return;
    const revenue = Number(f[25]);
    if (!Number.isFinite(revenue) || revenue <= minRevenue) return;
    candidates.push({
      ein: f[0],
      name: f[1] ?? '',
      ico: (f[2] ?? '').replace(/^%\s*/, '').trim(),
      street: f[3] ?? '',
      city: f[4] ?? '',
      zip,
      county: FIPS_COUNTY[fips] ?? '',
      revenue,
      assets: Number(f[23]) || 0,
      ntee: f[26] ?? '',
      taxPeriod: f[17] ?? '',
    });
  };

  // Stream line-by-line so we never hold the whole file in memory.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) handleLine(buffer.replace(/\r$/, ''));

  const operators = await loadOperators(db);
  let created = 0;
  for (const c of candidates) {
    if (created >= maxLeads) break;
    const taxIso = /^\d{6}$/.test(c.taxPeriod) ? `${c.taxPeriod.slice(0, 4)}-${c.taxPeriod.slice(4, 6)}-01` : null;
    const source: LeadSource = {
      type: 'nonprofit_990',
      sourceId: `irs-${c.ein}`,
      registeredDate: taxIso,
      estimatedCost: c.revenue, // surfaces as the headline $ figure in the lead UI
      detailUrl: `https://projects.propublica.org/nonprofits/organizations/${c.ein}`,
      raw: { revenue: c.revenue, assets: c.assets, ntee: c.ntee, taxPeriod: c.taxPeriod, ico: c.ico },
    };
    const contacts: SeedContact[] = [];
    if (c.ico) contacts.push({ name: titleCase(c.ico), role: 'manual', source: 'irs_bmf' });

    try {
      await upsertLead(
        db,
        {
          businessName: titleCase(c.name),
          ownerName: c.ico ? titleCase(c.ico) : undefined,
          address: titleCase(c.street),
          city: titleCase(c.city),
          county: c.county,
          zipCode: c.zip,
        },
        source,
        contacts,
        operators
      );
      created++;
      await sleep(60);
    } catch (err) {
      console.error(`Nonprofit upsert failed for EIN ${c.ein}:`, err);
    }
  }

  return { scanned, matched: candidates.length, created };
}

/** Scheduled monthly nonprofit ingest (BMF refreshes monthly). */
export const ingestNonprofits = onSchedule(
  { schedule: '0 9 1 * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const result = await runNonprofitsJob();
    await admin.firestore().collection('runs').add({
      type: 'ingest_nonprofits',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
