// Geocoding — provider-agnostic. Turns an order address into lat/lng so route optimization +
// Waze work for address-only orders. The query builder + response parser are PURE (testable);
// the HTTP call is config-driven so any provider (Nominatim/Mapbox/Google) plugs in via env.

import type { LatLng } from "./geo";

export interface GeocodeAddress {
  line1: string;
  unit?: string | null;
  city?: string | null;
  region?: string | null;
  postal?: string | null;
}

/** Build a single-line query string from address parts. Pure. */
export function buildGeocodeQuery(a: GeocodeAddress): string {
  return [a.line1, a.city, a.region, a.postal].map((x) => (x || "").trim()).filter(Boolean).join(", ");
}

export type GeocoderFormat = "nominatim" | "mapbox" | "google";

/** Parse a provider response into coordinates. Pure — never throws. */
export function parseGeocodeResponse(format: GeocoderFormat, json: any): LatLng | null {
  try {
    if (format === "nominatim") {
      const r = Array.isArray(json) ? json[0] : null;
      if (r && r.lat != null && r.lon != null) return { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
      return null;
    }
    if (format === "mapbox") {
      const c = json?.features?.[0]?.center;
      if (Array.isArray(c) && c.length === 2) return { lat: c[1], lng: c[0] };
      return null;
    }
    if (format === "google") {
      const loc = json?.results?.[0]?.geometry?.location;
      if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") return { lat: loc.lat, lng: loc.lng };
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

export interface GeocodingProvider {
  readonly name: string;
  geocode(address: GeocodeAddress): Promise<LatLng | null>;
}

/** Disabled provider (default). Returns null so nothing is geocoded until one is configured. */
export class NoopGeocodingProvider implements GeocodingProvider {
  readonly name = "noop";
  async geocode(): Promise<LatLng | null> { return null; }
}

/**
 * Config-driven HTTP geocoder. Env:
 *   DELIVERY_GEOCODER_URL    — URL template containing {q} (URL-encoded query is substituted)
 *   DELIVERY_GEOCODER_FORMAT — nominatim | mapbox | google
 * Example (Nominatim): https://nominatim.example/search?format=json&q={q}
 */
export class HttpGeocodingProvider implements GeocodingProvider {
  readonly name = "http";
  constructor(private urlTemplate: string, private format: GeocoderFormat) {}
  async geocode(address: GeocodeAddress): Promise<LatLng | null> {
    const q = buildGeocodeQuery(address);
    if (!q) return null;
    const url = this.urlTemplate.replace("{q}", encodeURIComponent(q));
    try {
      const res = await fetch(url, { headers: { "user-agent": "connect-delivery/1.0" } });
      if (!res.ok) return null;
      return parseGeocodeResponse(this.format, await res.json());
    } catch {
      return null;
    }
  }
}

/** Resolve the configured provider from env (noop by default — no external calls). */
export function geocoderFromEnv(): GeocodingProvider {
  const url = process.env.DELIVERY_GEOCODER_URL;
  const fmt = process.env.DELIVERY_GEOCODER_FORMAT as GeocoderFormat | undefined;
  if (url && fmt && ["nominatim", "mapbox", "google"].includes(fmt)) return new HttpGeocodingProvider(url, fmt);
  return new NoopGeocodingProvider();
}
