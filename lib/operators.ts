/**
 * Operator (hospitality-group) registry — client copy.
 * Keep in sync with functions/src/operators.ts (same logic, separate build).
 *
 * Groups license each venue under its own LLC, so the parent operator never
 * appears on the record. We link them by shared signals (HQ mailing address,
 * owner entity patterns) and let users search the group by name.
 */

export interface OperatorRef {
  key: string;
  name: string;
}

interface OperatorDef extends OperatorRef {
  aliases: string[];
  mailAddressContains?: string[];
  ownerContains?: string[];
}

export const OPERATORS: OperatorDef[] = [
  {
    key: "mml-hospitality",
    name: "MML Hospitality",
    aliases: ["mml hospitality", "mcguire moorman", "mcguire moorman lambert", "mcguire moorman lambert hospitality"],
    mailAddressContains: ["1711 s congress"],
    ownerContains: ["word of mouth mml", "mml 2021"],
  },
  {
    key: "elm-restaurant-group",
    name: "ELM Restaurant Group",
    aliases: ["elm restaurant group", "elm hospitality"],
    mailAddressContains: ["511 w 7th"],
  },
  {
    // 407 E 6th St — shared 6th-Street bar-management office. Twin Bar Management
    // historically; now MoonlightATX. Either name should find the group.
    key: "moonlight-atx",
    name: "MoonlightATX",
    aliases: ["moonlightatx", "moonlight atx", "twin bar management", "twin bar", "dirty 6th"],
    mailAddressContains: ["407 e 6th"],
  },
  {
    key: "fbr-management",
    name: "FBR Management",
    aliases: ["fbr management", "fbr", "801 springdale"],
    mailAddressContains: ["801 springdale"],
  },
];

function norm(value?: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function resolveOperator(rec: { owner?: string; mailAddress?: string; businessName?: string }): OperatorRef | null {
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

export function matchOperatorQuery(query: string): OperatorRef | null {
  const nq = norm(query);
  if (nq.length < 2) return null;
  for (const op of OPERATORS) {
    if (norm(op.name).includes(nq)) return { key: op.key, name: op.name };
    if (op.aliases.some((a) => norm(a).includes(nq) || nq.includes(norm(a)))) return { key: op.key, name: op.name };
  }
  return null;
}
