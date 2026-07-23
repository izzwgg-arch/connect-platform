import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMeters, isImplausibleJump, isPlausibleCoord } from "./geo";
import { HaversineRoutingProvider } from "./routingProvider";
import { computeMovement } from "./staleness";
import { decideReveal } from "./progressiveReveal";
import { computeEta } from "./eta";

// ── geo ──────────────────────────────────────────────────────────────────────
test("haversine distance is sane (~1.11km per 0.01° lat)", () => {
  const d = haversineMeters({ lat: 40.0, lng: -74.0 }, { lat: 40.01, lng: -74.0 });
  assert.ok(d > 1100 && d < 1120, `got ${d}`);
});

test("implausible jump detection", () => {
  const a = { lat: 40.0, lng: -74.0 };
  const b = { lat: 41.0, lng: -74.0 }; // ~111 km
  assert.equal(isImplausibleJump(a, b, 60), true); // 111km in 60s → absurd
  assert.equal(isImplausibleJump(a, b, 3600), false); // 111km in 1h → fine
});

test("coord plausibility rejects out-of-range/NaN", () => {
  assert.equal(isPlausibleCoord({ lat: 91, lng: 0 }), false);
  assert.equal(isPlausibleCoord({ lat: 10, lng: NaN }), false);
  assert.equal(isPlausibleCoord({ lat: 10, lng: 20 }), true);
});

// ── routing stub ──────────────────────────────────────────────────────────────
test("haversine routing returns one leg per destination with detour applied", async () => {
  const rp = new HaversineRoutingProvider({ avgSpeedMps: 10, detourFactor: 1.5 });
  const legs = await rp.routeLegs([
    { lat: 40.0, lng: -74.0 },
    { lat: 40.01, lng: -74.0 },
    { lat: 40.02, lng: -74.0 },
  ]);
  assert.equal(legs.length, 2);
  // straight ~1113m × 1.5 detour = ~1670m; /10 mps ≈ 167s
  assert.ok(legs[0].travelSeconds > 150 && legs[0].travelSeconds < 185, `got ${legs[0].travelSeconds}`);
});

// ── staleness ────────────────────────────────────────────────────────────────
test("movement classification: moving / stopped / stale / offline / unknown", () => {
  const now = 1_000_000;
  assert.equal(computeMovement({ lastSampleAtMs: now - 5_000, nowMs: now, speedMps: 8 }).status, "moving");
  assert.equal(computeMovement({ lastSampleAtMs: now - 5_000, nowMs: now, speedMps: 0 }).status, "stopped");
  assert.equal(computeMovement({ lastSampleAtMs: now - 120_000, nowMs: now }).status, "stale");
  assert.equal(computeMovement({ lastSampleAtMs: now - 600_000, nowMs: now }).status, "offline");
  assert.equal(computeMovement({ lastSampleAtMs: null, nowMs: now }).status, "unknown");
});

test("stale/offline fixes are never marked live", () => {
  const now = 1_000_000;
  assert.equal(computeMovement({ lastSampleAtMs: now - 120_000, nowMs: now }).isLive, false);
  assert.equal(computeMovement({ lastSampleAtMs: now - 5_000, nowMs: now, speedMps: 8 }).isLive, true);
});

// ── progressive reveal (decision 1) ─────────────────────────────────────────────
test("progressive: exact pin only when live AND within N stops", () => {
  const cfg = { mapReveal: "PROGRESSIVE" as const, exactPinStopsAway: 1 };
  assert.equal(decideReveal({ ...cfg, stopsAway: 3, isLive: true }).showExactPin, false); // far → approx
  assert.equal(decideReveal({ ...cfg, stopsAway: 3, isLive: true }).showApproximateArea, true);
  assert.equal(decideReveal({ ...cfg, stopsAway: 1, isLive: true }).showExactPin, true); // near → exact
  assert.equal(decideReveal({ ...cfg, stopsAway: 0, isLive: false }).showExactPin, false); // stale → never exact
});

test("FULL shows exact when live; NONE hides the map", () => {
  assert.equal(decideReveal({ mapReveal: "FULL", exactPinStopsAway: 1, stopsAway: 9, isLive: true }).showExactPin, true);
  assert.equal(decideReveal({ mapReveal: "NONE", exactPinStopsAway: 1, stopsAway: 0, isLive: true }).showMap, false);
});

// ── ETA engine ──────────────────────────────────────────────────────────────
test("ETA sums legs + intermediate service and returns a range", () => {
  const eta = computeEta({
    legTravelSeconds: [300, 300, 300], // 5 min per leg
    serviceSecondsPerStop: 120,
    stopsAway: 2,
    ageSec: 10,
    isLive: true,
    roundToSec: 60,
  });
  // travel = 300*3 = 900; service = 120*2 = 240; center = 1140
  assert.equal(eta.centerSeconds, 1140);
  assert.ok(eta.etaSecondsMin < 1140 && eta.etaSecondsMax > 1140);
  assert.equal(eta.confidence, "medium"); // live, 2 stops away
});

test("ETA widens and drops confidence when stale", () => {
  const live = computeEta({ legTravelSeconds: [600], serviceSecondsPerStop: 120, stopsAway: 0, ageSec: 5, isLive: true });
  const stale = computeEta({ legTravelSeconds: [600], serviceSecondsPerStop: 120, stopsAway: 0, ageSec: 400, isLive: false });
  const liveWidth = live.etaSecondsMax - live.etaSecondsMin;
  const staleWidth = stale.etaSecondsMax - stale.etaSecondsMin;
  assert.ok(staleWidth > liveWidth, "stale range should be wider");
  assert.equal(live.confidence, "high");
  assert.equal(stale.confidence, "low");
});

test("ETA never returns a zero-width or inverted range", () => {
  const eta = computeEta({ legTravelSeconds: [60], serviceSecondsPerStop: 0, stopsAway: 0, ageSec: 0, isLive: true, roundToSec: 300 });
  assert.ok(eta.etaSecondsMax > eta.etaSecondsMin);
});
