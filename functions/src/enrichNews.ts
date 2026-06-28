/**
 * Press / news enrichment — fills a recent-coverage signal on leads in the
 * background, so "in the news" is just there (and filterable) without anyone
 * clicking. Throttled so we never burst Google News (a free feed that will
 * rate-limit a flood of requests).
 *
 * Stores enrichment.news = { count, latestDate, items[], checkedAt } and adds
 * the `in_the_news` signal when there's recent coverage.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { fetchNews } from './newsLookup';

if (!admin.apps.length) admin.initializeApp();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface NewsJobResult {
  processed: number;
  withNews: number;
}

/** Enrich one lead with recent press. Returns true if any coverage was found. */
export async function enrichNewsOne(
  db: FirebaseFirestore.Firestore,
  leadId: string,
  lead: Record<string, any>
): Promise<boolean> {
  const name = String(lead.businessName ?? '').trim();
  if (!name) return false;

  let count = 0;
  let items: Array<{ title: string; source: string; link: string; date: string | null }> = [];
  try {
    const r = await fetchNews(name, String(lead.city ?? ''), { max: 5 });
    count = r.count;
    items = r.items;
  } catch (err) {
    console.error(`News fetch failed for ${leadId}:`, err);
    // Record the attempt so we don't retry it every run.
  }

  const latestDate = items.map((i) => i.date).filter(Boolean)[0] ?? null;
  const updates: Record<string, any> = {
    'enrichment.news': { count, latestDate, items, checkedAt: admin.firestore.FieldValue.serverTimestamp() },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // in_the_news is a stored (non-derived) signal — set/clear it explicitly.
  updates.signals = count > 0
    ? admin.firestore.FieldValue.arrayUnion('in_the_news')
    : admin.firestore.FieldValue.arrayRemove('in_the_news');

  await db.doc(`leads/${leadId}`).update(updates);
  return count > 0;
}

/** Batch: enrich leads that haven't had a news check yet. Gentle pacing. */
export async function runNewsJob(options?: { limit?: number }): Promise<NewsJobResult> {
  const db = admin.firestore();
  const limit = options?.limit ?? 200;

  const snap = await db.collection('leads').limit(3000).get();
  let processed = 0;
  let withNews = 0;
  for (const doc of snap.docs) {
    if (processed >= limit) break;
    const lead = doc.data() as Record<string, any>;
    if (lead.enrichment?.news) continue; // already checked
    processed++;
    try {
      if (await enrichNewsOne(db, doc.id, lead)) withNews++;
    } catch (err) {
      console.error(`News enrich failed for ${doc.id}:`, err);
    }
    await sleep(450); // stay well clear of Google News rate limits
  }
  return { processed, withNews };
}

/** Scheduled daily news enrichment. */
export const enrichNews = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const result = await runNewsJob();
    await admin.firestore().collection('runs').add({
      type: 'enrich_news',
      ...result,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);
