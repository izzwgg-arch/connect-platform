import test from "node:test";
import assert from "node:assert/strict";
import { validateScheduledPlanChangeEffectiveAt } from "./billingScheduledPlan";
import { canAccessPlatformAdminBillingRoutes } from "./billingAuth";

// Freeze "now" to 2027-05-15 for all validation tests
const NOW = new Date("2027-05-15T12:00:00.000Z");
const FIRST_OF_CURRENT = new Date(Date.UTC(2027, 4, 1, 0, 0, 0, 0)); // 2027-05-01

test("validateScheduledPlanChangeEffectiveAt: rejects unparseable date", () => {
  const r = validateScheduledPlanChangeEffectiveAt("not-a-date", NOW);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.error === "effective_at_invalid_date");
});

test("validateScheduledPlanChangeEffectiveAt: rejects date that is not 1st of month UTC midnight", () => {
  // 2027-07-05 — day is 5, not 1
  const r = validateScheduledPlanChangeEffectiveAt("2027-07-05T00:00:00.000Z", NOW);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.error === "effective_at_must_be_first_of_month_utc_midnight");
});

test("validateScheduledPlanChangeEffectiveAt: rejects non-midnight time on 1st of month", () => {
  // 2027-07-01 at noon, not midnight
  const r = validateScheduledPlanChangeEffectiveAt("2027-07-01T12:00:00.000Z", NOW);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.error === "effective_at_must_be_first_of_month_utc_midnight");
});

test("validateScheduledPlanChangeEffectiveAt: rejects current month (first of current month)", () => {
  // 2027-05-01 — this IS the first of the current month, not future
  const r = validateScheduledPlanChangeEffectiveAt(FIRST_OF_CURRENT.toISOString(), NOW);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.error === "effective_at_must_be_future_month");
});

test("validateScheduledPlanChangeEffectiveAt: rejects past month", () => {
  // 2027-04-01 — past month
  const r = validateScheduledPlanChangeEffectiveAt("2027-04-01T00:00:00.000Z", NOW);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.error === "effective_at_must_be_future_month");
});

test("validateScheduledPlanChangeEffectiveAt: accepts first of next month", () => {
  // 2027-06-01 — one month ahead
  const r = validateScheduledPlanChangeEffectiveAt("2027-06-01T00:00:00.000Z", NOW);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.effectiveAt instanceof Date);
  assert.ok(r.ok && r.effectiveAt.getUTCFullYear() === 2027);
  assert.ok(r.ok && r.effectiveAt.getUTCMonth() === 5); // June = index 5
  assert.ok(r.ok && r.effectiveAt.getUTCDate() === 1);
});

test("validateScheduledPlanChangeEffectiveAt: accepts a far future month", () => {
  // 2028-01-01
  const r = validateScheduledPlanChangeEffectiveAt("2028-01-01T00:00:00.000Z", NOW);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.effectiveAt.getUTCFullYear() === 2028);
});

test("validateScheduledPlanChangeEffectiveAt: handles December → January year rollover correctly", () => {
  // "now" is December 2027, effective at January 2028 (first of next year)
  const decNow = new Date("2027-12-15T10:00:00.000Z");
  const r = validateScheduledPlanChangeEffectiveAt("2028-01-01T00:00:00.000Z", decNow);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.effectiveAt.getUTCFullYear() === 2028);
  assert.ok(r.ok && r.effectiveAt.getUTCMonth() === 0); // January = index 0
});

// ── Route auth (scheduled plan change routes are SUPER_ADMIN only) ───────────

test("scheduled plan change routes: SUPER_ADMIN can access platform billing", () => {
  assert.equal(canAccessPlatformAdminBillingRoutes("SUPER_ADMIN"), true);
});

test("scheduled plan change routes: non-SUPER_ADMIN roles are rejected", () => {
  assert.equal(canAccessPlatformAdminBillingRoutes("TENANT_ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("BILLING_ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("BILLING"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("USER"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes(undefined), false);
});
