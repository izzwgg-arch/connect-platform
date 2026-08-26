// Navigation deep links — PURE. Builds Waze / Google Maps navigation URLs for a single
// destination (the current stop). Waze has no multi-stop API, so the app navigates one leg
// at a time using the optimized order from routeOptimizer.ts.

export interface LatLng {
  lat: number;
  lng: number;
}

function clampCoord(v: number, max: number): number {
  return Math.max(-max, Math.min(max, v));
}

/** Waze universal link — opens the Waze app if installed, else the web fallback. */
export function wazeNavUrl(dest: LatLng): string {
  const lat = clampCoord(dest.lat, 90);
  const lng = clampCoord(dest.lng, 180);
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

/** Waze app scheme (for explicit app-open on mobile). */
export function wazeAppUrl(dest: LatLng): string {
  const lat = clampCoord(dest.lat, 90);
  const lng = clampCoord(dest.lng, 180);
  return `waze://?ll=${lat},${lng}&navigate=yes`;
}

/** Google Maps navigation (driving) — fallback / driver preference. */
export function googleNavUrl(dest: LatLng): string {
  const lat = clampCoord(dest.lat, 90);
  const lng = clampCoord(dest.lng, 180);
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

/** Apple Maps driving directions — iPhone drivers (opens the Maps app on iOS). */
export function appleNavUrl(dest: LatLng): string {
  const lat = clampCoord(dest.lat, 90);
  const lng = clampCoord(dest.lng, 180);
  return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`;
}

export type NavApp = "waze" | "google" | "apple";

export function navUrlFor(app: NavApp, dest: LatLng): string {
  if (app === "waze") return wazeNavUrl(dest);
  if (app === "apple") return appleNavUrl(dest);
  return googleNavUrl(dest);
}
