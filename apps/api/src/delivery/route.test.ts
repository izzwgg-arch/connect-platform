import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeRoute, type RouteStop } from "./routeOptimizer";
import { haversineMeters, type LatLng } from "./geo";
import { wazeNavUrl, wazeAppUrl, googleNavUrl, navUrlFor } from "./navLinks";

const start: LatLng = { lat: 40.0, lng: -74.0 };

function totalOf(seq: LatLng[]): number {
  let t = 0, prev = start;
  for (const s of seq) { t += haversineMeters(prev, s); prev = s; }
  return t;
}

test("optimize visits every stop exactly once", () => {
  const stops: RouteStop[] = [
    { id: "A", lat: 40.03, lng: -74.0 }, { id: "B", lat: 40.01, lng: -74.0 },
    { id: "C", lat: 40.04, lng: -74.0 }, { id: "D", lat: 40.02, lng: -74.0 },
  ];
  const r = optimizeRoute(start, stops);
  assert.deepEqual([...r.order].sort(), ["A", "B", "C", "D"]);
  assert.equal(r.legMeters.length, 4);
  assert.ok(Math.abs(r.totalMeters - r.legMeters.reduce((a, b) => a + b, 0)) < 1e-3);
});

test("colinear stops are ordered by distance from start (A,B,C,D)", () => {
  const stops: RouteStop[] = [
    { id: "D", lat: 40.04, lng: -74.0 }, { id: "B", lat: 40.02, lng: -74.0 },
    { id: "A", lat: 40.01, lng: -74.0 }, { id: "C", lat: 40.03, lng: -74.0 },
  ];
  const r = optimizeRoute(start, stops);
  assert.deepEqual(r.order, ["A", "B", "C", "D"]);
});

test("optimized route is no worse than the input order", () => {
  const stops: RouteStop[] = [
    { id: "A", lat: 40.05, lng: -74.0 }, { id: "B", lat: 40.01, lng: -74.05 },
    { id: "C", lat: 40.05, lng: -74.05 }, { id: "D", lat: 40.01, lng: -74.0 },
    { id: "E", lat: 40.03, lng: -74.02 },
  ];
  const inputTotal = totalOf(stops);
  const r = optimizeRoute(start, stops);
  const byId = new Map(stops.map((s) => [s.id, s]));
  const optTotal = totalOf(r.order.map((id) => byId.get(id)!));
  assert.ok(optTotal <= inputTotal + 1e-6, `optimized ${optTotal} > input ${inputTotal}`);
});

test("locked stops stay at the front in relative order", () => {
  const stops: RouteStop[] = [
    { id: "L1", lat: 40.09, lng: -74.0, locked: true }, { id: "L2", lat: 40.08, lng: -74.0, locked: true },
    { id: "X", lat: 40.01, lng: -74.0 }, { id: "Y", lat: 40.02, lng: -74.0 },
  ];
  const r = optimizeRoute(start, stops);
  assert.equal(r.order[0], "L1");
  assert.equal(r.order[1], "L2");
});

test("priority stops precede normal stops", () => {
  const stops: RouteStop[] = [
    { id: "N", lat: 40.01, lng: -74.0 }, { id: "P", lat: 40.09, lng: -74.0, priority: true },
  ];
  const r = optimizeRoute(start, stops);
  assert.equal(r.order[0], "P"); // priority first even though N is nearer
});

test("deterministic: same input → same output", () => {
  const stops: RouteStop[] = [
    { id: "A", lat: 40.03, lng: -74.01 }, { id: "B", lat: 40.02, lng: -74.03 }, { id: "C", lat: 40.04, lng: -74.02 },
  ];
  assert.deepEqual(optimizeRoute(start, stops).order, optimizeRoute(start, stops).order);
});

// ── nav links ────────────────────────────────────────────────────────────────
test("waze + google nav URLs are well-formed", () => {
  const d = { lat: 40.1234, lng: -74.5678 };
  assert.equal(wazeNavUrl(d), "https://waze.com/ul?ll=40.1234,-74.5678&navigate=yes");
  assert.equal(wazeAppUrl(d), "waze://?ll=40.1234,-74.5678&navigate=yes");
  assert.match(googleNavUrl(d), /google\.com\/maps\/dir\/\?api=1&destination=40\.1234,-74\.5678&travelmode=driving/);
  assert.equal(navUrlFor("waze", d), wazeNavUrl(d));
  assert.equal(navUrlFor("google", d), googleNavUrl(d));
});

test("nav URLs clamp out-of-range coords", () => {
  assert.match(wazeNavUrl({ lat: 999, lng: -999 }), /ll=90,-180&/);
});
