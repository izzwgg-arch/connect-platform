import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";

afterEach(() => {
  mock.restoreAll();
});

test("billingScheduledPlanConsume: scenarios (single block — ESM mock cache)", async () => {
  const eventLog: unknown[] = [];
  const eff = new Date("2027-06-01T00:00:00.000Z");
  const julyEff = new Date("2027-07-01T00:00:00.000Z");
  const june1 = new Date("2027-06-01T00:00:00.000Z");

  const planNext = {
    id: "plan-next",
    code: "PRO",
    name: "Pro Plan",
    active: true,
    extensionPriceCents: 5000,
    additionalPhoneNumberPriceCents: 2200,
    smsPriceCents: 1600,
    firstPhoneNumberFree: false,
  };

  const state: {
    settings: Record<string, unknown>;
    plan: typeof planNext | null | { active: boolean };
    updateManyResult: { count: number };
    updateThrows: Error | null;
  } = {
    settings: {
      billingPlanId: "plan-old",
      nextBillingPlanId: "plan-next",
      nextBillingPlanEffectiveAt: eff,
    },
    plan: planNext,
    updateManyResult: { count: 1 },
    updateThrows: null,
  };

  let updateCalls = 0;

  const db = {
    tenantBillingSettings: {
      findUnique: async () => ({ ...state.settings }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.updateThrows) throw state.updateThrows;
        updateCalls++;
        const cnt = state.updateManyResult.count;
        if (cnt > 0) {
          state.settings = { ...state.settings, ...data };
        }
        return { count: cnt };
      },
    },
    billingPlan: {
      findUnique: async () => state.plan,
    },
  };

  mock.module("@connect/db", { namedExports: { db } });
  mock.module("./invoiceEngine", {
    namedExports: {
      logBillingEvent: async (x: unknown) => {
        eventLog.push(x);
      },
    },
  });

  const { consumeScheduledPlanChange } = await import("./billingScheduledPlanConsume");

  // 1) applies when periodStart >= effectiveAt, copies prices, clears schedule, logs change_applied
  const r1 = await consumeScheduledPlanChange({
    tenantId: "t1",
    periodStart: june1,
    invoiceId: "inv-1",
    runId: "run-1",
  });
  assert.equal(r1.status, "applied");
  assert.equal(state.settings.billingPlanId, "plan-next");
  assert.equal(state.settings.extensionPriceCents, 5000);
  assert.equal(state.settings.nextBillingPlanId, null);
  assert.ok(
    eventLog.some(
      (e) => typeof e === "object" && e && (e as { type?: string }).type === "billing_plan.change_applied",
    ),
  );
  const appliedCount1 = updateCalls;

  // 2) idempotent second call
  const r2 = await consumeScheduledPlanChange({ tenantId: "t1", periodStart: june1 });
  assert.equal(r2.status, "no_schedule");
  assert.equal(updateCalls, appliedCount1);

  const uBefore3 = updateCalls;
  // 3) before effective date
  state.settings = {
    billingPlanId: "a",
    nextBillingPlanId: "b",
    nextBillingPlanEffectiveAt: julyEff,
  };
  state.plan = planNext;
  state.updateManyResult = { count: 1 };
  const r3 = await consumeScheduledPlanChange({ tenantId: "t2", periodStart: june1 });
  assert.equal(r3.status, "before_effective");
  assert.equal(updateCalls, uBefore3);
  assert.equal(state.settings.nextBillingPlanId, "b");

  // 4) inactive plan
  const uBefore4 = updateCalls;
  state.settings = {
    billingPlanId: "old",
    nextBillingPlanId: "inactive-plan",
    nextBillingPlanEffectiveAt: eff,
  };
  state.plan = { ...planNext, id: "inactive-plan", active: false };
  eventLog.length = 0;
  const r4 = await consumeScheduledPlanChange({ tenantId: "t3", periodStart: june1 });
  assert.equal(r4.status, "skipped");
  assert.ok(r4.status === "skipped" && r4.reason === "inactive_plan");
  assert.equal(updateCalls, uBefore4);
  assert.ok(
    eventLog.some(
      (e) =>
        typeof e === "object" &&
        e &&
        (e as { type?: string }).type === "billing_plan.change_skipped" &&
        (e as { metadata?: { reason?: string } }).metadata?.reason === "inactive_plan",
    ),
  );

  // 5) concurrent / already applied (updateMany count 0)
  state.updateThrows = null;
  state.settings = {
    billingPlanId: "old",
    nextBillingPlanId: "p1",
    nextBillingPlanEffectiveAt: eff,
  };
  state.plan = { ...planNext, id: "p1", code: "P", name: "P" };
  state.updateManyResult = { count: 0 };
  eventLog.length = 0;
  const r5 = await consumeScheduledPlanChange({ tenantId: "t4", periodStart: june1 });
  assert.equal(r5.status, "skipped");
  assert.ok(r5.status === "skipped" && r5.reason === "concurrent_or_already_applied");
  assert.equal(
    eventLog.filter(
      (e) => typeof e === "object" && e && (e as { type?: string }).type === "billing_plan.change_applied",
    ).length,
    0,
  );

  // 6) missing plan
  const uBefore6 = updateCalls;
  state.updateThrows = null;
  state.settings = {
    billingPlanId: "old",
    nextBillingPlanId: "missing",
    nextBillingPlanEffectiveAt: eff,
  };
  state.plan = null;
  eventLog.length = 0;
  const r6 = await consumeScheduledPlanChange({ tenantId: "t5", periodStart: june1 });
  assert.equal(r6.status, "skipped");
  assert.ok(r6.status === "skipped" && r6.reason === "plan_not_found");
  assert.equal(updateCalls, uBefore6);
  assert.ok(
    eventLog.some(
      (e) =>
        typeof e === "object" &&
        e &&
        (e as { type?: string }).type === "billing_plan.change_skipped" &&
        (e as { metadata?: { reason?: string } }).metadata?.reason === "plan_not_found",
    ),
  );

  // 7) DB throw — worker must catch
  state.updateManyResult = { count: 1 };
  state.settings = {
    billingPlanId: "old",
    nextBillingPlanId: "p1",
    nextBillingPlanEffectiveAt: eff,
  };
  state.plan = planNext;
  state.updateThrows = new Error("db_down");
  await assert.rejects(() => consumeScheduledPlanChange({ tenantId: "t6", periodStart: june1 }), /db_down/);
});
