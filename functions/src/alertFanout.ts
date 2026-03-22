import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import fetch from 'node-fetch';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

export const alertFanout = functions.firestore
  .document('licenses/{licenseNumber}')
  .onCreate(async (snap) => {
    const license = snap.data();
    if (!license) return;

    // Get all paying users
    const usersSnap = await db.collection('users')
      .where('plan', '!=', 'free')
      .get();

    const batch = db.batch();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const filters = user.filters || {};

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
