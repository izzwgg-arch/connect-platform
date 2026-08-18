import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EMERGENCY_OUTBOUND_ROUTE_NAME,
  EmergencyRouteMissingError,
  buildInterruptionPlan,
  buildRestorePlan,
  emergencyDialPatterns,
  emergencyRouteSpec,
  findEmergencyRoute,
  inboundTreatmentFor,
} from "./serviceInterruptionPlan";
import { isOutboundCallAllowed } from "./serviceInterruptionPolicy";

const EMERGENCY = { id: 999, name: EMERGENCY_OUTBOUND_ROUTE_NAME, active: true };

const routes = () => [
  { id: 126, name: "Main outbound", active: true },
  { id: 127, name: "International", active: true },
  { id: 128, name: "Disabled by customer", active: false },
  { ...EMERGENCY },
];

const inbound = () => [
  { id: 240, did: "6469846023", pointsAtConnectDoorway: true },
  { id: 241, did: "8457231213", pointsAtConnectDoorway: false },
];

// ─── The route every customer gets ───────────────────────────────────────────

test("the emergency route matches 911 and the EMS/fire line, and nothing else", () => {
  const spec = emergencyRouteSpec();
  assert.equal(spec.name, EMERGENCY_OUTBOUND_ROUTE_NAME);
  assert.deepEqual(spec.patterns, ["911", "8457831212", "18457831212"]);
  assert.equal(spec.neverDeactivate, true);
});

test("the plan's dial patterns and the runtime gate agree with each other", () => {
  // Two independent paths decide "is this allowed" — the dialplan patterns on
  // the PBX and the gate in code. They must never disagree.
  for (const p of emergencyDialPatterns()) {
    assert.equal(isOutboundCallAllowed({ interrupted: true, dialed: p }), true, p);
  }
  for (const blocked of ["5551234567", "8459111234", "911911", "84578312125"]) {
    assert.equal(emergencyDialPatterns().includes(blocked), false, blocked);
    assert.equal(isOutboundCallAllowed({ interrupted: true, dialed: blocked }), false, blocked);
  }
});

// ─── Outbound ────────────────────────────────────────────────────────────────

test("every active outbound route is deactivated", () => {
  const plan = buildInterruptionPlan({ outboundRoutes: routes(), inboundRoutes: inbound() });
  assert.deepEqual(plan.deactivateOutbound.map((r) => r.id), [126, 127]);
});

test("multiple outbound routes are ALL deactivated, not just the first", () => {
  const many = [1, 2, 3, 4, 5].map((id) => ({ id, name: `Route ${id}`, active: true }));
  const plan = buildInterruptionPlan({ outboundRoutes: [...many, { ...EMERGENCY }], inboundRoutes: [] });
  assert.equal(plan.deactivateOutbound.length, 5);
});

test("a route the customer already switched off is left alone", () => {
  const plan = buildInterruptionPlan({ outboundRoutes: routes(), inboundRoutes: [] });
  assert.equal(plan.deactivateOutbound.some((r) => r.id === 128), false);
});

// ─── The safety property ─────────────────────────────────────────────────────

test("the emergency route is never in the deactivate list", () => {
  const plan = buildInterruptionPlan({ outboundRoutes: routes(), inboundRoutes: [] });
  assert.equal(plan.deactivateOutbound.some((r) => r.name === EMERGENCY_OUTBOUND_ROUTE_NAME), false);
  assert.equal(plan.deactivateOutbound.some((r) => r.id === 999), false);
  assert.equal(plan.emergencyRouteKept.id, 999);
});

test("a tenant with NO emergency route is not interrupted at all", () => {
  const withoutEmergency = routes().filter((r) => r.name !== EMERGENCY_OUTBOUND_ROUTE_NAME);
  assert.throws(
    () => buildInterruptionPlan({ outboundRoutes: withoutEmergency, inboundRoutes: [] }),
    (err: EmergencyRouteMissingError) => err.name === "EmergencyRouteMissingError" && err.reason === "absent",
  );
});

test("a tenant whose emergency route is switched off is not interrupted either", () => {
  const inactive = [...routes().filter((r) => r.id !== 999), { ...EMERGENCY, active: false }];
  assert.throws(
    () => buildInterruptionPlan({ outboundRoutes: inactive, inboundRoutes: [] }),
    (err: EmergencyRouteMissingError) => err.reason === "inactive",
  );
});

test("the refusal names the numbers that would have been lost", () => {
  try {
    buildInterruptionPlan({ outboundRoutes: [], inboundRoutes: [] });
    assert.fail("should have refused");
  } catch (err) {
    assert.match((err as Error).message, /911/);
    assert.match((err as Error).message, /8457831212/);
  }
});

test("findEmergencyRoute locates it among the tenant's routes", () => {
  assert.equal(findEmergencyRoute(routes())?.id, 999);
  assert.equal(findEmergencyRoute([]), undefined);
});

// ─── Inbound ─────────────────────────────────────────────────────────────────

test("a caller gets a busy signal, never the IVR and never dead air", () => {
  assert.equal(inboundTreatmentFor({ interrupted: true }), "busy");
  assert.equal(inboundTreatmentFor({ interrupted: false }), "normal");
});

test("a number already on the Connect doorway needs no PBX change", () => {
  const plan = buildInterruptionPlan({ outboundRoutes: routes(), inboundRoutes: inbound() });
  assert.deepEqual(plan.inboundHandledInConnect.map((r) => r.id), [240]);
  assert.deepEqual(plan.repointInboundToDoorway.map((r) => r.id), [241]);
});

// ─── Restore ─────────────────────────────────────────────────────────────────

test("paying reactivates exactly what we switched off", () => {
  const plan = buildInterruptionPlan({ outboundRoutes: routes(), inboundRoutes: inbound() });
  const restore = buildRestorePlan({
    deactivatedOutbound: plan.deactivateOutbound,
    repointedInbound: plan.repointInboundToDoorway,
  });
  assert.deepEqual(restore.reactivateOutbound.map((r) => r.id), [126, 127]);
  assert.deepEqual(restore.restoreInbound.map((r) => r.id), [241]);
});

test("restoring does not switch on a route the customer had disabled", () => {
  const plan = buildInterruptionPlan({ outboundRoutes: routes(), inboundRoutes: [] });
  const restore = buildRestorePlan({ deactivatedOutbound: plan.deactivateOutbound, repointedInbound: [] });
  assert.equal(restore.reactivateOutbound.some((r) => r.id === 128), false);
});

test("restoring never touches the permanent emergency route", () => {
  const restore = buildRestorePlan({
    deactivatedOutbound: [{ ...EMERGENCY, active: false }],
    repointedInbound: [],
  });
  assert.equal(restore.reactivateOutbound.length, 0);
  assert.equal("removeEmergencyRoute" in restore, false);
});

test("interrupt then restore returns the tenant to exactly the starting state", () => {
  const before = routes();
  const plan = buildInterruptionPlan({ outboundRoutes: before, inboundRoutes: inbound() });
  const restore = buildRestorePlan({
    deactivatedOutbound: plan.deactivateOutbound,
    repointedInbound: plan.repointInboundToDoorway,
  });
  const activeAfter = new Set([
    ...before.filter((r) => r.active && !plan.deactivateOutbound.includes(r)).map((r) => r.id),
    ...restore.reactivateOutbound.map((r) => r.id),
  ]);
  assert.deepEqual([...activeAfter].sort((a, b) => a - b), [126, 127, 999]);
});
