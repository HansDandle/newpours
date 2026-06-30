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
