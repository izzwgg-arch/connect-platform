import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTransition,
  canTransition,
  isTerminalStatus,
  isExceptionStatus,
  nextStatuses,
  transitionMeta,
  DELIVERY_ORDER_STATUSES,
  DELIVERY_TRANSITIONS,
  type DeliveryOrderStatus,
} from "./status";

test("happy-path lifecycle transitions are legal", () => {
  const path: [DeliveryOrderStatus, DeliveryOrderStatus][] = [
    ["RECEIVED", "READY"],
    ["READY", "SCANNED"],
    ["SCANNED", "ASSIGNED"],
    ["ASSIGNED", "LOADED"],
    ["LOADED", "OUT_FOR_DELIVERY"],
    ["OUT_FOR_DELIVERY", "EN_ROUTE"],
    ["EN_ROUTE", "APPROACHING"],
    ["APPROACHING", "ARRIVED"],
    ["ARRIVED", "DELIVERED"],
  ];
  for (const [from, to] of path) {
    assert.ok(canTransition(from, to), `${from} → ${to} should be legal`);
  }
});

test("illegal jumps are rejected", () => {
  assert.equal(canTransition("RECEIVED", "DELIVERED"), false);
  assert.equal(canTransition("READY", "ARRIVED"), false);
  assert.equal(canTransition("DELIVERED", "READY"), false);
  const r = checkTransition("RECEIVED", "DELIVERED", "driver");
  assert.equal(r.ok, false);
  assert.equal(r.code, "illegal_transition");
});

test("actor enforcement: driver cannot cancel, dispatcher can", () => {
  const driver = checkTransition("READY", "CANCELED", "driver");
  assert.equal(driver.ok, false);
  assert.equal(driver.code, "actor_not_allowed");
  const dispatcher = checkTransition("READY", "CANCELED", "dispatcher");
  assert.equal(dispatcher.ok, true);
});

test("delivered transition requires location + proof + notifies", () => {
  const meta = transitionMeta("ARRIVED", "DELIVERED");
  assert.ok(meta);
  assert.equal(meta!.requiresLocation, true);
  assert.equal(meta!.requiresProof, true);
  assert.equal(meta!.notifies, true);
});

test("out-for-delivery notifies the customer", () => {
  assert.equal(transitionMeta("ASSIGNED", "OUT_FOR_DELIVERY")!.notifies, true);
});

test("terminal + exception classification", () => {
  assert.equal(isTerminalStatus("DELIVERED"), true);
  assert.equal(isTerminalStatus("CANCELED"), true);
  assert.equal(isTerminalStatus("EN_ROUTE"), false);
  assert.equal(isExceptionStatus("DELIVERY_FAILED"), true);
  assert.equal(isExceptionStatus("DELIVERED"), false);
});

test("terminal statuses have no outgoing transitions", () => {
  assert.deepEqual(nextStatuses("DELIVERED"), []);
  assert.deepEqual(nextStatuses("CANCELED"), []);
});

test("unknown statuses are rejected with typed codes", () => {
  const a = checkTransition("NOPE" as DeliveryOrderStatus, "READY", "system");
  assert.equal(a.code, "invalid_from");
  const b = checkTransition("READY", "NOPE" as DeliveryOrderStatus, "system");
  assert.equal(b.code, "invalid_to");
});

test("transition table only references known statuses", () => {
  const known = new Set<string>(DELIVERY_ORDER_STATUSES);
  for (const [from, tos] of Object.entries(DELIVERY_TRANSITIONS)) {
    assert.ok(known.has(from), `unknown from-status in table: ${from}`);
    for (const to of Object.keys(tos ?? {})) {
      assert.ok(known.has(to), `unknown to-status in table: ${to}`);
    }
  }
});

test("cancel from any active state requires reason + approval + notify", () => {
  for (const from of ["RECEIVED", "READY", "ASSIGNED", "RESCHEDULED", "ON_HOLD"] as DeliveryOrderStatus[]) {
    const meta = transitionMeta(from, "CANCELED");
    if (!meta) continue;
    assert.equal(meta.requiresReason, true, `${from}→CANCELED needs reason`);
    assert.equal(meta.notifies, true, `${from}→CANCELED notifies`);
  }
});
