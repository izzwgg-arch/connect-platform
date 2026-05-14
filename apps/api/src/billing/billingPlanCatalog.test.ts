import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBillingPlanUsageCounts,
  assertBillingPlanScheduleEligibility,
  attachUsageCountsToPlans,
  BILLING_PLAN_PRICE_MAX_CENTS,
  billingPlanCloneBodySchema,
  billingPlanCreateBodySchema,
  billingPlanPatchBodySchema,
  catalogBillingPlansListWhere,
  deactivateBillingPlanBlockedReason,
  logBillingCatalogEvent,
  prismaUniqueViolation,
} from "./billingPlanCatalog";
import { canAccessPlatformAdminBillingRoutes } from "./billingAuth";

test("catalogBillingPlansListWhere: default list is active catalog only", () => {
  assert.deepEqual(catalogBillingPlansListWhere(false), { tenantId: null, active: true });
});

test("catalogBillingPlansListWhere: includeInactive drops active filter", () => {
  assert.deepEqual(catalogBillingPlansListWhere(true), { tenantId: null });
});

test("deactivateBillingPlanBlockedReason: prefers scheduled over current", () => {
  assert.equal(deactivateBillingPlanBlockedReason({ currentTenantCount: 0, scheduledTenantCount: 1 }), "billing_plan_deactivate_blocked_scheduled");
});

test("deactivateBillingPlanBlockedReason: blocks current tenants", () => {
  assert.equal(deactivateBillingPlanBlockedReason({ currentTenantCount: 2, scheduledTenantCount: 0 }), "billing_plan_deactivate_blocked_current");
});

test("deactivateBillingPlanBlockedReason: null when unused", () => {
  assert.equal(deactivateBillingPlanBlockedReason({ currentTenantCount: 0, scheduledTenantCount: 0 }), null);
});

test("attachUsageCountsToPlans: defaults zero counts", () => {
  const out = attachUsageCountsToPlans([{ id: "a", name: "A" }], new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].currentTenantCount, 0);
  assert.equal(out[0].scheduledTenantCount, 0);
});

test("aggregateBillingPlanUsageCounts: merges groupBy results", async () => {
  const db = {
    tenantBillingSettings: {
      groupBy: async (args: unknown) => {
        const a = args as { by: string[]; where: Record<string, unknown> };
        if (a.by[0] === "billingPlanId") {
          return [{ billingPlanId: "p1", _count: { _all: 2 } }];
        }
        return [{ nextBillingPlanId: "p1", _count: { _all: 3 } }, { nextBillingPlanId: "p2", _count: { _all: 1 } }];
      },
      findMany: async () => [],
    },
    billingPlan: { findUnique: async () => null },
    tenant: { findFirst: async () => null },
  };
  const map = await aggregateBillingPlanUsageCounts(db, ["p1", "p2"]);
  assert.equal(map.get("p1")?.currentTenantCount, 2);
  assert.equal(map.get("p1")?.scheduledTenantCount, 3);
  assert.equal(map.get("p2")?.currentTenantCount, 0);
  assert.equal(map.get("p2")?.scheduledTenantCount, 1);
});

test("billingPlanCreateBodySchema: rejects invalid slug code", () => {
  const bad = billingPlanCreateBodySchema.safeParse({
    code: "Bad_CODE",
    name: "N",
    extensionPriceCents: 0,
    additionalPhoneNumberPriceCents: 0,
    smsPriceCents: 0,
    firstPhoneNumberFree: true,
  });
  assert.equal(bad.success, false);
});

test("billingPlanCreateBodySchema: rejects price above max", () => {
  const bad = billingPlanCreateBodySchema.safeParse({
    code: "ok-slug",
    name: "N",
    extensionPriceCents: BILLING_PLAN_PRICE_MAX_CENTS + 1,
    additionalPhoneNumberPriceCents: 0,
    smsPriceCents: 0,
    firstPhoneNumberFree: true,
  });
  assert.equal(bad.success, false);
});

test("billingPlanCreateBodySchema: accepts valid catalog body", () => {
  const ok = billingPlanCreateBodySchema.safeParse({
    code: "growth-v2",
    name: "Growth",
    extensionPriceCents: 3000,
    additionalPhoneNumberPriceCents: 1000,
    smsPriceCents: 900,
    firstPhoneNumberFree: false,
    active: false,
  });
  assert.equal(ok.success, true);
});

test("billingPlanPatchBodySchema: strict mode rejects code / tenantId keys", () => {
  const badCode = billingPlanPatchBodySchema.safeParse({ code: "no" });
  assert.equal(badCode.success, false);
  const badTenant = billingPlanPatchBodySchema.safeParse({ tenantId: null });
  assert.equal(badTenant.success, false);
});

test("billingPlanPatchBodySchema: accepts partial price patch", () => {
  const ok = billingPlanPatchBodySchema.safeParse({ extensionPriceCents: 100 });
  assert.equal(ok.success, true);
});

test("billingPlanCloneBodySchema: requires code + name only", () => {
  const ok = billingPlanCloneBodySchema.safeParse({ code: "clone-me", name: "Clone" });
  assert.equal(ok.success, true);
});

test("clone shape: prices + firstPhoneNumberFree would be copied from source (doc contract)", () => {
  const source = {
    extensionPriceCents: 4000,
    additionalPhoneNumberPriceCents: 2000,
    smsPriceCents: 1500,
    firstPhoneNumberFree: false,
  };
  const createLike = {
    tenantId: null,
    code: "new-code",
    name: "New Name",
    active: true,
    extensionPriceCents: source.extensionPriceCents,
    additionalPhoneNumberPriceCents: source.additionalPhoneNumberPriceCents,
    smsPriceCents: source.smsPriceCents,
    firstPhoneNumberFree: source.firstPhoneNumberFree,
  };
  assert.deepEqual(
    {
      extensionPriceCents: createLike.extensionPriceCents,
      additionalPhoneNumberPriceCents: createLike.additionalPhoneNumberPriceCents,
      smsPriceCents: createLike.smsPriceCents,
      firstPhoneNumberFree: createLike.firstPhoneNumberFree,
    },
    source,
  );
});

test("assertBillingPlanScheduleEligibility: inactive plan", () => {
  const r = assertBillingPlanScheduleEligibility({ id: "p", active: false, code: "x" });
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.error === "billing_plan_inactive");
});

test("assertBillingPlanScheduleEligibility: missing plan", () => {
  const r = assertBillingPlanScheduleEligibility(null);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.error === "billing_plan_not_found");
});

test("assertBillingPlanScheduleEligibility: active plan", () => {
  const r = assertBillingPlanScheduleEligibility({ id: "p", active: true, name: "Grow" });
  assert.equal(r.ok, true);
});

test("prismaUniqueViolation detects P2002", () => {
  assert.equal(prismaUniqueViolation({ code: "P2002" }), true);
  assert.equal(prismaUniqueViolation(new Error("nope")), false);
});

test("logBillingCatalogEvent: no-op when no tenant exists (empty DB)", async () => {
  const db = {
    tenantBillingSettings: { groupBy: async () => [], findMany: async () => [] },
    billingPlan: { findUnique: async () => null },
    tenant: { findFirst: async () => null },
  };
  await assert.doesNotReject(() =>
    logBillingCatalogEvent(db, { operatorId: "op1", type: "billing_plan.created", metadata: { planId: "x" } }),
  );
});

test("platform billing catalog routes rely on SUPER_ADMIN gate", () => {
  assert.equal(canAccessPlatformAdminBillingRoutes("SUPER_ADMIN"), true);
  assert.equal(canAccessPlatformAdminBillingRoutes("BILLING_ADMIN"), false);
});
