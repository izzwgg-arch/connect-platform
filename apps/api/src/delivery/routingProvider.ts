// Routing/Maps provider abstraction (Gate 3 interfaces). A real provider
// (Mapbox/Google/OSRM) implements RoutingProvider later; the haversine stub keeps the
// whole ETA pipeline working with zero external dependencies until then.

import { haversineMeters, type LatLng } from "./geo";

export interface RouteLeg {
  /** Estimated travel seconds from the previous point to this stop. */
  travelSeconds: number;
  /** Estimated distance meters for this leg. */
  distanceMeters: number;
}

export interface RoutingProvider {
  readonly name: string;
  /**
   * Estimate legs for an ordered path (origin → stop1 → stop2 …).
   * Returns one leg per destination point (path.length - 1 legs).
   */
  routeLegs(path: LatLng[]): Promise<RouteLeg[]>;
}

export interface MapsProvider {
  readonly name: string;
  geocode(address: string): Promise<LatLng | null>;
}

export interface HaversineOptions {
  /** Assumed average urban delivery speed (m/s). ~11.2 m/s ≈ 40 km/h. */
  avgSpeedMps?: number;
  /** Detour factor: road distance ≈ straight-line × this (urban ~1.35). */
  detourFactor?: number;
}

/**
 * Straight-line routing stub. Deterministic, no network. Applies a detour factor so
 * ETAs aren't absurdly optimistic vs. real roads. Pure given its options.
 */
export class HaversineRoutingProvider implements RoutingProvider {
  readonly name = "haversine-stub";
  private avg: number;
  private detour: number;

  constructor(opts: HaversineOptions = {}) {
    this.avg = opts.avgSpeedMps && opts.avgSpeedMps > 0 ? opts.avgSpeedMps : 11.2;
    this.detour = opts.detourFactor && opts.detourFactor >= 1 ? opts.detourFactor : 1.35;
  }

  async routeLegs(path: LatLng[]): Promise<RouteLeg[]> {
    const legs: RouteLeg[] = [];
    for (let i = 1; i < path.length; i++) {
      const straight = haversineMeters(path[i - 1], path[i]);
      const distanceMeters = straight * this.detour;
      legs.push({ distanceMeters, travelSeconds: distanceMeters / this.avg });
    }
    return legs;
  }
}
