// Route optimizer — PURE. Computes a good visit order for a run's stops (the "best route"):
// nearest-neighbor seed + 2-opt improvement over great-circle distances. Deterministic.
// Real road distances plug in later via RoutingProvider; the algorithm is unchanged.
//
// Waze has no multi-stop API, so we optimize the ORDER here and hand each leg to Waze
// one destination at a time (see navLinks.ts + the driver "navigate" action).

import { haversineMeters, type LatLng } from "./geo";

export interface RouteStop extends LatLng {
  id: string;
  /** Optional hard priority — priority stops are kept ahead of non-priority ones. */
  priority?: boolean;
  /** Locked position (e.g. already delivered / in progress) — excluded from reordering. */
  locked?: boolean;
}

export interface OptimizedRoute {
  order: string[]; // stop ids in visit order
  totalMeters: number;
  legMeters: number[]; // meters per leg from the previous point (order[i-1] → order[i]); leg 0 = start → order[0]
}

function dist(a: LatLng, b: LatLng): number {
  return haversineMeters(a, b);
}

function totalFor(start: LatLng, seq: RouteStop[]): number {
  let t = 0;
  let prev: LatLng = start;
  for (const s of seq) {
    t += dist(prev, s);
    prev = s;
  }
  return t;
}

/** Nearest-neighbor seed starting from `start`. */
function nearestNeighbor(start: LatLng, stops: RouteStop[]): RouteStop[] {
  const remaining = [...stops];
  const out: RouteStop[] = [];
  let cur: LatLng = start;
  while (remaining.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(cur, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    const [chosen] = remaining.splice(bi, 1);
    out.push(chosen);
    cur = chosen;
  }
  return out;
}

/** 2-opt improvement (bounded). Reverses segments while it reduces total distance. */
function twoOpt(start: LatLng, seq: RouteStop[], maxPasses = 40): RouteStop[] {
  const route = [...seq];
  const n = route.length;
  if (n < 4) return route;
  let improved = true;
  let passes = 0;
  while (improved && passes < maxPasses) {
    improved = false;
    passes++;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const before = totalFor(start, route);
        const candidate = route.slice(0, i).concat(route.slice(i, k + 1).reverse(), route.slice(k + 1));
        const after = totalFor(start, candidate);
        if (after + 1e-6 < before) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return route;
}

/**
 * Optimize the visit order. Locked stops keep their relative order at the front; priority
 * stops are optimized as a group ahead of the rest. Pure & deterministic.
 */
export function optimizeRoute(start: LatLng, stops: RouteStop[]): OptimizedRoute {
  const locked = stops.filter((s) => s.locked);
  const free = stops.filter((s) => !s.locked);
  const priority = free.filter((s) => s.priority);
  const normal = free.filter((s) => !s.priority);

  // Seed each group from the running "cursor" so priority stops precede normal ones.
  const afterLocked: LatLng = locked.length ? locked[locked.length - 1] : start;
  const optPriority = priority.length ? twoOpt(afterLocked, nearestNeighbor(afterLocked, priority)) : [];
  const afterPriority: LatLng = optPriority.length ? optPriority[optPriority.length - 1] : afterLocked;
  const optNormal = normal.length ? twoOpt(afterPriority, nearestNeighbor(afterPriority, normal)) : [];

  const seq = [...locked, ...optPriority, ...optNormal];

  const legMeters: number[] = [];
  let prev: LatLng = start;
  for (const s of seq) { legMeters.push(dist(prev, s)); prev = s; }

  return { order: seq.map((s) => s.id), totalMeters: legMeters.reduce((a, b) => a + b, 0), legMeters };
}
