/**
 * Sun Radio HS-football broadcast footprint — the Central Texas towns whose games
 * Sun Radio carries. A business's "footprint" = how many of these towns it operates
 * in, which drives the football-sponsor campaign fit (a regional advertiser wanting
 * goodwill across the whole map is the ideal sponsor).
 *
 * SEED LIST — replace with Sun Radio's exact 35+ city list. Edit here; everything
 * downstream (bank ingest footprint, campaign fit) reads from this one source.
 */

export const BROADCAST_CITIES: string[] = [
  'Austin', 'Round Rock', 'Cedar Park', 'Georgetown', 'Pflugerville', 'Leander',
  'Hutto', 'Taylor', 'Elgin', 'Bastrop', 'Smithville', 'Lockhart', 'Luling',
  'San Marcos', 'Kyle', 'Buda', 'Dripping Springs', 'Wimberley', 'New Braunfels',
  'Seguin', 'Marble Falls', 'Burnet', 'Llano', 'Fredericksburg', 'Johnson City',
  'Blanco', 'Lampasas', 'Killeen', 'Copperas Cove', 'Harker Heights', 'Belton',
  'Temple', 'Salado', 'Gatesville', 'Lago Vista', 'Liberty Hill', 'Manor',
  'Bertram', 'Granger', 'Florence',
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
