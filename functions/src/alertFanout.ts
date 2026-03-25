import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import fetch from 'node-fetch';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

type LicenseClassification = 'TRULY_NEW' | 'PENDING_NEW' | 'RENEWAL' | 'TRANSFER_OR_CHANGE' | 'REOPENED' | 'UNKNOWN';

function isTrulyNewClassification(classification?: string): boolean {
  // TRANSFER_OR_CHANGE included: ownership transfers mean a new decision-maker reviewing
  // all vendor relationships — equally valuable to vendors as a brand-new establishment.
  return (
    classification === 'TRULY_NEW' ||
    classification === 'PENDING_NEW' ||
    classification === 'REOPENED' ||
    classification === 'TRANSFER_OR_CHANGE'
  );
}

export const alertFanout = onDocumentCreated('licenses/{licenseNumber}', async (event) => {
    const snap = event.data;
    if (!snap) return;

    const license = snap.data() as {
      licenseNumber?: string;
      county?: string;
      licenseType?: string;
      zipCode?: string;
      newEstablishmentClassification?: LicenseClassification;
      [key: string]: unknown;
    };
    if (!license) return;

    // Get all paying users
    const usersSnap = await db.collection('users')
      .where('plan', '!=', 'free')
      .get();

    const batch = db.batch();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const filters = user.filters || {};
      const includeRenewals = Boolean(user.includeRenewals);

      // Default behavior is truly-new-only unless user explicitly opts into renewals/transfers.
      const classification = String(license.newEstablishmentClassification ?? 'UNKNOWN');
      if (!includeRenewals && !isTrulyNewClassification(classification)) continue;

      // Check if license matches user's filters
      const countyMatch = !filters.counties?.length || filters.counties.includes(license.county);
      const typeMatch = !filters.licenseTypes?.length || filters.licenseTypes.includes(license.licenseType);
      const zipMatch = !filters.zipCodes?.length || filters.zipCodes.includes(license.zipCode);

      if (!countyMatch || !typeMatch || !zipMatch) continue;

      // Write alert doc
      const alertRef = db.collection('alerts').doc();
      batch.set(alertRef, {
        userId: userDoc.id,
        licenseNumber: license.licenseNumber,
        deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        channel: 'dashboard',
      });

      // Send webhook for Enterprise users
      if (user.plan === 'enterprise' && user.webhookUrl) {
        try {
          await fetch(user.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(license),
          });
        } catch (e) {
          console.error(`Webhook failed for user ${userDoc.id}:`, e);
        }
      }
    }

    await batch.commit();
  });
