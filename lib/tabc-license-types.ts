// TABC license type codes and their plain-English descriptions
// Source: https://www.tabc.texas.gov/licenses-permits/license-permit-types/
export const TABC_LICENSE_TYPES: Record<string, { short: string; description: string }> = {
  AW: { short: "Agent's Permit (Wine)",     description: "Allows a wine representative to solicit orders from Texas retailers on behalf of a winery or wine importer." },
  BB: { short: "Brew Pub",                  description: "Allows a restaurant/bar to brew beer on-site and sell it for on-premise consumption or in sealed containers to go." },
  BC: { short: "Beverage Cartage",          description: "Permits a common carrier to transport alcoholic beverages between licensees." },
  BE: { short: "Beer Retailer (On-Premise)",description: "Allows a retail location (bar, restaurant) to sell beer for on-premise consumption only." },
  BF: { short: "Beer Retailer (Off-Premise)",description: "Allows a retail location (convenience/grocery store) to sell beer in sealed containers for off-premise consumption." },
  BG: { short: "Beer & Wine (On-Premise)",  description: "Allows a restaurant or bar to sell beer and wine for on-premise consumption. The most common restaurant alcohol permit." },
  BN: { short: "Beverage Distributor",      description: "Permits a distributor to sell malt beverages (beer/ale) to licensed retailers." },
  BQ: { short: "Beer & Ale Retailer",       description: "Allows a retail store to sell beer and ale in sealed containers for off-premise consumption." },
  BW: { short: "Brewer's Permit",           description: "Allows a brewery to manufacture and sell beer to distributors, retailers, and consumers at the brewery." },
  C:  { short: "Carrier",                   description: "Authorizes a common carrier (e.g., airline, railroad) to serve alcoholic beverages to passengers." },
  CD: { short: "Consumer Delivery",         description: "Allows a retailer to deliver sealed alcoholic beverages directly to consumers at their residence." },
  D:  { short: "Distiller's & Rectifier's", description: "Permits the manufacture, distillation, and sale of distilled spirits by a distillery." },
  DS: { short: "Distributor (Spirits)",     description: "Permits a distributor to sell distilled spirits (liquor) to licensed retailers and mixed beverage permit holders." },
  ET: { short: "Temporary Event",           description: "A temporary permit allowing the sale of alcoholic beverages at a specific, one-time event." },  E:  { short: "Wine Only Package Store",    description: "Allows a package store to sell wine only (no spirits) in sealed containers for off-premise consumption." },
  FB: { short: "Food & Bev. Certificate",    description: "A supplemental certificate required for certain mixed beverage permit holders to serve alcohol; mandates that a minimum percentage of revenue comes from food." },  FC: { short: "Food & Beverage Cert.",     description: "A certification allowing certain permit holders to serve spirits at events not held at their licensed premises." },
  G:  { short: "Wine & Beer Retailer",      description: "Allows a retail store (gas station, convenience store) to sell wine and beer for off-premise consumption." },
  "J/JD": { short: "Passenger Transport",  description: "Permits alcoholic beverage service aboard passenger transport vessels (boats, trains)." },
  LH: { short: "Late Hours",                 description: "A supplemental permit allowing a mixed beverage establishment to remain open and serve alcohol past the standard closing time (up to 2 AM)." },
  LP: { short: "Local Permit",               description: "A local permit required by certain municipalities or counties as a prerequisite for holding a state TABC license." },
  MB: { short: "Mixed Beverage",            description: "The full liquor license. Allows a restaurant or bar to sell mixed drinks, beer, and wine for on-premise consumption." },
  N:  { short: "Private Club",              description: "Allows a private, membership-based club to serve alcoholic beverages to its members." },
  NB: { short: "Non-Profit (Beer & Wine)",  description: "Authorizes a qualifying non-profit organization to sell beer and wine at events." },
  NE: { short: "Non-Profit (Beer Only)",    description: "Authorizes a qualifying non-profit organization to sell beer at events." },
  NT: { short: "Non-Profit Temporary",      description: "A temporary permit for a non-profit organization to sell alcoholic beverages at a specific fundraising event." },
  P:  { short: "Package Store",             description: "Allows a dedicated liquor store to sell distilled spirits, wine, and beer in sealed containers for off-premise consumption." },
  PR: { short: "Private Club Registration", description: "Registers a private club, allowing members to bring and consume their own alcoholic beverages on the premises." },
  Q:  { short: "Beer & Wine Off-Premise",   description: "Allows a retail store to sell beer and wine in sealed containers for off-premise consumption." },
  S:  { short: "Storage",                   description: "Permits a license holder to store alcoholic beverages at a location separate from their licensed premises." },
  SD: { short: "Solicitor's Permit (Distilled)", description: "Allows a distilled spirits representative to solicit orders from Texas retailers on behalf of a distillery or importer." },
  TR: { short: "Temporary (Restaurant)",    description: "A temporary extension allowing a current permit holder to serve alcohol at a temporary location or event." },
  W:  { short: "Winery Permit",             description: "Allows a winery to manufacture wine from Texas-grown grapes and sell it to distributors, retailers, and consumers." },
  X:  { short: "Local Distributor",         description: "Permits a local distributor to sell malt beverages within a defined territory to licensed retailers." },
};

export function getLicenseTypeInfo(code: string) {
  return TABC_LICENSE_TYPES[code?.toUpperCase()] ?? null;
}
