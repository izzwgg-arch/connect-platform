import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  NothingToInterruptError,
  applyEnabledState,
  buildInterruptionPlan,
  buildRestorePlan,
  inboundTreatmentFor,
  membersForProfile,
  type ArsMemberRef,
} from "./serviceInterruptionPlan";

/** Trust Bookkeepings' shape: several profiles, one route each. */
const multiProfile = (): ArsMemberRef[] => [
  { arsId: "50", outboundRouteId: "101", enabled: true, sort: 0 },
  { arsId: "49", outboundRouteId: "102", enabled: true, sort: 0 },
  { arsId: "48", outboundRouteId: "103", enabled: true, sort: 0 },
  { arsId: "47", outboundRouteId: "104", enabled: false, sort: 0 }, // customer's own choice
];

const inbound = () => [
  { id: 240, did: "6469846023", pointsAtConnectDoorway: true },
  { id: 241, did: "8457231213", pointsAtConnectDoorway: false },
];

// ─── Every profile, not just the first ───────────────────────────────────────

test("every enabled member across every profile is disabled", () => {
  const plan = buildInterruptionPlan({ members: multiProfile(), inboundRoutes: [] });
  assert.deepEqual(plan.disable.map((m) => m.outboundRouteId), ["101", "102", "103"]);
  assert.deepEqual(plan.arsIds.sort(), ["48", "49", "50"]);
});

test("a customer with nine profiles has all nine switched off", () => {
  const nine: ArsMemberRef[] = Array.from({ length: 9 }, (_, i) => ({
    arsId: String(40 + i),
    outboundRouteId: String(200 + i),
    enabled: true,
    sort: 0,
  }));
  const plan = buildInterruptionPlan({ members: nine, inboundRoutes: [] });
  assert.equal(plan.disable.length, 9);
  assert.equal(plan.arsIds.length, 9);
});

test("a member the customer already disabled is left alone and not restored later", () => {
  const plan = buildInterruptionPlan({ members: multiProfile(), inboundRoutes: [] });
  assert.deepEqual(plan.alreadyDisabled.map((m) => m.outboundRouteId), ["104"]);
  const restore = buildRestorePlan({
    disabledMembers: plan.disable.map((m) => ({ arsId: m.arsId, outboundRouteId: m.outboundRouteId })),
    repointedInbound: [],
  });
  assert.equal(restore.enable.some((m) => m.outboundRouteId === "104"), false);
});

test("a tenant with nothing enabled is refused, not recorded as interrupted", () => {
  const allOff = multiProfile().map((m) => ({ ...m, enabled: false }));
  assert.throws(() => buildInterruptionPlan({ members: allOff, inboundRoutes: [] }), NothingToInterruptError);
  assert.throws(() => buildInterruptionPlan({ members: [], inboundRoutes: [] }), NothingToInterruptError);
});

// ─── Round trip ──────────────────────────────────────────────────────────────

test("interrupt then restore returns exactly the starting state", () => {
  const before = multiProfile();
  const plan = buildInterruptionPlan({ members: before, inboundRoutes: inbound() });
  const restore = buildRestorePlan({
    disabledMembers: plan.disable.map((m) => ({ arsId: m.arsId, outboundRouteId: m.outboundRouteId })),
    repointedInbound: plan.repointInboundToDoorway,
  });

  let state = before;
  for (const arsId of plan.arsIds) {
    state = applyEnabledState(state, {
      arsId,
      outboundRouteIds: new Set(plan.disable.filter((m) => m.arsId === arsId).map((m) => m.outboundRouteId)),
      enabled: false,
    });
  }
  assert.equal(state.every((m) => !m.enabled), true, "everything is off while interrupted");

  for (const arsId of restore.arsIds) {
    state = applyEnabledState(state, {
      arsId,
      outboundRouteIds: new Set(restore.enable.filter((m) => m.arsId === arsId).map((m) => m.outboundRouteId)),
      enabled: true,
    });
  }
  assert.deepEqual(
    state.map((m) => ({ id: m.outboundRouteId, on: m.enabled })),
    before.map((m) => ({ id: m.outboundRouteId, on: m.enabled })),
    "restore puts back exactly the starting state, including the customer's own disabled route",
  );
});

test("applying a change preserves sort order and untouched members", () => {
  const members: ArsMemberRef[] = [
    { arsId: "7", outboundRouteId: "11", enabled: true, sort: 1 },
    { arsId: "7", outboundRouteId: "10", enabled: true, sort: 0 },
    { arsId: "8", outboundRouteId: "99", enabled: true, sort: 0 },
  ];
  const out = applyEnabledState(members, { arsId: "7", outboundRouteIds: new Set(["10"]), enabled: false });
  assert.deepEqual(out.map((m) => m.outboundRouteId), ["11", "10", "99"], "input order preserved — flags only");
  // Ordering is per profile, and only when posting that profile back.
  assert.deepEqual(membersForProfile(out, "7").map((m) => m.outboundRouteId), ["10", "11"]);
  assert.deepEqual(membersForProfile(out, "8").map((m) => m.outboundRouteId), ["99"]);
  assert.equal(out.find((m) => m.outboundRouteId === "10")!.enabled, false);
  assert.equal(out.find((m) => m.outboundRouteId === "11")!.enabled, true);
  assert.equal(out.find((m) => m.outboundRouteId === "99")!.enabled, true, "another profile is untouched");
});

// ─── Inbound ─────────────────────────────────────────────────────────────────

test("a caller gets a busy signal, never the IVR and never dead air", () => {
  assert.equal(inboundTreatmentFor({ interrupted: true }), "busy");
  assert.equal(inboundTreatmentFor({ interrupted: false }), "normal");
});

test("a number already on the Connect doorway needs no PBX change", () => {
  const plan = buildInterruptionPlan({ members: multiProfile(), inboundRoutes: inbound() });
  assert.deepEqual(plan.inboundHandledInConnect.map((r) => r.id), [240]);
  assert.deepEqual(plan.repointInboundToDoorway.map((r) => r.id), [241]);
});

// ─── The 911 guarantee is structural ─────────────────────────────────────────

test("no part of the plan touches emergency dialling", () => {
  const plan = buildInterruptionPlan({ members: multiProfile(), inboundRoutes: inbound() });
  const serialised = JSON.stringify(plan);
  // Emergency calls never traverse an ARS member, so nothing here can name them.
  assert.equal(serialised.includes("911"), false);
  assert.equal(serialised.includes("8457831212"), false);
  assert.equal(serialised.includes("emergency"), false);
});
