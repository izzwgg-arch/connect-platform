// Geo helpers — PURE. Haversine distance + bearing. No external maps dependency.

export interface LatLng {
  lat: number;
  lng: number;
}

const R_METERS = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total path length in meters across an ordered list of points. */
export function pathMeters(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

export function isPlausibleCoord(p: Partial<LatLng>): p is LatLng {
  return (
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/**
 * Detect an implausible jump between two fixes given the elapsed time.
 * Guards against GPS glitches / spoofing (server-side plausibility check).
 */
export function isImplausibleJump(a: LatLng, b: LatLng, elapsedSec: number, maxSpeedMps = 60): boolean {
  if (elapsedSec <= 0) return false;
  const speed = haversineMeters(a, b) / elapsedSec;
  return speed > maxSpeedMps; // > ~216 km/h ⇒ implausible for a delivery vehicle
}
