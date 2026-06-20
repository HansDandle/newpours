/**
 * Operator (hospitality-group) matching — data-driven. Operators live in the
 * Firestore `operators` collection (managed via /admin/operators); these are the
 * pure matchers + a loader. Keep in sync with lib/operators.ts (client copy).
 *
 * Groups license each venue under its own LLC, so the parent never appears on
 * the record; we link them by shared signals (HQ mailing address, owner entity
 * patterns) and let users search the group by name.
 */

export interface OperatorDef {
  id?: string;
  name: string;
  aliases?: string[];
  mailPatterns?: string[];
  ownerPatterns?: string[];
}

export interface OperatorRef {
  key: string;
  name: string;
}

function norm(value?: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Resolve a record's parent operator from owner / mailing address / business name. */
export function resolveOperator(
  rec: { owner?: string; mailAddress?: string; businessName?: string },
  operators: OperatorDef[]
): OperatorRef | null {
  const owner = norm(rec.owner);
  const mail = norm(rec.mailAddress);
  const name = norm(rec.businessName);
  for (const op of operators) {
    const ref = { key: op.id ?? norm(op.name).replace(/ /g, '-'), name: op.name };
    if ((op.mailPatterns ?? []).some((m) => m && mail.includes(norm(m)))) return ref;
    if ((op.ownerPatterns ?? []).some((o) => o && owner.includes(norm(o)))) return ref;
    if ((op.aliases ?? []).some((a) => a && (owner.includes(norm(a)) || name.includes(norm(a))))) return ref;
  }
  return null;
}

/** Resolve a free-text search query to an operator (so "hai" finds the group). */
export function matchOperatorQuery(query: string, operators: OperatorDef[]): OperatorRef | null {
  const nq = norm(query);
  if (nq.length < 2) return null;
  for (const op of operators) {
    const ref = { key: op.id ?? norm(op.name).replace(/ /g, '-'), name: op.name };
    if (norm(op.name).includes(nq)) return ref;
    if ((op.aliases ?? []).some((a) => a && (norm(a).includes(nq) || nq.includes(norm(a))))) return ref;
  }
  return null;
}

/** Load all operators from Firestore (one read per ingest run). */
export async function loadOperators(db: FirebaseFirestore.Firestore): Promise<OperatorDef[]> {
  const snap = await db.collection('operators').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OperatorDef, 'id'>) }));
}
