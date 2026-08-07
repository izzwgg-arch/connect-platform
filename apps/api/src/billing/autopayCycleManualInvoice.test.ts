import test from "node:test";
import assert from "node:assert/strict";
import { autopayPeriodInvoiceWhere } from "./autopayCycle";
import { buildBillingSchedule } from "./billingSchedule";

/**
 * Custom (operator-created) invoices must never interfere with monthly billing.
 *
 * Autopay selects the most recently created non-VOID invoice overlapping the
 * billing period, and manual invoices land in that same window — so a custom
 * invoice could be auto-charged in place of the monthly bill, and could suppress
 * creation of the monthly invoice entirely.
 *
 * ⛔ The exclusion is a NULL trap. `source: { not: "MANUAL" }` on its own drops
 * every row where source IS NULL (SQL: NULL <> 'MANUAL' is NULL, not true), and
 * the auto path never sets that column — so the naive filter matches ZERO
 * invoices and blocks all autopay. Live check when this was caught: Gesheft had
 * 5 invoices, 4 with source NULL, and the naive filter matched 0 of them.
 */
const schedule = buildBillingSchedule({
  now: new Date("2026-05-21T12:00:00.000Z"),
  billingDayOfMonth: 21,
});

function sourceClause(where: any) {
  return where.AND?.find((c: any) => Array.isArray(c.OR) && c.OR.some((o: any) => "source" in o));
}

test("the manual-invoice exclusion is NULL-safe", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule) as any;
  const clause = sourceClause(where);
  assert.ok(clause, "there must be a source clause");
  assert.deepEqual(
    clause.OR,
    [{ source: null }, { source: { not: "MANUAL" } }],
    "must accept source IS NULL explicitly — a bare `not` filters out every auto invoice",
  );
});

test("a bare `source: { not: MANUAL }` is never used at the top level", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule) as any;
  assert.equal("source" in where, false, "a top-level source filter would drop all NULL-source invoices");
});

test("tenant, profile and void filters are unchanged", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule) as any;
  assert.equal(where.tenantId, "tenant_1");
  assert.equal(where.billingProfileId, null);
  assert.deepEqual(where.status, { not: "VOID" });
});

test("the period window is unchanged", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule) as any;
  const period = where.AND.find((c: any) => Array.isArray(c.OR) && c.OR.some((o: any) => "periodStart" in o));
  assert.ok(period, "period clause must exist");
  assert.deepEqual(period.OR[0], { periodStart: schedule.periodStart, periodEnd: schedule.periodEnd });
  assert.deepEqual(period.OR[1], {
    periodStart: { lte: schedule.scheduledChargeAt },
    periodEnd: { gte: schedule.scheduledChargeAt },
  });
});

/** Matcher mirroring the Prisma filter with SQL NULL semantics made explicit. */
function matches(where: any, invoice: any): boolean {
  if (invoice.tenantId !== where.tenantId) return false;
  if (invoice.billingProfileId !== where.billingProfileId) return false;
  if (invoice.status === where.status.not) return false;
  const src = sourceClause(where);
  const srcOk = src.OR.some((o: any) => {
    if (o.source === null) return invoice.source === null;
    // SQL: NULL <> 'MANUAL' is NULL (falsy), which is exactly the trap.
    return invoice.source !== null && invoice.source !== o.source.not;
  });
  if (!srcOk) return false;
  const exact =
    invoice.periodStart.getTime() === schedule.periodStart.getTime() &&
    invoice.periodEnd.getTime() === schedule.periodEnd.getTime();
  const spans =
    invoice.periodStart <= schedule.scheduledChargeAt && invoice.periodEnd >= schedule.scheduledChargeAt;
  return exact || spans;
}

const base = { tenantId: "tenant_1", billingProfileId: null, status: "OPEN" };

test("the monthly invoice (source NULL) is still selected", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule);
  assert.equal(
    matches(where, { ...base, source: null, periodStart: schedule.periodStart, periodEnd: schedule.periodEnd }),
    true,
    "auto invoices have source NULL and MUST still be charged",
  );
});

test("a one-day custom invoice inside the cycle is not selected", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule);
  assert.equal(
    matches(where, {
      ...base,
      source: "MANUAL",
      periodStart: new Date("2026-05-25T00:00:00.000Z"),
      periodEnd: new Date("2026-05-25T23:59:59.000Z"),
    }),
    false,
    "a custom invoice must not be auto-charged",
  );
});

test("a system-tagged invoice is still selected", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule);
  assert.equal(
    matches(where, { ...base, source: "SYSTEM", periodStart: schedule.periodStart, periodEnd: schedule.periodEnd }),
    true,
  );
});

test("a voided manual invoice stays excluded", () => {
  const where = autopayPeriodInvoiceWhere("tenant_1", schedule);
  assert.equal(
    matches(where, { ...base, status: "VOID", source: "MANUAL", periodStart: schedule.periodStart, periodEnd: schedule.periodEnd }),
    false,
  );
});
