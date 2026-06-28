/**
 * Press / news lookup — free recent-coverage signal for a lead.
 *
 * Pulls Google News' public RSS search for the business name (+ city to cut
 * noise) and returns the recent headlines. A business that's in the news is
 * promoting itself / has a moment worth calling on. No API key, no cost — just
 * a server-side fetch of a public RSS feed (avoids the browser CORS block).
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const MAX_AGE_DAYS = 180;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

function tag(item: string, name: string): string {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
}

export interface NewsItem {
  title: string;
  source: string;
  link: string;
  date: string | null;
}

export const newsLookup = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { businessName, city } = (request.data ?? {}) as { businessName?: string; city?: string };
  const name = String(businessName ?? '').trim();
  if (!name) throw new HttpsError('invalid-argument', 'businessName required');

  // Quote the name to keep it as a phrase; add city to disambiguate common names.
  const q = `"${name}"${city ? ` ${city}` : ''}`;
  const url = `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

  let xml: string;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (PourScout news lookup)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err: any) {
    throw new HttpsError('unavailable', `News fetch failed: ${err?.message ?? err}`);
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const b of blocks) {
    const rawTitle = tag(b, 'title');
    const source = tag(b, 'source');
    // Google News titles read "Headline - Source" — strip the trailing source.
    const title = source && rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3))
      : rawTitle;
    const pub = tag(b, 'pubDate');
    const ts = pub ? Date.parse(pub) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue; // too old
    items.push({ title, source, link: tag(b, 'link'), date: pub || null });
    if (items.length >= 8) break;
  }

  return { count: items.length, items };
});
