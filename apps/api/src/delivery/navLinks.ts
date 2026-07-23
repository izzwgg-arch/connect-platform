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

export type NavApp = "waze" | "google";

export function navUrlFor(app: NavApp, dest: LatLng): string {
  return app === "waze" ? wazeNavUrl(dest) : googleNavUrl(dest);
}
