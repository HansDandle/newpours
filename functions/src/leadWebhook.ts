/**
 * Outbound webhook fanout. On a new lead or a pipeline stage change, POST a
 * normalized JSON payload to the user's configured endpoint (Zapier/Make/etc.),
 * HMAC-signed with their secret. Config lives at settings/integrations; every
 * attempt is logged to system/webhookDeliveries/items.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export const leadWebhookFanout = onDocumentWritten('leads/{leadId}', async (event) => {
  const after = event.data?.after;
  if (!after?.exists) return; // deletion — nothing to send
  const afterData = after.data() as Record<string, any>;
  const before = event.data?.before;
  const beforeData = before?.exists ? (before.data() as Record<string, any>) : null;

  const created = !beforeData;
  const stageChanged = !!beforeData && beforeData.crm?.stage !== afterData.crm?.stage;

  let eventType: 'lead.created' | 'lead.stage_changed';
  if (created) eventType = 'lead.created';
  else if (stageChanged) eventType = 'lead.stage_changed';
  else return; // not an event we notify on

  const settingsSnap = await db.doc('settings/integrations').get();
  const settings = settingsSnap.exists ? (settingsSnap.data() as Record<string, any>) : null;
  if (!settings?.enabled || !settings?.webhookUrl) return;
  if (Array.isArray(settings.events) && settings.events.length && !settings.events.includes(eventType)) return;

  const filters = settings.filters ?? {};
  if (Array.isArray(filters.counties) && filters.counties.length && !filters.counties.includes(afterData.county)) return;
  if (
    Array.isArray(filters.signals) &&
    filters.signals.length &&
    !(afterData.signals ?? []).some((s: string) => filters.signals.includes(s))
  ) {
    return;
  }

  const payload = {
    event: eventType,
    lead: {
      id: event.params.leadId,
      businessName: afterData.businessName ?? null,
      ownerName: afterData.ownerName ?? null,
      address: afterData.address ?? null,
      city: afterData.city ?? null,
      county: afterData.county ?? null,
      zipCode: afterData.zipCode ?? null,
      phones: afterData.phones ?? [],
      website: afterData.website ?? null,
      sources: (afterData.sources ?? []).map((s: Record<string, any>) => ({
        type: s.type,
        sourceId: s.sourceId,
        detailUrl: s.detailUrl ?? null,
        estimatedCost: s.estimatedCost ?? null,
        openingDate: s.openingDate ?? null,
      })),
      signals: afterData.signals ?? [],
      stage: afterData.crm?.stage ?? 'new',
    },
    sentAt: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.secret) headers['X-NewPours-Signature'] = sign(settings.secret, body);

  let status = 0;
  let ok = false;
  let errorMsg: string | null = null;
  try {
    const res = await fetch(settings.webhookUrl, { method: 'POST', headers, body });
    status = res.status;
    ok = res.ok;
  } catch (e: any) {
    errorMsg = String(e?.message ?? e);
  }

  await db.collection('system/webhookDeliveries/items').add({
    event: eventType,
    leadId: event.params.leadId,
    businessName: afterData.businessName ?? null,
    url: settings.webhookUrl,
    status,
    ok,
    error: errorMsg,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
});
