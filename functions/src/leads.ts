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
  type LeadSource,
} from './match';
import { resolveOperator } from './operators';

if (!admin.apps.length) admin.initializeApp();

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
  contacts: SeedContact[] = []
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
  // Resolve parent operator from this record; keep an already-resolved one if present.
  const operator =
    existing?.operator ??
    resolveOperator({
      owner: identity.ownerName,
      mailAddress: identity.mailAddress,
      businessName: identity.businessName,
    });
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
    signals: computeSignals({ sources, website }),
    crm: existing?.crm ?? { stage: 'new', assignedTo: null, followUpDate: null },
    firstSeenAt: existing?.firstSeenAt ?? admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

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
