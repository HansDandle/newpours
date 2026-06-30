"use client";
/**
 * Operator (hospitality-group) matching — client copy. Operators live in the
 * Firestore `operators` collection (managed via /admin/operators).
 * Keep matcher logic in sync with functions/src/operators.ts.
 */
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";

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
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const refOf = (op: OperatorDef): OperatorRef => ({ key: op.id ?? norm(op.name).replace(/ /g, "-"), name: op.name });

/** Whole-word/phrase match — prevents "ELM" from matching "St. Elmo" (substring). */
function wordMatch(haystack: string, pattern: string): boolean {
  const p = norm(pattern);
  if (!p) return false;
  return new RegExp(`(^| )${p}( |$)`).test(haystack);
}

export function resolveOperator(
  rec: { owner?: string; mailAddress?: string; businessName?: string },
  operators: OperatorDef[]
): OperatorRef | null {
  const owner = norm(rec.owner);
  const mail = norm(rec.mailAddress);
  const name = norm(rec.businessName);
  for (const op of operators) {
    if ((op.mailPatterns ?? []).some((m) => m && wordMatch(mail, m))) return refOf(op);
    if ((op.ownerPatterns ?? []).some((o) => o && wordMatch(owner, o))) return refOf(op);
    if ((op.aliases ?? []).some((a) => a && (wordMatch(owner, a) || wordMatch(name, a)))) return refOf(op);
  }
  return null;
}

export function matchOperatorQuery(query: string, operators: OperatorDef[]): OperatorRef | null {
  const nq = norm(query);
  if (nq.length < 2) return null;
  for (const op of operators) {
    if (norm(op.name).includes(nq)) return refOf(op);
    if ((op.aliases ?? []).some((a) => a && (norm(a).includes(nq) || nq.includes(norm(a))))) return refOf(op);
  }
  return null;
}

const CACHE_KEY = "newpours.operators.cache.v1";
const CACHE_TTL = 5 * 60 * 1000;

/** Load operators from Firestore, cached in sessionStorage for the session. */
export async function loadOperators(): Promise<OperatorDef[]> {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) {
      const { t, data } = JSON.parse(raw) as { t: number; data: OperatorDef[] };
      if (Date.now() - t <= CACHE_TTL) return data;
    }
  } catch {}
  const snap = await getDocs(collection(db, "operators"));
  const data = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OperatorDef, "id">) }));
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
  } catch {}
  return data;
}
