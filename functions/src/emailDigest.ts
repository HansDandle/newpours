import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { Resend } from 'resend';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

export const sendDailyDigest = onSchedule(
  '0 * * * *',
  async () => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const now = new Date();
    const hour = now.getHours();

    const hourMap: Record<number, string> = { 6: '6am', 8: '8am', 12: '12pm' };
    const currentSlot = hourMap[hour];
    if (!currentSlot) return;

    const usersSnap = await db.collection('users')
      .where('emailDigest', '==', true)
      .where('digestTime', '==', currentSlot)
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Get undelivered alerts
      const alertsSnap = await db.collection('alerts')
        .where('userId', '==', userDoc.id)
        .where('channel', '==', 'dashboard')
        .where('deliveredAt', '>=', yesterday)
        .get();

      if (alertsSnap.empty) continue;

      const licenseNumbers = alertsSnap.docs.map(d => d.data().licenseNumber);
      const rows = licenseNumbers.map(n => `<li>${n}</li>`).join('');

      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'alerts@newpours.com',
        to: user.email,
        subject: `Your NewPours Daily Digest — ${licenseNumbers.length} new licenses`,
        html: `<h2>New TABC Licenses</h2><ul>${rows}</ul><p><a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard">View on Dashboard</a></p>`,
      });

      // Mark alerts as emailed
      const batch = db.batch();
      alertsSnap.docs.forEach(d => batch.update(d.ref, { channel: 'email' }));
      await batch.commit();
    }

    return;
  }
);
