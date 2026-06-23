/**
 * HubSpot CRM integration.
 *
 * Pushes a PourScout lead → HubSpot Company + Contact + Deal (associated).
 * Stores HubSpot IDs back on the lead doc so re-syncs are upserts, not duplicates.
 *
 * Auth: HubSpot Service Key (Bearer token) stored at settings/integrations.hubspot.serviceKey.
 * Called by:
 *   1. hubspotPushLead — HTTP callable, triggered from the "Push to HubSpot" UI button.
 *   2. leadWebhookFanout (when hubspot.autoSync is enabled) — imported and called inline.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { Client as HubSpotClient } from '@hubspot/api-client';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// PourScout CRM stage → HubSpot deal stage internal value.
// Users can override via settings/integrations.hubspot.stageMap.
const DEFAULT_STAGE_MAP: Record<string, string> = {
  new: 'appointmentscheduled',
  contacted: 'qualifiedtobuy',
  qualified: 'presentationscheduled',
  proposal: 'decisionmakerboughtin',
  won: 'closedwon',
  lost: 'closedlost',
};

function splitName(full?: string): { firstname: string; lastname: string } {
  if (!full?.trim()) return { firstname: '', lastname: '' };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

interface HubSpotSettings {
  serviceKey?: string;
  enabled?: boolean;
  autoSync?: boolean;
  pipelineId?: string;
  stageMap?: Record<string, string>;
  /** Lead signals that qualify a lead for auto-sync. Operator-linked leads always qualify. */
  icpSignals?: string[];
}

// Default ICP for auto-sync: restaurant groups (operator-linked, handled separately)
// plus multi-unit operators and high-value build-outs. One-off licenses are excluded.
const DEFAULT_ICP_SIGNALS = ['multi_unit_operator', 'high_value_buildout'];

/** True when a lead fits the radio-sales ICP — tied to a known operator, or carrying an ICP signal. */
function isIcpLead(leadData: Record<string, any>, icpSignals: string[]): boolean {
  if (leadData.operator?.key) return true;
  const signals: string[] = leadData.signals ?? [];
  return signals.some((s) => icpSignals.includes(s));
}

async function getHubSpotSettings(): Promise<HubSpotSettings | null> {
  const snap = await db.doc('settings/integrations').get();
  if (!snap.exists) return null;
  return (snap.data() as Record<string, any>)?.hubspot ?? null;
}

export interface PushResult {
  companyId: string;
  contactId: string | null;
  dealId: string;
  created: boolean; // false = updated existing records
}

/**
 * Core push: upsert Company + Contact + Deal in HubSpot for the given lead.
 * If the lead doc already has hubspot IDs (in enrichment.hubspot.*) those objects
 * are updated in-place; otherwise new objects are created and the IDs are written back.
 */
export async function pushLeadToHubSpot(
  leadId: string,
  leadData: Record<string, any>,
  settings: HubSpotSettings
): Promise<PushResult> {
  if (!settings.serviceKey) throw new Error('HubSpot service key not configured');

  const hs = new HubSpotClient({ accessToken: settings.serviceKey });
  const stageMap = { ...DEFAULT_STAGE_MAP, ...(settings.stageMap ?? {}) };
  const existing = leadData.enrichment?.hubspot ?? {};

  // ── Company ──────────────────────────────────────────────────────────────────
  // For a lead tied to a known operator (restaurant group), the HubSpot Company
  // is the OPERATOR — so every venue rolls up under one account. The operator's
  // company id is cached on the operator doc, so multiple venues dedupe to the
  // same company. Standalone leads use the venue itself, cached per-lead.
  const operatorRef = leadData.operator as { key?: string; name?: string } | null | undefined;
  let companyId: string;
  let created = false;

  if (operatorRef?.key && operatorRef?.name) {
    const opDocRef = db.doc(`operators/${operatorRef.key}`);
    const opSnap = await opDocRef.get();
    const cachedCompanyId = opSnap.exists ? (opSnap.data() as Record<string, any>)?.hubspotCompanyId : null;
    // Keep group company props minimal — a venue's address/phone is not the group HQ.
    const companyProps: Record<string, string> = {
      name: operatorRef.name,
      state: 'TX',
      ...(leadData.city ? { city: leadData.city } : {}),
    };
    if (cachedCompanyId) {
      await hs.crm.companies.basicApi.update(cachedCompanyId, { properties: companyProps });
      companyId = cachedCompanyId;
    } else {
      const co = await hs.crm.companies.basicApi.create({ properties: companyProps });
      companyId = co.id;
      created = true;
      if (opSnap.exists) await opDocRef.update({ hubspotCompanyId: companyId });
    }
  } else {
    const companyProps: Record<string, string> = {
      name: leadData.businessName ?? '',
      phone: leadData.phones?.[0] ?? '',
      address: leadData.address ?? '',
      city: leadData.city ?? '',
      state: 'TX',
      zip: leadData.zipCode ?? '',
      ...(leadData.website ? { website: leadData.website } : {}),
    };
    if (existing.companyId) {
      await hs.crm.companies.basicApi.update(existing.companyId, { properties: companyProps });
      companyId = existing.companyId;
    } else {
      const co = await hs.crm.companies.basicApi.create({ properties: companyProps });
      companyId = co.id;
      created = true;
    }
  }

  // ── Contact ───────────────────────────────────────────────────────────────────
  let contactId: string | null = existing.contactId ?? null;
  const hasContactInfo = !!(leadData.ownerName || leadData.phones?.[0] || leadData.emails?.[0]);

  if (hasContactInfo) {
    const { firstname, lastname } = splitName(leadData.ownerName);
    const contactProps: Record<string, string> = {
      firstname,
      lastname,
      phone: leadData.phones?.[0] ?? '',
      email: leadData.emails?.[0] ?? '',
    };

    if (contactId) {
      await hs.crm.contacts.basicApi.update(contactId, { properties: contactProps });
    } else {
      const ct = await hs.crm.contacts.basicApi.create({ properties: contactProps });
      contactId = ct.id;
      // Associate contact → company (default/primary association)
      await hs.crm.associations.v4.basicApi.createDefault('contacts', contactId, 'companies', companyId);
    }
  }

  // ── Deal ──────────────────────────────────────────────────────────────────────
  const stage = stageMap[leadData.crm?.stage ?? 'new'] ?? stageMap.new;
  const signals: string[] = leadData.signals ?? [];
  const signalLabel = signals.length ? ` [${signals.join(', ')}]` : '';
  const dealProps: Record<string, string> = {
    dealname: `${leadData.businessName ?? 'Unnamed'}${signalLabel}`,
    dealstage: stage,
    ...(leadData.city ? { description: `${leadData.city}, ${leadData.county ?? 'TX'}` } : {}),
    ...(settings.pipelineId ? { pipeline: settings.pipelineId } : {}),
  };

  // Add estimated cost from TABS source if available
  const tabsSource = (leadData.sources ?? []).find((s: Record<string, any>) => s.type === 'tabs_permit');
  if (tabsSource?.estimatedCost) {
    dealProps.amount = String(tabsSource.estimatedCost);
  }
  if (tabsSource?.openingDate) {
    dealProps.closedate = tabsSource.openingDate;
  }

  let dealId: string;
  if (existing.dealId) {
    await hs.crm.deals.basicApi.update(existing.dealId, { properties: dealProps });
    dealId = existing.dealId;
  } else {
    const deal = await hs.crm.deals.basicApi.create({ properties: dealProps });
    dealId = deal.id;
    // Associate deal → company (default/primary association)
    await hs.crm.associations.v4.basicApi.createDefault('deals', dealId, 'companies', companyId);
    // Associate deal → contact if we have one
    if (contactId) {
      await hs.crm.associations.v4.basicApi.createDefault('deals', dealId, 'contacts', contactId);
    }
  }

  // ── Write IDs back to Firestore ───────────────────────────────────────────────
  await db.doc(`leads/${leadId}`).update({
    'enrichment.hubspot': {
      companyId,
      contactId,
      dealId,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  });

  return { companyId, contactId, dealId, created };
}

// ── HTTP Callable — "Push to HubSpot" button ─────────────────────────────────

export const hubspotPushLead = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { leadId } = request.data as { leadId?: string };
  if (!leadId) throw new HttpsError('invalid-argument', 'leadId required');

  const settings = await getHubSpotSettings();
  if (!settings?.serviceKey) {
    throw new HttpsError('failed-precondition', 'HubSpot service key not configured');
  }

  const leadSnap = await db.doc(`leads/${leadId}`).get();
  if (!leadSnap.exists) throw new HttpsError('not-found', `Lead ${leadId} not found`);

  try {
    const result = await pushLeadToHubSpot(leadId, leadSnap.data() as Record<string, any>, settings);
    return result;
  } catch (err: any) {
    console.error('HubSpot push failed:', err?.message ?? err);
    throw new HttpsError('internal', err?.message ?? 'HubSpot push failed');
  }
});

// ── Test Connection — server-side (HubSpot's API has no browser CORS) ─────────

export const hubspotTestConnection = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const passed = (request.data as { serviceKey?: string })?.serviceKey;
  // Fall back to the saved key so an admin can re-test without re-pasting.
  const serviceKey = passed || (await getHubSpotSettings())?.serviceKey;
  if (!serviceKey) throw new HttpsError('failed-precondition', 'No service key provided');

  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
      headers: { Authorization: `Bearer ${serviceKey}` },
    });
    if (res.ok) return { ok: true, message: 'Connected — service key is valid.' };
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, message: body?.message ?? `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? 'Connection failed' };
  }
});

// ── Auto-sync — push ICP leads to HubSpot as they arrive / advance ────────────

export const hubspotAutoSync = onDocumentWritten('leads/{leadId}', async (event) => {
  const after = event.data?.after;
  if (!after?.exists) return; // deletion
  const afterData = after.data() as Record<string, any>;
  const before = event.data?.before;
  const beforeData = before?.exists ? (before.data() as Record<string, any>) : null;

  const settings = await getHubSpotSettings();
  if (!settings?.enabled || !settings?.autoSync || !settings?.serviceKey) return;

  const icpSignals = settings.icpSignals?.length ? settings.icpSignals : DEFAULT_ICP_SIGNALS;
  const created = !beforeData;
  const stageChanged = !!beforeData && beforeData.crm?.stage !== afterData.crm?.stage;
  const wasIcp = beforeData ? isIcpLead(beforeData, icpSignals) : false;
  const isIcp = isIcpLead(afterData, icpSignals);
  const newlyIcp = !wasIcp && isIcp;
  const alreadyInHubSpot = !!afterData.enrichment?.hubspot?.dealId;

  // Only react to meaningful changes — never to our own enrichment.hubspot write-back
  // (that's an update with no stage change and no ICP transition, so it no-ops here).
  if (!(created || stageChanged || newlyIcp)) return;
  // In scope only if it fits the ICP, or it's already a HubSpot deal we should keep synced.
  if (!isIcp && !alreadyInHubSpot) return;

  try {
    await pushLeadToHubSpot(event.params.leadId, afterData, settings);
  } catch (err: any) {
    console.error(`HubSpot auto-sync failed for ${event.params.leadId}:`, err?.message ?? err);
  }
});
