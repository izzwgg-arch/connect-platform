import { test } from "node:test";
import assert from "node:assert/strict";
import { decideScan, normalizeClientOpId, type ScanContext, type ScanOrderView } from "./scan";

const order: ScanOrderView = { id: "o1", tenantId: "t1", storeId: "s1", status: "READY" };

function ctx(over: Partial<ScanContext> = {}): ScanContext {
  return {
    driverTenantId: "t1",
    driverStoreIds: ["s1"],
    driverId: "d1",
    order,
    currentAssigneeDriverId: null,
    alreadyProcessed: false,
    ...over,
  };
}

test("clean scan assigns to the driver", () => {
  const d = decideScan(ctx());
  assert.equal(d.outcome, "assigned");
  assert.equal(d.canAssign, true);
  assert.equal(d.needsConfirmation, false);
});

test("cross-tenant scan is hard-blocked (never assigns)", () => {
  const d = decideScan(ctx({ order: { ...order, tenantId: "OTHER" } }));
  assert.equal(d.outcome, "wrong_tenant");
  assert.equal(d.canAssign, false);
});

test("wrong store is blocked", () => {
  const d = decideScan(ctx({ order: { ...order, storeId: "s2" } }));
  assert.equal(d.outcome, "wrong_store");
  assert.equal(d.canAssign, false);
});

test("invalid/unresolved token", () => {
  const d = decideScan(ctx({ order: null }));
  assert.equal(d.outcome, "invalid_token");
  assert.equal(d.canAssign, false);
});

test("already delivered/canceled cannot be re-scanned", () => {
  assert.equal(decideScan(ctx({ order: { ...order, status: "DELIVERED" } })).outcome, "already_delivered");
  assert.equal(decideScan(ctx({ order: { ...order, status: "CANCELED" } })).outcome, "already_delivered");
});

test("idempotent duplicate: same op already processed", () => {
  const d = decideScan(ctx({ alreadyProcessed: true }));
  assert.equal(d.outcome, "duplicate");
  assert.equal(d.canAssign, false);
});

test("re-scan of own assigned order is a safe no-op (not a new assignment)", () => {
  const d = decideScan(ctx({ order: { ...order, status: "ASSIGNED" }, currentAssigneeDriverId: "d1" }));
  assert.equal(d.outcome, "duplicate");
  assert.equal(d.canAssign, false);
});

test("order assigned to another driver needs explicit confirmation before reassign", () => {
  const d = decideScan(ctx({ order: { ...order, status: "ASSIGNED" }, currentAssigneeDriverId: "d2" }));
  assert.equal(d.outcome, "already_assigned");
  assert.equal(d.canAssign, false);
  assert.equal(d.needsConfirmation, true);
});

test("non-scannable status refuses cleanly", () => {
  const d = decideScan(ctx({ order: { ...order, status: "OUT_FOR_DELIVERY" } }));
  assert.equal(d.outcome, "not_scannable");
});

test("normalizeClientOpId rejects blank/oversized, trims valid", () => {
  assert.equal(normalizeClientOpId(""), null);
  assert.equal(normalizeClientOpId("   "), null);
  assert.equal(normalizeClientOpId(123 as unknown), null);
  assert.equal(normalizeClientOpId("x".repeat(200)), null);
  assert.equal(normalizeClientOpId("  op_123  "), "op_123");
});
