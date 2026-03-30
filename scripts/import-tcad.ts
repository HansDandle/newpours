/**
 * scripts/import-tcad.ts
 *
 * One-time local enrichment of establishments in Firestore with TCAD property data.
 *
 * Strategy (efficient — no bulk Firestore writes):
 *   1. Read all ~3800 establishments from Firestore and build their address keys.
 *   2. Stream PROP.TXT once (4.5 GB), keeping only records whose address key
 *      matches one of those establishments.
 *   3. Load IMP_INFO.TXT for improvement types on the matched prop_ids only.
 *   4. Write property data directly onto the matched establishment docs.
 *
 * Nothing is written to Firestore except the final ~1000–2000 establishment updates.
 *
 * Run from the repo root:
 *   npx ts-node scripts/import-tcad.ts [--zip="path/to/export.zip"]
 *
 * Prerequisites:
 *   - FIREBASE_ADMIN_* env vars in .env.local
 *   - `unzip` available in PATH (Git Bash on Windows)
 *
 * ─── PROP.TXT field offsets (fixed-width, 9249 chars/record) ─────────────────
 *   propId:    0–12
 *   propClass: 2741–2743
 *   sitDir:    1039–1049
 *   sitStreet: 1049–1099
 *   sitType:   1099–1119
 *   sitZip:    1139–1144
 *   dba:       4135–4175
 *   sitNum:    4459–4469
 *
 * ─── IMP_INFO.TXT field offsets ──────────────────────────────────────────────
 *   propId:    0–12
 *   impDesc:   38–63
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });

const db = getFirestore(app);

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_ZIP = path.resolve(
  __dirname,
  '../travis_SUPP 318_2025_WEBSITE EXPORT_Renamed.zip'
);
const ARG_ZIP = process.argv.find((a) => a.startsWith('--zip='));
const ZIP_PATH = ARG_ZIP ? ARG_ZIP.slice(6).replace(/^"|"$/g, '') : DEFAULT_ZIP;

const BATCH_SIZE = 400;

// ─── Address key helpers ──────────────────────────────────────────────────────

const DIR_MAP: Record<string, string> = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  N: 'N', S: 'S', E: 'E', W: 'W',
};

const TYPE_MAP: Record<string, string> = {
  BOULEVARD: 'BLVD', BLVD: 'BLVD',
  STREET: 'ST', ST: 'ST',
  AVENUE: 'AVE', AVE: 'AVE',
  DRIVE: 'DR', DR: 'DR',
  ROAD: 'RD', RD: 'RD',
  LANE: 'LN', LN: 'LN',
  HIGHWAY: 'HWY', HWY: 'HWY',
  PARKWAY: 'PKWY', PKWY: 'PKWY',
  COURT: 'CT', CT: 'CT',
  PLACE: 'PL', PL: 'PL',
  CIRCLE: 'CIR', CIR: 'CIR',
  TRAIL: 'TRL', TRL: 'TRL',
  TERRACE: 'TER', TER: 'TER',
  LOOP: 'LOOP', WAY: 'WAY', PASS: 'PASS',
  COVE: 'CV', CV: 'CV', BEND: 'BND', BND: 'BND',
  CROSSING: 'XING', XING: 'XING',
};

function sanitize(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildTcadKey(
  sitZip: string, sitNum: string, sitDir: string, sitStreet: string, sitType: string
): string {
  return [sitZip, sitNum, sitDir, sitStreet, sitType]
    .map(sanitize)
    .filter(Boolean)
    .join('_');
}

/**
 * Parses a TABC-style address string + zip into candidate TCAD keys.
 * Returns multiple variants (with/without direction, with/without street type)
 * to handle minor format differences.
 */
function addressToKeys(address: string, zipCode: string): string[] {
  const zip = (zipCode ?? '').trim().slice(0, 5);
  if (!zip || !/^\d{5}$/.test(zip)) return [];

  const cleaned = address
    .toUpperCase()
    .replace(/\b(SUITE|STE|UNIT|APT|FL|FLOOR|ROOM|RM|#)\s*[\w-]*/g, '')
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length < 2 || !/^\d+[A-Z]?$/.test(tokens[0])) return [];

  const num = tokens[0];
  let idx = 1;

  let dir = '';
  if (idx < tokens.length && DIR_MAP[tokens[idx]]) {
    dir = DIR_MAP[tokens[idx]];
    idx++;
  }

  let streetType = '';
  let streetEnd = tokens.length;
  for (let i = tokens.length - 1; i >= idx; i--) {
    if (TYPE_MAP[tokens[i]]) {
      streetType = TYPE_MAP[tokens[i]];
      streetEnd = i;
      break;
    }
  }

  const streetName = tokens.slice(idx, streetEnd).join(' ');
  if (!streetName) return [];

  const keys = new Set<string>();
  keys.add(buildTcadKey(zip, num, dir, streetName, streetType));
  if (streetType) keys.add(buildTcadKey(zip, num, dir, streetName, ''));
  if (dir) {
    keys.add(buildTcadKey(zip, num, '', streetName, streetType));
    if (streetType) keys.add(buildTcadKey(zip, num, '', streetName, ''));
  }
  return [...keys];
}

// ─── Viability score ──────────────────────────────────────────────────────────

const FOOD_BEV = new Set([
  'RESTAURANT', 'FAST FOOD REST', 'NIGHT CLUB/BAR', 'TAVERN', 'BREW PUB',
  'BREWERY', 'WINERY', 'DISTILLERY', 'LOUNGE', 'BAR & GRILL', 'BANQUET HALL',
  'SPORTS BAR', 'COCKTAIL LOUNGE', 'CAFE', 'COFFEE SHOP',
]);

const GENERAL_COMMERCIAL = new Set([
  'STRIP CTR >10000', 'STRIP CTR <10000', 'CONVENIENCE STOR', 'COMM SHOP CTR',
  'SM STORE <10K SF', 'RETAIL STORE', 'HOTEL', 'MOTEL', 'COMMERCIAL SPACE CONDOS',
]);

function computeViabilityScore(propClass: string, improvements: string[]): number {
  if (improvements.some((i) => FOOD_BEV.has(i))) return 0.95;
  if (propClass === 'F1' || propClass === 'F2') {
    if (improvements.some((i) => GENERAL_COMMERCIAL.has(i))) return 0.72;
    return 0.60;
  }
  if (propClass === 'B1') return 0.28;
  if (propClass === 'C1' || propClass === 'C2') return 0.12;
  if (propClass.startsWith('A')) return 0.08;
  return 0.35;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function openZipEntry(entryName: string): readline.Interface {
  const proc = spawn('bash', ['-c', `unzip -p "${ZIP_PATH}" "${entryName}"`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) log(`[unzip stderr] ${msg}`);
  });
  return readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
}

// ─── Phase 1: Read establishments from Firestore ─────────────────────────────

async function loadEstablishments(): Promise<Map<string, string>> {
  log('Phase 1: Reading establishments from Firestore…');

  const snap = await db.collection('establishments').get();
  // Map: tcadKey → establishmentId (multiple keys per establishment for variants)
  const keyToEstId = new Map<string, string>();

  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, any>;
    const address = String(d.address ?? '').trim();
    const zip = String(d.zipCode ?? '').trim();
    if (!address || !zip) continue;

    for (const key of addressToKeys(address, zip)) {
      keyToEstId.set(key, doc.id);
    }
  }

  log(`Phase 1 complete: ${snap.size} establishments, ${keyToEstId.size} address key variants.`);
  return keyToEstId;
}

// ─── Phase 2: Stream PROP.TXT, find matching records ─────────────────────────

interface PropRecord {
  propId: string;
  propClass: string;
  sitNum: string;
  sitDir: string;
  sitStreet: string;
  sitType: string;
  sitZip: string;
  dba: string;
  ownerName: string;
  estId: string;
}

async function findMatchingProperties(
  keyToEstId: Map<string, string>
): Promise<PropRecord[]> {
  log('Phase 2: Streaming PROP.TXT to find matching establishments…');

  const matches: PropRecord[] = [];
  const rl = openZipEntry('PROP.TXT');
  let lineCount = 0;

  await new Promise<void>((resolve, reject) => {
    rl.on('line', (line) => {
      lineCount++;
      if (lineCount % 50000 === 0) {
        log(`  …${lineCount.toLocaleString()} records scanned, ${matches.length} matched so far`);
      }

      const sitNum    = line.slice(4459, 4469).trim();
      const sitDir    = line.slice(1039, 1049).trim();
      const sitStreet = line.slice(1049, 1099).trim();
      const sitType   = line.slice(1099, 1119).trim();
      const sitZip    = line.slice(1139, 1144).trim();

      if (!sitZip || !sitNum || !sitStreet) return;

      const key = buildTcadKey(sitZip, sitNum, sitDir, sitStreet, sitType);
      const estId = keyToEstId.get(key);
      if (!estId) return;

      matches.push({
        propId:     line.slice(0, 12).trim(),
        propClass:  line.slice(2741, 2743).trim(),
        sitNum, sitDir, sitStreet, sitType, sitZip,
        dba:        line.slice(4135, 4175).trim(),
        ownerName:  line.slice(608, 678).trim(),
        estId,
      });
    });

    rl.on('close', resolve);
    rl.on('error', reject);
  });

  log(`Phase 2 complete: ${lineCount.toLocaleString()} records scanned, ${matches.length} matched.`);
  return matches;
}

// ─── Phase 3: Load improvements for matched prop_ids only ────────────────────

async function loadImprovementsForIds(
  propIds: Set<string>
): Promise<Map<string, string[]>> {
  log(`Phase 3: Loading IMP_INFO.TXT for ${propIds.size} matched properties…`);

  const map = new Map<string, string[]>();
  const rl = openZipEntry('IMP_INFO.TXT');
  let lineCount = 0;

  await new Promise<void>((resolve, reject) => {
    rl.on('line', (line) => {
      lineCount++;
      const propId = line.slice(0, 12).trim();
      if (!propIds.has(propId)) return;

      const impDesc = line.slice(38, 63).trim();
      if (!impDesc || impDesc === 'Detail Only') return;

      const existing = map.get(propId);
      if (existing) {
        if (!existing.includes(impDesc)) existing.push(impDesc);
      } else {
        map.set(propId, [impDesc]);
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  log(`Phase 3 complete: ${lineCount.toLocaleString()} IMP_INFO lines scanned.`);
  return map;
}

// ─── Phase 4: Write property data to establishment docs ──────────────────────

async function writeEnrichments(
  matches: PropRecord[],
  improvements: Map<string, string[]>
): Promise<void> {
  log(`Phase 4: Writing property data to ${matches.length} establishment docs…`);

  let written = 0;
  let pending: PropRecord[] = [];

  async function flush() {
    if (pending.length === 0) return;
    const batch = db.batch();
    for (const m of pending) {
      const imps = improvements.get(m.propId) ?? [];
      const viabilityScore = computeViabilityScore(m.propClass, imps);
      batch.set(
        db.collection('establishments').doc(m.estId),
        {
          propertyData: {
            available: true,
            matched: true,
            propId: m.propId,
            propClass: m.propClass,
            dba: m.dba || null,
            ownerName: m.ownerName || null,
            improvements: imps,
            viabilityScore,
            matchedAt: FieldValue.serverTimestamp(),
          },
          viabilityScore,
          'enrichment.propertyData': 'complete',
          'enrichment.lastEnrichedAt': FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
    written += pending.length;
    pending = [];
  }

  for (const m of matches) {
    pending.push(m);
    if (pending.length >= BATCH_SIZE) await flush();
  }
  await flush();

  log(`Phase 4 complete: ${written} establishment docs updated.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting TCAD enrichment from: ${ZIP_PATH}`);

  const keyToEstId = await loadEstablishments();
  const matches = await findMatchingProperties(keyToEstId);

  if (matches.length === 0) {
    log('No matches found. Check that establishments have address + zipCode fields.');
    process.exit(0);
  }

  const matchedPropIds = new Set(matches.map((m) => m.propId));
  const improvements = await loadImprovementsForIds(matchedPropIds);

  await writeEnrichments(matches, improvements);

  log(`Done. ${matches.length} establishments enriched with TCAD property data.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
