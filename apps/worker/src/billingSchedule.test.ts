import test from "node:test";
import assert from "node:assert/strict";
import { buildBillingSchedule, resolveBillingTimeZone } from "./billingSchedule";

test("worker restart before payment date local midnight is not due", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-21T03:59:59.000Z"), // May 20 23:59:59 America/New_York
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.timeZone, "America/New_York");
  assert.equal(schedule.paymentDate, "2026-05-21");
  assert.equal(schedule.scheduledChargeAt.toISOString(), "2026-05-21T04:00:00.000Z");
  assert.equal(schedule.due, false);
});

test("worker restart after payment date midnight is due", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-21T04:00:00.000Z"), // May 21 00:00:00 America/New_York
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.scheduledChargeAt.toISOString(), "2026-05-21T04:00:00.000Z");
  assert.equal(schedule.due, true);
});

test("billing period is payment-date to payment-date, not calendar month", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-21T12:00:00.000Z"),
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.periodStart.toISOString(), "2026-05-21T04:00:00.000Z");
  assert.equal(schedule.periodEnd.toISOString(), "2026-06-21T03:59:59.999Z");
  assert.notEqual(schedule.periodStart.toISOString(), "2026-05-01T00:00:00.000Z");
});

test("tenant with payment day 21 has local service period 21 through 20", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-22T12:00:00.000Z"),
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.paymentDate, "2026-05-21");
  assert.equal(schedule.nextPaymentDate, "2026-06-21");
  assert.equal(schedule.periodEnd.toLocaleDateString("en-CA", { timeZone: schedule.timeZone }), "2026-06-20");
});

test("timezone boundary around America/New_York midnight controls eligibility", () => {
  const before = buildBillingSchedule({
    now: new Date("2026-11-21T04:59:59.000Z"), // Nov 20 23:59:59 EST
    billingDayOfMonth: 21,
  });
  const atMidnight = buildBillingSchedule({
    now: new Date("2026-11-21T05:00:00.000Z"), // Nov 21 00:00:00 EST
    billingDayOfMonth: 21,
  });

  assert.equal(before.scheduledChargeAt.toISOString(), "2026-11-21T05:00:00.000Z");
  assert.equal(before.due, false);
  assert.equal(atMidnight.due, true);
});

test("startup catch-up charges overdue current-cycle schedules only", () => {
  const beforePaymentDate = buildBillingSchedule({
    now: new Date("2026-05-20T16:00:00.000Z"),
    billingDayOfMonth: 21,
  });
  const overdue = buildBillingSchedule({
    now: new Date("2026-05-22T16:00:00.000Z"),
    billingDayOfMonth: 21,
  });

  assert.equal(beforePaymentDate.due, false);
  assert.equal(overdue.due, true);
  assert.equal(overdue.paymentDate, "2026-05-21");
});

test("tenant-specific billing timezone metadata is honored when valid", () => {
  assert.equal(resolveBillingTimeZone({ billingTimeZone: "America/Los_Angeles" }), "America/Los_Angeles");
  assert.equal(resolveBillingTimeZone({ billingTimeZone: "Not/AZone" }), "America/New_York");
});

