import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCustomerView, type CustomerViewInput } from "./customerView";
import { checkTokenValidity, resolveTier, visibleFields } from "./trackingTokenPolicy";
import { computeEta } from "./eta";

function base(over: Partial<CustomerViewInput> = {}): CustomerViewInput {
  return {
    status: "EN_ROUTE",
    orderRef: "#8842",
    mapReveal: "PROGRESSIVE",
    exactPinStopsAway: 1,
    stopsAway: 3,
    isLive: true,
    movement: "moving",
    eta: computeEta({ legTravelSeconds: [600], serviceSecondsPerStop: 120, stopsAway: 0, ageSec: 5, isLive: true }),
    nowMs: 1_700_000_000_000,
    position: { lat: 40.1, lng: -74.2, heading: 90 },
    lastUpdateSec: 20,
    verifiedTier: 1,
    deliveryAddress: "142 Elm St, Unit 4B",
    proofSummary: { method: "signature", capturedAt: "2026-07-23T15:19:00Z" },
    ...over,
  };
}

test("progressive: far driver shows approximate area, NOT exact pin", () => {
  const v = buildCustomerView(base({ stopsAway: 3, isLive: true }));
  assert.equal(v.map.exactPin, false);
  assert.equal(v.map.approximateArea, true);
  assert.equal(v.map.position, null);
  assert.equal(v.stopsAway, 3);
});

test("progressive: near driver shows exact pin + position", () => {
  const v = buildCustomerView(base({ stopsAway: 1, isLive: true }));
  assert.equal(v.map.exactPin, true);
  assert.deepEqual(v.map.position, { lat: 40.1, lng: -74.2, heading: 90 });
});

test("stale fix: never exact pin, movement label reflects it", () => {
  const v = buildCustomerView(base({ stopsAway: 1, isLive: false, movement: "stale" }));
  assert.equal(v.map.exactPin, false);
  assert.equal(v.map.position, null);
  assert.match(v.movementLabel, /not updated recently/i);
});

test("tier 1 hides sensitive detail; tier 2 reveals it", () => {
  const t1 = buildCustomerView(base({ verifiedTier: 1 }));
  assert.equal(t1.detail, null);
  const t2 = buildCustomerView(base({ verifiedTier: 2 }));
  assert.equal(t2.detail?.address, "142 Elm St, Unit 4B");
  assert.equal(t2.detail?.proof?.method, "signature");
});

test("public status vocabulary never leaks internal statuses", () => {
  assert.equal(buildCustomerView(base({ status: "OUT_FOR_DELIVERY" })).statusCode, "on_the_way");
  assert.equal(buildCustomerView(base({ status: "CUSTOMER_UNAVAILABLE" })).statusCode, "attempted");
  assert.equal(buildCustomerView(base({ status: "EXCEPTION" })).statusCode, "processing");
  assert.equal(buildCustomerView(base({ status: "DELIVERED" })).statusCode, "delivered");
});

test("no ETA/map on terminal or preparing states", () => {
  const delivered = buildCustomerView(base({ status: "DELIVERED" }));
  assert.equal(delivered.eta, null);
  assert.equal(delivered.map.show, false);
  const prep = buildCustomerView(base({ status: "READY" }));
  assert.equal(prep.map.show, false);
});

test("ETA renders as a range only while active", () => {
  const v = buildCustomerView(base({ status: "EN_ROUTE" }));
  assert.match(v.eta || "", /–/); // en dash range
});

// ── token policy ──────────────────────────────────────────────────────────────
test("token validity: expiry, revocation, terminal grace", () => {
  const now = 1000;
  assert.equal(checkTokenValidity({ expiresAt: 2000, revokedAt: null, orderTerminal: false }, now).valid, true);
  assert.equal(checkTokenValidity({ expiresAt: 500, revokedAt: null, orderTerminal: false }, now).reason, "expired");
  assert.equal(checkTokenValidity({ expiresAt: null, revokedAt: 900, orderTerminal: false }, now).reason, "revoked");
  const grace = checkTokenValidity({ expiresAt: null, revokedAt: null, orderTerminal: true, graceMsAfterTerminal: 100 }, now, 800);
  assert.equal(grace.reason, "terminal_grace_passed");
  const inGrace = checkTokenValidity({ expiresAt: null, revokedAt: null, orderTerminal: true, graceMsAfterTerminal: 500 }, now, 800);
  assert.equal(inGrace.valid, true);
});

test("tier resolution + visible fields", () => {
  assert.equal(resolveTier({ tokenValid: false, otpVerified: false }), 0);
  assert.equal(resolveTier({ tokenValid: true, otpVerified: false }), 1);
  assert.equal(resolveTier({ tokenValid: true, otpVerified: true }), 2);
  assert.equal(visibleFields(0).status, false);
  assert.equal(visibleFields(1).map, true);
  assert.equal(visibleFields(1).proof, false);
  assert.equal(visibleFields(2).fullAddress, true);
});
