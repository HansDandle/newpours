import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ─── Address Normalization ─────────────────────────────────────────────────────

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
  LOOP: 'LOOP',
  WAY: 'WAY',
  PASS: 'PASS',
  COVE: 'CV', CV: 'CV',
  BEND: 'BND', BND: 'BND',
  CROSSING: 'XING', XING: 'XING',
};

/**
 * Builds the canonical Firestore document ID for a TCAD property.
 * Format: {zip}_{num}_{dir}_{street}_{type}  (empty parts omitted)
 */
export function buildTcadKey(
  sitZip: string,
  sitNum: string,
  sitDir: string,
  sitStreet: string,
  sitType: string
): string {
  return [sitZip, sitNum, sitDir, sitStreet, sitType]
    .map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean)
    .join('_');
}

/**
 * Parses an establishment address string into TCAD-style components and
 * returns candidate lookup keys ordered from most to least specific.
 */
function addressToCandidateKeys(address: string, zipCode: string): string[] {
  const zip = (zipCode ?? '').trim().slice(0, 5);
  if (!zip) return [];

  // Strip unit/suite/apt suffixes before parsing
  const cleaned = address
    .toUpperCase()
    .replace(/\b(SUITE|STE|UNIT|APT|FL|FLOOR|ROOM|RM|#)\s*[\w-]*/g, '')
    .replace(/[,\.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length < 2) return [];

  // First token must be house number
  const num = tokens[0];
  if (!/^\d+[A-Z]?$/.test(num)) return [];

  let idx = 1;

  // Optional direction
  let dir = '';
  if (idx < tokens.length && DIR_MAP[tokens[idx]]) {
    dir = DIR_MAP[tokens[idx]];
    idx++;
  }

  // Find last street-type token (working backwards)
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

  const keys: string[] = [];

  // Full key: zip_num_dir_street_type
  keys.push(buildTcadKey(zip, num, dir, streetName, streetType));

  // Without type (in case TCAD omitted it)
  if (streetType) {
    keys.push(buildTcadKey(zip, num, dir, streetName, ''));
  }

  // Without direction (in case TCAD omitted it)
  if (dir) {
    keys.push(buildTcadKey(zip, num, '', streetName, streetType));
    if (streetType) keys.push(buildTcadKey(zip, num, '', streetName, ''));
  }

  return [...new Set(keys)];
}

// ─── Viability Score ──────────────────────────────────────────────────────────

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

  if (propClass === 'B1') return 0.28; // multifamily
  if (propClass === 'C1' || propClass === 'C2') return 0.12; // vacant lot
  if (propClass.startsWith('A')) return 0.08; // residential

  return 0.35; // unknown/other
}

// ─── Per-Establishment Enrichment ────────────────────────────────────────────

type PropertyStatus = 'complete' | 'no_match' | 'error';

export async function enrichPropertyForEstablishment(
  establishmentId: string,
  estData: Record<string, any>
): Promise<PropertyStatus> {
  const address = String(estData.address ?? '').trim();
  const zip = String(estData.zipCode ?? '').trim().slice(0, 5);

  if (!address || !zip) {
    await db.collection('establishments').doc(establishmentId).set({
      propertyData: { available: false, matchedAt: admin.firestore.FieldValue.serverTimestamp() },
      'enrichment.propertyData': 'no_match',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return 'no_match';
  }

  try {
    const candidates = addressToCandidateKeys(address, zip);

    let matchDoc: FirebaseFirestore.DocumentSnapshot | null = null;
    for (const key of candidates) {
      const snap = await db.collection('tcad_properties').doc(key).get();
      if (snap.exists) { matchDoc = snap; break; }
    }

    if (!matchDoc) {
      await db.collection('establishments').doc(establishmentId).set({
        propertyData: {
          available: true,
          matched: false,
          candidatesChecked: candidates.length,
          matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        'enrichment.propertyData': 'no_match',
        'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return 'no_match';
    }

    const prop = matchDoc.data() as {
      propId: string;
      propClass: string;
      sitNum: string;
      sitDir: string;
      sitStreet: string;
      sitType: string;
      sitZip: string;
      dba?: string;
      ownerName?: string;
      improvements: string[];
    };

    const viabilityScore = computeViabilityScore(prop.propClass, prop.improvements);

    await db.collection('establishments').doc(establishmentId).set({
      propertyData: {
        available: true,
        matched: true,
        propId: prop.propId,
        propClass: prop.propClass,
        dba: prop.dba ?? null,
        ownerName: prop.ownerName ?? null,
        improvements: prop.improvements,
        viabilityScore,
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      viabilityScore,
      'enrichment.propertyData': 'complete',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return 'complete';
  } catch (err: any) {
    await db.collection('establishments').doc(establishmentId).set({
      'enrichment.propertyData': 'error',
      'enrichment.lastEnrichedAt': admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return 'error';
  }
}

// ─── Batch Job ────────────────────────────────────────────────────────────────

export async function runPropertyDataJob(options?: {
  county?: string;
}): Promise<{ processed: number; complete: number; noMatch: number; error: number }> {
  const countyFilter = options?.county?.trim().toLowerCase();
  const snapshot = await db.collection('establishments').get();

  let processed = 0;
  let complete = 0;
  let noMatch = 0;
  let error = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (countyFilter) {
      const estCounty = String(data.county ?? '').trim().toLowerCase();
      if (estCounty !== countyFilter) continue;
    }

    const status = await enrichPropertyForEstablishment(doc.id, data);
    processed++;
    if (status === 'complete') complete++;
    else if (status === 'no_match') noMatch++;
    else error++;
  }

  return { processed, complete, noMatch, error };
}
