/**
 * Operator (hospitality-group) registry. Many groups license each venue under a
 * separate LLC, so the parent operator never appears in the owner/trade name.
 * We link them by stable signals — primarily the shared HQ mailing address.
 *
 * Keep in sync with lib/operators.ts (client copy — same logic, separate build).
 */

export interface OperatorDef {
  key: string;
  name: string;
  /** Names a user might search to find the group. */
  aliases: string[];
  /** Normalized substrings of the HQ mailing address (strongest signal). */
  mailAddressContains?: string[];
  /** Normalized substrings of the owner entity name. */
  ownerContains?: string[];
}

export interface OperatorRef {
  key: string;
  name: string;
}

export const OPERATORS: OperatorDef[] = [
  {
    key: 'mml-hospitality',
    name: 'MML Hospitality',
    aliases: ['mml hospitality', 'mcguire moorman', 'mcguire moorman lambert', 'mcguire moorman lambert hospitality'],
    mailAddressContains: ['1711 s congress'],
    ownerContains: ['word of mouth mml', 'mml 2021'],
  },
  {
    key: 'elm-restaurant-group',
    name: 'ELM Restaurant Group',
    aliases: ['elm restaurant group', 'elm hospitality'],
    mailAddressContains: ['511 w 7th'],
  },
  {
    key: 'dirty-sixth-bars',
    name: 'Dirty 6th Bar Group',
    aliases: ['dirty 6th bar group', 'dirty sixth', 'dirty 6th'],
    mailAddressContains: ['407 e 6th'],
  },
  {
    key: 'fbr-management',
    name: 'FBR Management',
    aliases: ['fbr management', 'fbr', '801 springdale'],
    mailAddressContains: ['801 springdale'],
  },
];

function norm(value?: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Resolve a record's parent operator from owner / mailing address / business name. */
export function resolveOperator(rec: {
  owner?: string;
  mailAddress?: string;
  businessName?: string;
}): OperatorRef | null {
  const owner = norm(rec.owner);
  const mail = norm(rec.mailAddress);
  const name = norm(rec.businessName);
  for (const op of OPERATORS) {
    if (op.mailAddressContains?.some((m) => mail.includes(norm(m)))) return { key: op.key, name: op.name };
    if (op.ownerContains?.some((o) => owner.includes(norm(o)))) return { key: op.key, name: op.name };
    if (op.aliases.some((a) => owner.includes(norm(a)) || name.includes(norm(a)))) return { key: op.key, name: op.name };
  }
  return null;
}

/** Resolve a free-text search query to an operator (so "mcguire moorman" finds the group). */
export function matchOperatorQuery(query: string): OperatorRef | null {
  const nq = norm(query);
  if (nq.length < 2) return null;
  for (const op of OPERATORS) {
    if (norm(op.name).includes(nq)) return { key: op.key, name: op.name };
    if (op.aliases.some((a) => norm(a).includes(nq) || nq.includes(norm(a)))) return { key: op.key, name: op.name };
  }
  return null;
}
