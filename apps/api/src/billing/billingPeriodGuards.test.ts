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

test("an additive one-time/manual invoice being charged skips the paid-period guard; a monthly-service one does not", async () => {
  mock.module("@connect/db", {
    namedExports: { db: { billingInvoice: { findMany: async () => [] } } },
  });
  const { isAdditiveOneTimeInvoice } = await import("./billingPeriodGuards");

  // Manual invoice (Starlink install) — additive, guard skipped.
  assert.equal(await isAdditiveOneTimeInvoice({
    id: "inv-manual",
    source: "MANUAL",
    metadata: { source: "manual_invoice" },
    lineItems: [{ description: "Service call — Starlink installation" }, { description: "Starlink data" }],
  }), true);

  // One-time charge drawer invoice — additive.
  assert.equal(await isAdditiveOneTimeInvoice({
    id: "inv-otc",
    metadata: { source: "one_time_charge" },
    lineItems: [{ description: "Router installation" }],
  }), true);

  // One-time invoice that REPLACES a monthly cycle charge — stays guarded.
  assert.equal(await isAdditiveOneTimeInvoice({
    id: "inv-monthly",
    metadata: { source: "one_time_charge" },
    lineItems: [{ description: "Monthly service balance (May 5, 2026 - Jun 4, 2026)" }],
  }), false);

  // Ordinary cycle invoice — never additive.
  assert.equal(await isAdditiveOneTimeInvoice({
    id: "inv-cycle",
    metadata: null,
    lineItems: [{ description: "Extensions" }],
  }), false);

  // Line items fetched from the db when the caller loaded the invoice bare
  // (the admin /pay route does findUnique without include).
  const fetched: string[] = [];
  const dbOverride = {
    billingInvoiceLineItem: {
      findMany: async ({ where }: any) => {
        fetched.push(where.invoiceId);
        return [{ description: "Monthly service balance (Jul 2026)" }];
      },
    },
  };
  assert.equal(await isAdditiveOneTimeInvoice({ id: "inv-bare", source: "MANUAL", metadata: { source: "manual_invoice" } }, dbOverride), false);
  assert.deepEqual(fetched, ["inv-bare"]);
  mock.restoreAll();
});
