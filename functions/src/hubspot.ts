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
  const companyProps: Record<string, string> = {
    name: leadData.businessName ?? '',
    phone: leadData.phones?.[0] ?? '',
    address: leadData.address ?? '',
    city: leadData.city ?? '',
    state: 'TX',
    zip: leadData.zipCode ?? '',
    ...(leadData.website ? { website: leadData.website } : {}),
    ...(settings.pipelineId ? {} : {}),
  };

  let companyId: string;
  let created = false;

  if (existing.companyId) {
    await hs.crm.companies.basicApi.update(existing.companyId, { properties: companyProps });
    companyId = existing.companyId;
  } else {
    const co = await hs.crm.companies.basicApi.create({ properties: companyProps });
    companyId = co.id;
    created = true;
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
