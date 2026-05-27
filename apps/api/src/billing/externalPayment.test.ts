/**
 * Tests for externalPayment.ts
 *
 * ESM module-mock rule (node:test --experimental-test-module-mocks):
 *  - mock.module() may only be called once per module per test file.
 *  - All sub-tests share one top-level test block; the mutable `state` object
 *    is swapped between sub-cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// ---------------------------------------------------------------------------
// Mutable state — swapped per sub-test
// ---------------------------------------------------------------------------

const state = {
  invoice: null as any,
  transactions: [] as any[],
  lastTransaction: null as any,
  lastInvoiceUpdate: null as any,
  gatewayCallCount: 0,
  emailQueued: false,
};

function resetState(inv: any, txns: any[] = []) {
  state.invoice = { ...inv };
  state.transactions = txns.map((t) => ({ ...t }));
  state.lastTransaction = null;
  state.lastInvoiceUpdate = null;
  state.gatewayCallCount = 0;
  state.emailQueued = false;
}

const db = {
  billingInvoice: {
    findUnique: async ({ where }: any) => {
      if (!state.invoice || where.id !== state.invoice.id) return null;
      return { ...state.invoice };
    },
    update: async ({ where: _w, data }: any) => {
      state.lastInvoiceUpdate = data;
      state.invoice = { ...state.invoice, ...data };
      return { ...state.invoice };
    },
  },
  paymentTransaction: {
    // Flat-object where clause (no AND) — match on all provided keys
    findFirst: async ({ where }: any) => {
      return (
        state.transactions.find((t) => {
          for (const [k, v] of Object.entries(where)) {
            if (t[k] !== v) return false;
          }
          return true;
        }) ?? null
      );
    },
    create: async ({ data }: any) => {
      const txn = { id: `txn-${state.transactions.length + 1}`, createdAt: new Date(), ...data };
      state.lastTransaction = txn;
      state.transactions.push(txn);
      return txn;
    },
  },
  billingEventLog: {
    create: async ({ data }: any) => ({ id: "ble-1", ...data, createdAt: new Date() }),
  },
  // Array-style $transaction — ops are already promises; await each
  $transaction: async (ops: any[]) => {
    const results: any[] = [];
    for (const op of ops) results.push(await op);
    return results;
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test("externalPayment — all scenarios", async () => {
  mock.module("@connect/db", { namedExports: { db } });
  mock.module("./billingEmailLifecycle", {
    namedExports: {
      queueReceiptEmailOnce: async (_args: any) => {
        state.emailQueued = true;
        return { queued: true };
      },
    },
  });
  mock.module("./billingPeriodGuards", {
    namedExports: {
      findPaidBillingPeriodCoverage: async (_args: any) => null,
    },
  });
  mock.module("./invoiceEngine", {
    namedExports: {
      logBillingEvent: async (_args: any) => ({ id: "ble-1" }),
    },
  });

  const { postExternalPayment, externalMethodLabel } = await import("./externalPayment");

  // ── 1. Full payment marks invoice PAID, creates MANUAL transaction ────────
  resetState({
    id: "inv-1",
    tenantId: "t-1",
    invoiceNumber: "CC-2026-001",
    status: "OPEN",
    totalCents: 10000,
    amountPaidCents: 0,
    balanceDueCents: 10000,
    currency: "USD",
    billingEmail: null,
    periodStart: null,
    periodEnd: null,
    paidAt: null,
    metadata: null,
  });
  const r1 = await postExternalPayment({
    invoiceId: "inv-1",
    amountCents: 10000,
    method: "ZELLE",
    paymentDate: new Date("2026-06-01T00:00:00Z"),
    externalReference: "ZELLE-REF-001",
    payerName: "Jane Doe",
    externalNotes: "Paid via Zelle",
    createdByUserId: "admin-1",
    sendReceiptEmail: false,
  });
  assert.equal(r1.invoice.status, "PAID", "invoice fully paid");
  assert.equal(r1.invoice.amountPaidCents, 10000);
  assert.equal(r1.invoice.balanceDueCents, 0);
  assert.equal(r1.invoiceFullyPaid, true);
  assert.equal(state.lastTransaction?.source, "MANUAL", "transaction source must be MANUAL");
  assert.equal(state.lastTransaction?.processor, "MANUAL", "transaction processor must be MANUAL");
  assert.equal(state.lastTransaction?.externalMethod, "ZELLE");
  assert.equal(state.lastTransaction?.processorTransactionId, undefined, "no gateway processorTransactionId");
  assert.equal(state.emailQueued, false, "no email requested");

  // ── 2. Partial payment leaves correct balance ─────────────────────────────
  resetState({
    id: "inv-2",
    tenantId: "t-1",
    invoiceNumber: "CC-2026-002",
    status: "OPEN",
    totalCents: 10000,
    amountPaidCents: 0,
    balanceDueCents: 10000,
    currency: "USD",
    billingEmail: null,
    periodStart: null,
    periodEnd: null,
    paidAt: null,
    metadata: null,
  });
  const r2 = await postExternalPayment({
    invoiceId: "inv-2",
    amountCents: 4000,
    method: "CHECK",
    paymentDate: new Date("2026-06-01T00:00:00Z"),
    createdByUserId: "admin-1",
    sendReceiptEmail: false,
  });
  assert.equal(r2.invoice.status, "OPEN", "partial payment: invoice stays OPEN");
  assert.equal(r2.invoice.amountPaidCents, 4000, "partial amount recorded");
  assert.equal(r2.invoice.balanceDueCents, 6000, "balance = 10000 - 4000");
  assert.equal(r2.invoiceFullyPaid, false);
  assert.equal(state.emailQueued, false, "no receipt for partial payment");

  // ── 3. VOID invoice throws ────────────────────────────────────────────────
  resetState({
    id: "inv-3",
    tenantId: "t-1",
    status: "VOID",
    totalCents: 10000,
    amountPaidCents: 0,
    balanceDueCents: 10000,
    currency: "USD",
    billingEmail: null,
    metadata: null,
  });
  await assert.rejects(
    () => postExternalPayment({ invoiceId: "inv-3", amountCents: 10000, method: "CASH", paymentDate: new Date(), createdByUserId: "admin-1" }),
    (err: any) => { assert.equal(err.code, "INVOICE_VOID_CANNOT_RECEIVE_PAYMENT"); return true; },
  );

  // ── 4. Zero amount throws ─────────────────────────────────────────────────
  resetState({
    id: "inv-4",
    tenantId: "t-1",
    status: "OPEN",
    totalCents: 10000,
    amountPaidCents: 0,
    balanceDueCents: 10000,
    currency: "USD",
    billingEmail: null,
    metadata: null,
  });
  await assert.rejects(
    () => postExternalPayment({ invoiceId: "inv-4", amountCents: 0, method: "CASH", paymentDate: new Date(), createdByUserId: "admin-1" }),
    (err: any) => { assert.equal(err.code, "EXTERNAL_PAYMENT_AMOUNT_MUST_BE_POSITIVE"); return true; },
  );

  // ── 5. Duplicate reference produces warning but does not block ─────────────
  // Seed an existing transaction with same method+reference+amount
  resetState(
    {
      id: "inv-5",
      tenantId: "t-1",
      invoiceNumber: "CC-2026-005",
      status: "OPEN",
      totalCents: 10000,
      amountPaidCents: 0,
      balanceDueCents: 10000,
      currency: "USD",
      billingEmail: null,
      periodStart: null,
      periodEnd: null,
      paidAt: null,
      metadata: null,
    },
    [
      {
        id: "txn-existing",
        invoiceId: "inv-5",
        tenantId: "t-1",
        source: "MANUAL",
        externalMethod: "ZELLE",
        externalReference: "REF-DUPE",
        amountCents: 10000,
        createdAt: new Date("2026-06-01"),
      },
    ],
  );
  const r5 = await postExternalPayment({
    invoiceId: "inv-5",
    amountCents: 10000,
    method: "ZELLE",
    externalReference: "REF-DUPE",
    paymentDate: new Date("2026-06-02"),
    createdByUserId: "admin-1",
    sendReceiptEmail: false,
  });
  assert.ok(typeof r5.duplicateWarning === "string" && r5.duplicateWarning.length > 0, "duplicate reference returns a warning string");
  assert.ok(r5.invoice, "invoice still updated despite warning");

  // ── 6. Gateway is never called ────────────────────────────────────────────
  assert.equal(state.gatewayCallCount, 0, "no gateway calls in any scenario");

  // ── 7. externalMethodLabel covers all methods ─────────────────────────────
  const methods = ["QUICKPAY", "ZELLE", "CHECK", "CASH", "CARD_EXTERNAL", "ACH_EXTERNAL", "OTHER"] as const;
  for (const m of methods) {
    const label = externalMethodLabel(m);
    assert.ok(typeof label === "string" && label.length > 0, `label for ${m} is non-empty string`);
  }
  assert.equal(externalMethodLabel("ZELLE"), "Zelle");
  assert.equal(externalMethodLabel("CHECK"), "Check");
  assert.equal(externalMethodLabel("CASH"), "Cash");
  assert.equal(externalMethodLabel("QUICKPAY"), "QuickPay");

  // ── 8. Receipt email sends only on full payment ───────────────────────────
  resetState({
    id: "inv-6",
    tenantId: "t-1",
    invoiceNumber: "CC-2026-006",
    status: "OPEN",
    totalCents: 5000,
    amountPaidCents: 0,
    balanceDueCents: 5000,
    currency: "USD",
    billingEmail: "customer@example.com",
    periodStart: null,
    periodEnd: null,
    paidAt: null,
    metadata: null,
  });
  const r8 = await postExternalPayment({
    invoiceId: "inv-6",
    amountCents: 5000,
    method: "CASH",
    paymentDate: new Date(),
    createdByUserId: "admin-1",
    sendReceiptEmail: true,
  });
  assert.equal(r8.invoice.status, "PAID", "fully paid");
  assert.equal(state.emailQueued, true, "receipt email queued on full payment with sendReceiptEmail=true");
});
