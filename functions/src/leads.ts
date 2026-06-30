/**
 * Lead upsert orchestration shared by every ingest source (TABS, TABC, events).
 * Reads the existing lead (if any), merges the new source + identity, recomputes
 * signals, and seeds CRM contacts — so all sources dedupe identically.
 */

import * as admin from 'firebase-admin';
import {
  leadKey,
  mergeSources,
  computeSignals,
  unionStrings,
  recordDateOf,
  type LeadSource,
} from './match';
import { resolveOperator, type OperatorDef } from './operators';
import { computeCategory } from './categorize';
import { computeCampaignFit } from './campaignFit';

if (!admin.apps.length) admin.initializeApp();

// Signals set outside computeSignals (enrichment / manual) — preserved across re-ingests.
const EXTERNAL_SIGNALS = new Set(['in_the_news', 'active_advertiser']);

export interface LeadIdentity {
  businessName: string;
  dba?: string;
  ownerName?: string;
  address: string;
  mailAddress?: string;
  city?: string;
  county?: string;
  zipCode?: string;
  phones?: string[];
  emails?: string[];
  website?: string;
  /** Broadcast cities this business covers (set by the bank-branch ingest). */
  footprintCities?: string[];
  /** Counties of footprint branches — a bank may have one representative county but span many. */
  footprintCounties?: string[];
}

export interface SeedContact {
  name?: string;
  role?: 'owner' | 'tenant' | 'rep' | 'google' | 'manual';
  phone?: string;
  email?: string;
  source?: string;
}

/** Pick the first non-empty value (used to fill identity fields without clobbering). */
function firstNonEmpty(...vals: Array<string | undefined | null>): string | undefined {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return undefined;
}

/**
 * Insert or merge a lead from one source record. Returns the lead doc id.
 * Identity fields only fill gaps on an existing lead (never overwrite with blanks).
 */
export async function upsertLead(
  db: FirebaseFirestore.Firestore,
  identity: LeadIdentity,
  source: LeadSource,
  contacts: SeedContact[] = [],
  operators: OperatorDef[] = []
): Promise<string> {
  const id = leadKey(identity.businessName, identity.address);
  const ref = db.collection('leads').doc(id);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() as Record<string, any>) : null;

  const sourceEntry: LeadSource = {
    ...source,
    // serverTimestamp() is illegal inside array elements — use a concrete Timestamp.
    firstSeenAt: source.firstSeenAt ?? admin.firestore.Timestamp.now(),
  };
  const sources = mergeSources(existing?.sources as LeadSource[] | undefined, sourceEntry);

  const website = firstNonEmpty(existing?.website, identity.website);
  const mailAddress = firstNonEmpty(existing?.mailAddress, identity.mailAddress);
  // Resolve parent operator. A manually-locked lead keeps its operator untouched;
  // otherwise match against the current operator registry (falling back to existing).
  const operator =
    existing?.operatorLocked === true
      ? existing?.operator ?? null
      : resolveOperator(
          { owner: identity.ownerName, mailAddress, businessName: identity.businessName },
          operators
        ) ?? existing?.operator ?? null;
  const merged: Record<string, any> = {
    businessName: firstNonEmpty(existing?.businessName, identity.businessName) ?? identity.businessName,
    dba: firstNonEmpty(existing?.dba, identity.dba) ?? null,
    ownerName: firstNonEmpty(existing?.ownerName, identity.ownerName) ?? null,
    operator: operator ?? null,
    mailAddress: mailAddress ?? null,
    address: firstNonEmpty(existing?.address, identity.address) ?? identity.address,
    city: firstNonEmpty(existing?.city, identity.city) ?? null,
    county: firstNonEmpty(existing?.county, identity.county) ?? null,
    zipCode: firstNonEmpty(existing?.zipCode, identity.zipCode) ?? null,
    phones: unionStrings(existing?.phones, identity.phones),
    emails: unionStrings(existing?.emails, identity.emails),
    website: website ?? null,
    sources,
    // Derived signals from sources + identity, plus any externally-set signals
    // (news enrichment, manual "running ads" flag) that a re-ingest must not wipe.
    signals: Array.from(new Set([
      ...computeSignals({ sources, website }),
      ...((existing?.signals ?? []) as string[]).filter((s) => EXTERNAL_SIGNALS.has(s)),
    ])),
    category: computeCategory({
      businessName: firstNonEmpty(existing?.businessName, identity.businessName) ?? identity.businessName,
      sources,
    }),
    recordDate: (() => {
      const rd = recordDateOf(sources);
      return rd ? admin.firestore.Timestamp.fromDate(rd) : (existing?.recordDate ?? null);
    })(),
    crm: existing?.crm ?? { stage: 'new', assignedTo: null, followUpDate: null },
    firstSeenAt: existing?.firstSeenAt ?? admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Broadcast footprint (union across runs) + per-campaign fit scores.
  const footprintCities = unionStrings(existing?.footprintCities, identity.footprintCities);
  merged.footprintCities = footprintCities;
  merged.footprintCount = footprintCities.length;
  const footprintCounties = unionStrings(existing?.footprintCounties, identity.footprintCounties);
  if (footprintCounties.length) merged.footprintCounties = footprintCounties;
  merged.campaignFit = computeCampaignFit({
    category: merged.category,
    sources,
    signals: merged.signals,
    website,
    footprintCount: footprintCities.length,
    enrichment: existing?.enrichment,
  });

  await ref.set(merged, { merge: true });

  // Seed contacts, de-duplicated by phone (or email when phone absent).
  for (const c of contacts) {
    const phone = String(c.phone ?? '').trim();
    const email = String(c.email ?? '').trim();
    if (!phone && !email && !String(c.name ?? '').trim()) continue;
    const contactId = phone
      ? `phone_${phone.replace(/[^0-9]/g, '')}`
      : email
      ? `email_${email.toLowerCase().replace(/[^a-z0-9]/g, '')}`
      : undefined;
    const data: Record<string, any> = {
      name: c.name ?? null,
      role: c.role ?? 'manual',
      phone: phone || null,
      email: email || null,
      source: c.source ?? source.type,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const col = ref.collection('contacts');
    if (contactId) await col.doc(contactId).set(data, { merge: true });
    else await col.add(data);
  }

  return id;
}
