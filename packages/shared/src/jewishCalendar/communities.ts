/**
 * Where the customer is — the list they pick from for candle lighting and
 * nightfall.
 *
 * This exists because `Tenant` has no address column, only a timezone, so there
 * is nothing to compute a sunset from. A short list of the places Connect
 * actually serves beats a map picker and beats asking for coordinates.
 *
 * ⛔⛔ DIASPORA ONLY, AND THAT IS NOT AN OVERSIGHT. The generated holiday table
 * is built with `il: false` — second-day yom tov, eight-day Pesach, Simchas
 * Torah as its own day. Offering an Israeli city would hand that customer a
 * calendar that closes their phone for a day Israel does not keep, and opens it
 * on Chol Hamoed they do. Israel needs its own generated table before it can be
 * offered at all.
 */
export interface JewishCommunity {
  id: string;
  label: string;
  /** Shown under the label — the postcode people recognise. */
  detail: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export const JEWISH_COMMUNITIES: readonly JewishCommunity[] = [
  // New York — Rockland and Orange
  { id: "monsey", label: "Monsey / Spring Valley, NY", detail: "10952", latitude: 41.1112, longitude: -74.0687, timezone: "America/New_York" },
  { id: "kiryas-joel", label: "Kiryas Joel / Monroe, NY", detail: "10950", latitude: 41.3401, longitude: -74.1668, timezone: "America/New_York" },
  { id: "new-square", label: "New Square, NY", detail: "10977", latitude: 41.1387, longitude: -74.0290, timezone: "America/New_York" },
  { id: "suffern", label: "Suffern / Airmont, NY", detail: "10901", latitude: 41.1148, longitude: -74.1496, timezone: "America/New_York" },
  // New York City
  { id: "boro-park", label: "Boro Park, Brooklyn", detail: "11219", latitude: 40.6323, longitude: -73.9938, timezone: "America/New_York" },
  { id: "williamsburg", label: "Williamsburg, Brooklyn", detail: "11211", latitude: 40.7081, longitude: -73.9571, timezone: "America/New_York" },
  { id: "flatbush", label: "Flatbush, Brooklyn", detail: "11230", latitude: 40.6252, longitude: -73.9626, timezone: "America/New_York" },
  { id: "crown-heights", label: "Crown Heights, Brooklyn", detail: "11213", latitude: 40.6694, longitude: -73.9422, timezone: "America/New_York" },
  { id: "five-towns", label: "Five Towns / Lawrence, NY", detail: "11559", latitude: 40.6165, longitude: -73.7301, timezone: "America/New_York" },
  { id: "queens", label: "Kew Gardens Hills, Queens", detail: "11367", latitude: 40.7325, longitude: -73.8203, timezone: "America/New_York" },
  { id: "monroe-woodbury", label: "Harriman / Woodbury, NY", detail: "10926", latitude: 41.3084, longitude: -74.1435, timezone: "America/New_York" },
  // New Jersey
  { id: "lakewood", label: "Lakewood, NJ", detail: "08701", latitude: 40.0979, longitude: -74.2179, timezone: "America/New_York" },
  { id: "passaic", label: "Passaic / Clifton, NJ", detail: "07055", latitude: 40.8568, longitude: -74.1285, timezone: "America/New_York" },
  { id: "teaneck", label: "Teaneck, NJ", detail: "07666", latitude: 40.8976, longitude: -74.0160, timezone: "America/New_York" },
  // Elsewhere in the US
  { id: "baltimore", label: "Baltimore, MD", detail: "21215", latitude: 39.3489, longitude: -76.6836, timezone: "America/New_York" },
  { id: "lakewood-fl", label: "Miami Beach, FL", detail: "33140", latitude: 25.8146, longitude: -80.1300, timezone: "America/New_York" },
  { id: "cleveland", label: "Cleveland Heights, OH", detail: "44118", latitude: 41.5201, longitude: -81.5562, timezone: "America/New_York" },
  { id: "detroit", label: "Oak Park, MI", detail: "48237", latitude: 42.4595, longitude: -83.1827, timezone: "America/Detroit" },
  { id: "chicago", label: "West Rogers Park, Chicago", detail: "60645", latitude: 42.0064, longitude: -87.6947, timezone: "America/Chicago" },
  { id: "los-angeles", label: "La Brea, Los Angeles", detail: "90035", latitude: 34.0522, longitude: -118.3617, timezone: "America/Los_Angeles" },
  // Canada
  { id: "toronto", label: "Thornhill / Toronto, ON", detail: "L4J", latitude: 43.8087, longitude: -79.4232, timezone: "America/Toronto" },
  { id: "montreal", label: "Outremont, Montreal, QC", detail: "H2V", latitude: 45.5199, longitude: -73.6103, timezone: "America/Toronto" },
  // UK and Europe
  { id: "stamford-hill", label: "Stamford Hill, London", detail: "N16", latitude: 51.5686, longitude: -0.0741, timezone: "Europe/London" },
  { id: "manchester", label: "Manchester, UK", detail: "M8", latitude: 53.5228, longitude: -2.2470, timezone: "Europe/London" },
  { id: "antwerp", label: "Antwerp, Belgium", detail: "2018", latitude: 51.2100, longitude: 4.4207, timezone: "Europe/Brussels" },
];

export function findCommunity(id: string | null | undefined): JewishCommunity | null {
  if (!id) return null;
  return JEWISH_COMMUNITIES.find((c) => c.id === id) ?? null;
}

/** The community whose coordinates are closest — for suggesting one from a timezone. */
export function suggestCommunityForTimezone(timezone: string): JewishCommunity {
  return JEWISH_COMMUNITIES.find((c) => c.timezone === timezone) ?? JEWISH_COMMUNITIES[0];
}
