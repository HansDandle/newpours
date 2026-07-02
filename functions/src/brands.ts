/**
 * Brand grouping + national-chain detection.
 *
 * Multi-office local businesses (Daniel Stark's two offices, ARA Imaging's 16
 * clinics) show up as one lead per Google Places location. We group them by their
 * registrable website domain so the UI can collapse them and enrichment can run
 * once per brand instead of once per office.
 *
 * National chains (Domino's, Dollar General, …) advertise nationally, not on a
 * local station — we tag them so they can be filtered out, without deleting.
 */

// Website hosts that are NOT a business's own domain — a shared page here must
// never group unrelated businesses together (or tag them as a chain).
const SOCIAL_DOMAINS = new Set([
  'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'twitter.com',
  'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'yelp.com', 'google.com',
  'sites.google.com', 'business.site', 'business.google.com', 'goo.gl', 'linktr.ee',
  'wixsite.com', 'squarespace.com', 'godaddysites.com', 'weebly.com', 'wordpress.com',
  'blogspot.com', 'shopify.com', 'square.site', 'toasttab.com', 'clover.com',
]);

// Known national/corporate chains (registrable domain). Intentionally a curated
// starter list of the obvious ones — easy to extend as more surface.
const NATIONAL_CHAIN_DOMAINS = new Set([
  // QSR / food
  'dominos.com', 'pizzahut.com', 'papajohns.com', 'littlecaesars.com', 'marcos.com',
  'doubledaves.com', 'chilis.com', 'applebees.com', 'olivegarden.com', 'ihop.com',
  'dennys.com', 'subway.com', 'jimmyjohns.com', 'jerseymikes.com', 'firehousesubs.com',
  'mcdonalds.com', 'burgerking.com', 'wendys.com', 'tacobell.com', 'kfc.com',
  'sonicdrivein.com', 'arbys.com', 'popeyes.com', 'chick-fil-a.com', 'raisingcanes.com',
  'starbucks.com', 'dunkindonuts.com', 'dunkin.com', 'panerabread.com', 'chipotle.com',
  'panda-express.com', 'pandaexpress.com', 'fivethirtyburgers.com', 'freddys.com',
  'wingstop.com', 'jasons-deli.com', 'schlotzskys.com',
  // Retail / grocery / pharmacy
  'walmart.com', 'target.com', 'dollargeneral.com', 'dollartree.com', 'familydollar.com',
  'cvs.com', 'walgreens.com', 'heb.com', 'kroger.com', 'costco.com', 'samsclub.com',
  'homedepot.com', 'lowes.com', 'bestbuy.com', 'petsmart.com', 'petco.com',
  'gnc.com', 'gamestop.com', 'autozone.com', 'oreillyauto.com', 'advanceautoparts.com',
  'napaonline.com', 'discounttire.com', 'firestonecompleteautocare.com', 'take5.com',
  // Services / health / fitness
  'thejoint.com', 'planetfitness.com', 'anytimefitness.com', 'orangetheory.com',
  'massageenvy.com', 'europeanwax.com', 'greatclips.com', 'sportclips.com',
  'jiffylube.com', 'valvoline.com', 'midas.com', 'meineke.com',
]);

// Fallback: brand-name patterns for chains that may have odd/missing domains.
const NATIONAL_CHAIN_NAMES: RegExp[] = [
  /\b(domino'?s|pizza hut|papa john'?s|little caesars|marco'?s pizza|doubledave'?s)\b/i,
  /\b(chili'?s|applebee'?s|olive garden|ihop|denny'?s|whataburger|mcdonald'?s|burger king)\b/i,
  /\b(subway|jimmy john'?s|jersey mike'?s|firehouse subs|wingstop|schlotzsky'?s)\b/i,
  /\b(starbucks|dunkin|panera|chipotle|panda express|raising cane'?s|popeyes|sonic drive)\b/i,
  /\b(walmart|target|dollar general|dollar tree|family dollar|cvs|walgreens|costco|sam'?s club)\b/i,
  /\b(home depot|lowe'?s|best buy|petsmart|petco|gamestop|autozone|o'?reilly auto|advance auto)\b/i,
  /\b(napa auto|discount tire|the joint chiropractic|planet fitness|anytime fitness|orangetheory)\b/i,
  /\b(massage envy|european wax|great clips|sport clips|jiffy lube|valvoline|midas|meineke)\b/i,
];

/** Registrable domain (eTLD+1 heuristic for US TLDs) from a website, or ''. */
export function registrableDomain(website?: string): string {
  if (!website) return '';
  let host: string;
  try {
    host = new URL(website.startsWith('http') ? website : `https://${website}`).hostname.toLowerCase();
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '');
  const parts = host.split('.');
  // Reduce subdomains to the last two labels (locations.pizzahut.com -> pizzahut.com).
  // Fine for the .com/.org/.net domains these businesses use.
  if (parts.length > 2) host = parts.slice(-2).join('.');
  return host;
}

/** Brand group key for a lead — its registrable domain, unless that's a shared
 * social/aggregator host (which must not group unrelated businesses). '' = ungrouped. */
export function brandGroupKey(website?: string): string {
  const d = registrableDomain(website);
  if (!d || SOCIAL_DOMAINS.has(d)) return '';
  return d;
}

/** Whether a lead is a national/corporate chain (tagged, not deleted). */
export function isNationalChain(businessName?: string, website?: string): boolean {
  const d = registrableDomain(website);
  if (d && NATIONAL_CHAIN_DOMAINS.has(d)) return true;
  const name = String(businessName ?? '');
  return NATIONAL_CHAIN_NAMES.some((re) => re.test(name));
}
