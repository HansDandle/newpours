/**
 * Lead categorization — buckets every lead into one marketing vertical so the
 * category can drive segmented email campaigns (and A/B tests) in HubSpot.
 *
 * One primary category per lead keeps campaign segments clean (a contact lands
 * in exactly one bucket). Priority: nonprofit NTEE > apartments > name/permit
 * keywords > alcohol-license default.
 */

export const LEAD_CATEGORIES = [
  'Food & Drink',
  'Medical',
  'Kids & Family',
  'Fitness & Beauty',
  'Retail & Services',
  'Housing',
  'Nonprofit',
  'Legal',
  'Financial',
  'Home Services',
  'Other',
] as const;

export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

// IRS NTEE major group (first letter) → category.
const NTEE_CATEGORY: Record<string, LeadCategory> = {
  E: 'Medical',        // Health care
  F: 'Medical',        // Mental health
  G: 'Medical',        // Diseases / disorders
  H: 'Medical',        // Medical research
  B: 'Kids & Family',  // Education
  O: 'Kids & Family',  // Youth development
};

// Checked in order — first hit wins, so more specific verticals come first.
const KEYWORDS: Array<[LeadCategory, RegExp]> = [
  ['Medical', /\b(medical|dental|dentist|orthodont|clinic|health|hospital|urgent care|pharmacy|dermatolog|chiropract|physical therapy|veterinar|\bvet\b|wellness|surgery|surgical|pediatric|optometr|eye care|imaging|cardiolog|oncolog|psychiatr|therapy)\b/i],
  ['Kids & Family', /\b(daycare|day care|child care|childcare|preschool|pre-school|montessori|learning center|tutoring|\bkids\b|children|playschool|nursery|academy)\b/i],
  ['Fitness & Beauty', /\b(gym|fitness|crossfit|yoga|pilates|salon|spa|nails?|barber|beauty|aesthetic|massage|tanning)\b/i],
  ['Food & Drink', /\b(restaurant|cafe|café|grill|brewery|brewing|coffee|kitchen|taco|pizza|bbq|barbecue|bakery|eatery|cantina|\bpub\b|bistro|diner|tavern|winery|distill|taproom|\bbar\b)\b/i],
  ['Retail & Services', /\b(retail|store|shop|boutique|market|grocery|automotive|\bauto\b|repair|cleaners|laundry|hardware)\b/i],
];

interface CategorizeInput {
  businessName?: string;
  sources?: Array<{ type?: string; raw?: Record<string, any>; licenseType?: string }>;
}

/** Resolve a lead's single primary marketing category. */
export function computeCategory(input: CategorizeInput): LeadCategory {
  const sources = input.sources ?? [];
  const hasType = (t: string) => sources.some((s) => s.type === t);

  // Nonprofit: NTEE drives the bucket; fall back to a generic Nonprofit bucket.
  if (hasType('nonprofit_990')) {
    const ntee = String(sources.find((s) => s.type === 'nonprofit_990')?.raw?.ntee ?? '').trim().toUpperCase();
    return NTEE_CATEGORY[ntee.charAt(0)] ?? 'Nonprofit';
  }

  // New apartment community.
  if (hasType('building_permit')) return 'Housing';

  // Law firm discovered via Google Places.
  if (hasType('attorney')) return 'Legal';

  // Bank / credit-union branch network.
  if (hasType('bank_branch')) return 'Financial';

  // Medical facility from the NPPES registry.
  if (hasType('medical_npi')) return 'Medical';

  // Home-services company (pest control, HVAC, roofing, …).
  if (hasType('home_services')) return 'Home Services';

  // Restaurant/bar discovered via Google Places.
  if (hasType('food_drink')) return 'Food & Drink';

  // Keyword match across the name + permit descriptions + license type.
  const parts: string[] = [input.businessName ?? ''];
  for (const s of sources) {
    if (s.raw) {
      parts.push(String(s.raw.description ?? ''), String(s.raw.facilityName ?? ''), String(s.raw.projectName ?? ''));
    }
    if (s.licenseType) parts.push(s.licenseType);
  }
  const hay = parts.join(' ').toLowerCase();
  for (const [cat, re] of KEYWORDS) {
    if (re.test(hay)) return cat;
  }

  // An alcohol/event license with no other signal is almost always food & drink.
  if (hasType('tabc') || hasType('tabc_event') || hasType('event')) return 'Food & Drink';

  return 'Other';
}
