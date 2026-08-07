import test from "node:test";
import assert from "node:assert/strict";
import { autopayPeriodInvoiceWhere } from "./autopayCycle";
import { buildBillingSchedule } from "./billingSchedule";

/**
 * Custom (operator-created) invoices must never interfere with monthly billing.
 *
 * Autopay selects the most recently created non-VOID invoice overlapping the
 * billing period. Manual invoices land in that same window, so before this guard
 * a custom invoice could be auto-charged in place of the monthly bill, and could
 * also suppress creation of the monthly invoice — the T-3 phase saw one already
 * existed for the period and skipped.
 *
 * Live data when this was found: 4 manual invoices, one of them a single-day
 * $681.20 bill whose period overlapped that tenant's monthly cycle.
 */
const schedule = buildBillingSchedule({
  now: new Date("2026-05-21T12:00:00.000Z"),
  billingDayOfMonth: 21,
});

test("autopay never selects an operator-created invoice", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule) as any;
  assert.deepEqual(where.source, { not: "MANUAL" });
});

test("autopay still ignores voided invoices and billing-profile invoices", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule) as any;
  assert.deepEqual(where.status, { not: "VOID" });
  assert.equal(where.billingProfileId, null);
  assert.equal(where.tenantId, "tenant_1");
});

test("the period window itself is unchanged", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule) as any;
  assert.equal(Array.isArray(where.OR), true);
  assert.equal(where.OR.length, 2);
  assert.deepEqual(where.OR[0], { periodStart: schedule.periodStart, periodEnd: schedule.periodEnd });
});

/** A hand-rolled matcher mirroring the Prisma filter, to show the effect on rows. */
function matches(where: any, invoice: any): boolean {
  if (invoice.tenantId !== where.tenantId) return false;
  if (invoice.billingProfileId !== where.billingProfileId) return false;
  if (invoice.status === where.status.not) return false;
  if (where.source && invoice.source === where.source.not) return false;
  const exact = invoice.periodStart.getTime() === schedule.periodStart.getTime()
    && invoice.periodEnd.getTime() === schedule.periodEnd.getTime();
  const spans = invoice.periodStart <= schedule.scheduledChargeAt && invoice.periodEnd >= schedule.scheduledChargeAt;
  return exact || spans;
}

test("a one-day custom invoice inside the cycle is not picked up", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule);
  const oneDayCustom = {
    tenantId: "tenant_1",
    billingProfileId: null,
    status: "OPEN",
    source: "MANUAL",
    periodStart: new Date("2026-05-25T00:00:00.000Z"),
    periodEnd: new Date("2026-05-25T23:59:59.000Z"),
  };
  assert.equal(matches(where, oneDayCustom), false, "a custom invoice must not be auto-charged");
});

test("the monthly invoice is still picked up", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule);
  const monthly = {
    tenantId: "tenant_1",
    billingProfileId: null,
    status: "OPEN",
    source: null, // the auto path does not set the source column
    periodStart: schedule.periodStart,
    periodEnd: schedule.periodEnd,
  };
  assert.equal(matches(where, monthly), true, "the monthly invoice must still be charged");
});
