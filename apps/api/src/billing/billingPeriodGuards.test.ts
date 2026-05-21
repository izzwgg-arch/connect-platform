import assert from "node:assert/strict";
import test, { mock } from "node:test";

test("paid monthly-service one-time invoice covers recurring billing but unrelated one-time does not", async () => {
  const paidRows: any[] = [];
  mock.module("@connect/db", {
    namedExports: {
      db: {
        billingInvoice: {
          findMany: async () => paidRows,
        },
      },
    },
  });

  const { findPaidBillingPeriodCoverage } = await import("./billingPeriodGuards");
  paidRows.push({
    id: "paid-one-time",
    invoiceNumber: "CC-202605-00018",
    status: "PAID",
    balanceDueCents: 0,
    periodStart: new Date("2026-05-21T14:22:45.153Z"),
    periodEnd: new Date("2026-05-21T14:22:45.153Z"),
    metadata: { source: "one_time_charge" },
    lineItems: [{ description: "Monthly service balance (May 5, 2026 - Jun 4, 2026)", metadata: null }],
  });

  const coverage = await findPaidBillingPeriodCoverage({
    tenantId: "tenant-1",
    periodStart: new Date("2026-05-05T04:00:00.000Z"),
    periodEnd: new Date("2026-06-05T03:59:59.999Z"),
  });

  assert.equal(coverage?.invoiceId, "paid-one-time");
  assert.equal(coverage?.reason, "paid_monthly_service_adjustment_period_overlap");

  paidRows.splice(0, paidRows.length, {
    id: "paid-custom",
    invoiceNumber: "CC-202605-00017",
    status: "PAID",
    balanceDueCents: 0,
    periodStart: new Date("2026-05-21T14:22:45.153Z"),
    periodEnd: new Date("2026-05-21T14:22:45.153Z"),
    metadata: { source: "one_time_charge" },
    lineItems: [{ description: "Router installation", metadata: null }],
  });
  const unrelatedCoverage = await findPaidBillingPeriodCoverage({
    tenantId: "tenant-1",
    periodStart: new Date("2026-05-05T04:00:00.000Z"),
    periodEnd: new Date("2026-06-05T03:59:59.999Z"),
  });

  assert.equal(unrelatedCoverage, null);
  mock.restoreAll();
});
