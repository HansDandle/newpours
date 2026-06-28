/**
 * Manual "running ads" toggle — lets a rep mark a lead as a confirmed active
 * advertiser after eyeballing the Meta/Google ad-library links. Sets (or clears)
 * the `active_advertiser` signal and immediately re-scores the lead's campaign
 * fit, so the strongest buying signal feeds the matrix without any scraping.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { computeCampaignFit } from './campaignFit';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

export const setLeadAdvertiser = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { leadId, active } = (request.data ?? {}) as { leadId?: string; active?: boolean };
  if (!leadId) throw new HttpsError('invalid-argument', 'leadId required');

  const ref = db.doc(`leads/${leadId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Lead ${leadId} not found`);
  const d = snap.data() as Record<string, any>;

  const signals = new Set<string>((d.signals ?? []) as string[]);
  if (active) signals.add('active_advertiser');
  else signals.delete('active_advertiser');
  const nextSignals = Array.from(signals);

  const campaignFit = computeCampaignFit({
    category: d.category,
    sources: d.sources,
    signals: nextSignals,
    website: d.website,
    footprintCount: d.footprintCount,
    enrichment: d.enrichment,
  });

  await ref.update({
    signals: nextSignals,
    campaignFit,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, active: !!active, campaignFit };
});
