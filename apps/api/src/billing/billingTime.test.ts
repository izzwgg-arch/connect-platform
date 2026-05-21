import assert from "node:assert/strict";
import test from "node:test";
import {
  addBillingDays,
  billingMonthBounds,
  billingMonthBoundsForYearMonth,
  billingYearMonth,
  CONNECT_BILLING_TIME_ZONE,
  formatBillingDateIso,
} from "./billingTime";

test("billingTime uses America/New_York explicitly", () => {
  assert.equal(CONNECT_BILLING_TIME_ZONE, "America/New_York");
});

test("billingMonthBounds returns New York local month boundaries as UTC instants", () => {
  const march = billingMonthBoundsForYearMonth(2027, 3);
  assert.equal(march.periodStart.toISOString(), "2027-03-01T05:00:00.000Z");
  assert.equal(march.periodEnd.toISOString(), "2027-04-01T03:59:59.999Z");
});

test("billingMonthBounds chooses month by New York date, not UTC date", () => {
  const bounds = billingMonthBounds(new Date("2027-03-01T02:00:00.000Z"));
  assert.equal(bounds.periodStart.toISOString(), "2027-02-01T05:00:00.000Z");
  assert.equal(billingYearMonth(new Date("2027-03-01T02:00:00.000Z")).month, 2);
});

test("addBillingDays preserves New York wall time across DST changes", () => {
  const beforeDst = new Date("2027-03-13T15:30:00.000Z"); // 10:30 AM EST
  const afterDst = addBillingDays(beforeDst, 2);
  assert.equal(afterDst.toISOString(), "2027-03-15T14:30:00.000Z"); // 10:30 AM EDT
  assert.equal(formatBillingDateIso(afterDst), "2027-03-15");
});
