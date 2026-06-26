/**
 * Sun Radio HS-football broadcast footprint — the towns whose games Sun Radio
 * carries. A business's "footprint" = how many of these towns it operates in,
 * which drives the football-sponsor campaign fit (a regional advertiser wanting
 * goodwill across the whole map is the ideal sponsor).
 *
 * Derived from Sun Radio's school list; where a high school's name differs from
 * its FDIC city, we use the city (the names below in comments are the schools):
 *   Hays HS → Kyle · Lake Travis HS → Lakeway · Harlan HS → San Antonio ·
 *   Furr HS → Houston · Navarro/Geronimo → Geronimo
 * Edit here; everything downstream (bank ingest footprint, campaign fit) reads
 * from this one source.
 */

export const BROADCAST_CITIES: string[] = [
  'Austin', 'Bandera', 'Blanco', 'Brady', 'Buda', 'Comfort', 'Cuero',
  'Del Valle', 'Dripping Springs', 'El Campo', 'Florence', 'Houston',     // Furr HS
  'Geronimo',                                                             // Navarro ISD
  'Giddings', 'Gonzales', 'Harker Heights', 'San Antonio',               // incl. Harlan HS
  'Kyle',                                                                 // Hays HS
  'Ingram', 'La Grange', 'Lago Vista', 'Lakeway',                        // Lake Travis HS
  'Lexington', 'Llano', 'Manor', 'Marion', 'Mathis', 'Pearsall',
  'Rockdale', 'Round Rock', 'Sinton', 'Smithville', 'Wimberley',
];

/** Normalized lookup set for fast, case-insensitive city matching. */
const BROADCAST_SET = new Set(BROADCAST_CITIES.map((c) => c.toLowerCase().trim()));

/** True when a city name is part of the broadcast footprint. */
export function isBroadcastCity(city: string | undefined | null): boolean {
  return BROADCAST_SET.has(String(city ?? '').toLowerCase().trim());
}

/** Canonical-cased broadcast city for a raw name, or null if it's not in the footprint. */
export function canonicalBroadcastCity(city: string | undefined | null): string | null {
  const key = String(city ?? '').toLowerCase().trim();
  const i = BROADCAST_CITIES.findIndex((c) => c.toLowerCase() === key);
  return i >= 0 ? BROADCAST_CITIES[i] : null;
}
