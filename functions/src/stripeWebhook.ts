import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const PLAN_MAP: Record<string, string> = {
  [process.env.STRIPE_PRICE_BASIC || '']: 'basic',
  [process.env.STRIPE_PRICE_PRO || '']: 'pro',
  [process.env.STRIPE_PRICE_ENTERPRISE || '']: 'enterprise',
};

export const stripeWebhook = functions.https.onRequest(async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-02-25.clover' });
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    return;
  }

  const getUidByCustomer = async (customerId: string) => {
    const snap = await db.collection('users').where('stripeCustomerId', '==', customerId).limit(1).get();
    return snap.empty ? null : snap.docs[0].id;
  };

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const uid = await getUidByCustomer(sub.customer as string);
      if (!uid) break;
      const priceId = sub.items.data[0]?.price.id;
      const plan = PLAN_MAP[priceId] || 'free';
      await db.collection('users').doc(uid).update({
        plan,
        planStatus: sub.status === 'active' ? 'active' : 'past_due',
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const uid = await getUidByCustomer(sub.customer as string);
      if (uid) await db.collection('users').doc(uid).update({ plan: 'free', planStatus: 'canceled' });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const uid = await getUidByCustomer(invoice.customer as string);
      if (uid) await db.collection('users').doc(uid).update({ planStatus: 'past_due' });
      break;
    }
  }

  res.json({ received: true });
});
