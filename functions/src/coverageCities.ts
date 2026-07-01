/**
 * Coverage cities for the Places-discovery ingests (attorneys, medical, home
 * services, restaurants/bars). This is the WHOLE coverage area — every town of
 * note across the 9 coverage counties — so discovery is effectively county-wide,
 * not limited to a handful of population centers.
 *
 * NOTE: this is distinct from broadcastCities.ts. The broadcast-city list is for
 * the HS-football footprint scoring ONLY; the discovery ingests use this map.
 *
 * Counties: Travis, Williamson, Hays, Bastrop, Caldwell, Blanco, Burnet, Llano,
 * Gillespie.
 */

/**
 * Normalized lookup (lowercased city -> canonical city + county). Used by every
 * Places-discovery ingest to resolve a result's TRUE city/county from its
 * address and reject out-of-area hits — Google's text search returns statewide
 * matches for sparse small-town queries, so we must trust the address, never the
 * query city.
 */
export function resolveCoverageCity(rawCity: string): { city: string; county: string } | null {
  return COVERAGE_LOOKUP[String(rawCity ?? '').trim().toLowerCase()] ?? null;
}

/**
 * Parse a Google-formatted address into street / city / zip. The city is the
 * comma part immediately before the "TX 78745" state+zip part — robust to a
 * suite living in an earlier part (e.g. "123 Main St, Ste A, Austin, TX 78701").
 */
export function parseCoverageAddress(formatted: string): { street: string; city: string; zip: string } {
  const parts = String(formatted ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const zip = (String(formatted ?? '').match(/\b(\d{5})\b/) ?? [])[1] ?? '';
  let city = '';
  const stateIdx = parts.findIndex((p) => /^TX\b/i.test(p) || /\bTX\s*\d{5}\b/i.test(p));
  if (stateIdx > 0) city = parts[stateIdx - 1] ?? '';
  return { street: parts[0] ?? '', city, zip };
}

export const COVERAGE_CITY_COUNTY: Record<string, string> = {
  // Travis
  'Austin': 'Travis', 'Pflugerville': 'Travis', 'Lakeway': 'Travis', 'Bee Cave': 'Travis',
  'Manor': 'Travis', 'Lago Vista': 'Travis', 'Jonestown': 'Travis', 'Creedmoor': 'Travis',
  'Rollingwood': 'Travis', 'Sunset Valley': 'Travis', 'West Lake Hills': 'Travis', 'Del Valle': 'Travis',
  // Williamson
  'Round Rock': 'Williamson', 'Cedar Park': 'Williamson', 'Georgetown': 'Williamson', 'Leander': 'Williamson',
  'Hutto': 'Williamson', 'Taylor': 'Williamson', 'Liberty Hill': 'Williamson', 'Granger': 'Williamson',
  'Bartlett': 'Williamson', 'Florence': 'Williamson', 'Jarrell': 'Williamson', 'Thrall': 'Williamson',
  'Coupland': 'Williamson',
  // Hays
  'San Marcos': 'Hays', 'Kyle': 'Hays', 'Buda': 'Hays', 'Dripping Springs': 'Hays',
  'Wimberley': 'Hays', 'Woodcreek': 'Hays', 'Driftwood': 'Hays', 'Mountain City': 'Hays',
  'Niederwald': 'Hays', 'Uhland': 'Hays',
  // Bastrop
  'Bastrop': 'Bastrop', 'Elgin': 'Bastrop', 'Smithville': 'Bastrop', 'Cedar Creek': 'Bastrop',
  'Red Rock': 'Bastrop', 'Paige': 'Bastrop', 'McDade': 'Bastrop',
  // Caldwell
  'Lockhart': 'Caldwell', 'Luling': 'Caldwell', 'Martindale': 'Caldwell', 'Dale': 'Caldwell',
  'Maxwell': 'Caldwell', 'Fentress': 'Caldwell', 'Prairie Lea': 'Caldwell',
  // Blanco
  'Blanco': 'Blanco', 'Johnson City': 'Blanco', 'Round Mountain': 'Blanco',
  // Burnet
  'Marble Falls': 'Burnet', 'Burnet': 'Burnet', 'Bertram': 'Burnet', 'Granite Shoals': 'Burnet',
  'Cottonwood Shores': 'Burnet', 'Meadowlakes': 'Burnet', 'Spicewood': 'Burnet',
  // Llano
  'Llano': 'Llano', 'Horseshoe Bay': 'Llano', 'Kingsland': 'Llano', 'Sunrise Beach Village': 'Llano',
  'Buchanan Dam': 'Llano', 'Tow': 'Llano',
  // Gillespie
  'Fredericksburg': 'Gillespie', 'Harper': 'Gillespie', 'Stonewall': 'Gillespie',
};

const COVERAGE_LOOKUP: Record<string, { city: string; county: string }> = Object.fromEntries(
  Object.entries(COVERAGE_CITY_COUNTY).map(([city, county]) => [city.toLowerCase(), { city, county }])
);
