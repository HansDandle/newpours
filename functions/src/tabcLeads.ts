/**
 * Maps a TABC license/application record onto the unified `leads` collection.
 * Used by both the scheduled ingest (ingest.ts) and the manual tabc_ingest job
 * (adminTriggers.ts) so TABC contributes to the same merged leads as TABS.
 *
 * Only NEW-business and event records become leads — renewals of long-standing
 * licenses aren't useful advertising prospects.
 */

import { upsertLead } from './leads';
import type { LeadSource } from './match';

/** TABC temporary/event permit types — flagged as `tabc_event` + event_upcoming. */
export const EVENT_LICENSE_TYPES = new Set(['ET', 'NT', 'TR', 'NB', 'NE']);

const NEW_CLASSES = new Set(['TRULY_NEW', 'PENDING_NEW', 'REOPENED', 'TRANSFER_OR_CHANGE']);

export interface TabcLeadInput {
  id: string; // lic-xxx or app-xxx
  businessName: string;
  ownerName?: string;
  address?: string;
  mailAddress?: string;
  city?: string;
  county?: string;
  zip?: string;
  phone?: string;
  licenseType?: string;
  status?: string;
  effectiveDate?: string | null;
  classification?: string;
}

/** Returns true if this TABC record is worth tracking as a radio-sales lead. */
export function isLeadWorthy(input: { licenseType?: string; classification?: string }): boolean {
  const isEvent = EVENT_LICENSE_TYPES.has(String(input.licenseType ?? '').toUpperCase());
  return isEvent || NEW_CLASSES.has(String(input.classification ?? ''));
}

/** Upsert a TABC record into `leads` (no-op for renewals / missing address). */
export async function upsertTabcLead(
  db: FirebaseFirestore.Firestore,
  input: TabcLeadInput
): Promise<void> {
  if (!input.address || !isLeadWorthy(input)) return;

  const isEvent = EVENT_LICENSE_TYPES.has(String(input.licenseType ?? '').toUpperCase());
  const source: LeadSource = {
    type: isEvent ? 'tabc_event' : 'tabc',
    sourceId: input.id,
    status: input.status ?? undefined,
    registeredDate: null,
    openingDate: input.effectiveDate ?? null,
    licenseType: input.licenseType ?? undefined,
    raw: { classification: input.classification ?? null },
  };

  const contacts =
    input.phone || input.ownerName
      ? [{ name: input.ownerName, role: 'owner' as const, phone: input.phone, source: 'tabc' }]
      : [];

  await upsertLead(
    db,
    {
      businessName: input.businessName,
      ownerName: input.ownerName,
      address: input.address,
      mailAddress: input.mailAddress,
      city: input.city,
      county: input.county,
      zipCode: input.zip,
      phones: input.phone ? [input.phone] : [],
    },
    source,
    contacts
  );
}
