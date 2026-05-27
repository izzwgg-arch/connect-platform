/**
 * Tests for invoiceEditEngine.ts
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
// Mutable shared state — swapped between sub-tests
// ---------------------------------------------------------------------------

type FakeLineItem = {
  id: string;
  invoiceId: string;
  tenantId: string;
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  metadata: null;
};

const state = {
  invoice: null as any,
  lineItems: [] as FakeLineItem[],
  lastUpdateData: null as any,
  lastDeletedId: null as string | null,
  lastCreatedLineItem: null as any,
};

function resetState(inv: any, items: FakeLineItem[] = []) {
  state.invoice = { ...inv };
  state.lineItems = items.map((i) => ({ ...i }));
  state.lastUpdateData = null;
  state.lastDeletedId = null;
  state.lastCreatedLineItem = null;
}

const db = {
  billingInvoice: {
    findUnique: async ({ where }: any) => {
      if (!state.invoice || where.id !== state.invoice.id) return null;
      return { ...state.invoice, lineItems: state.lineItems.map((li) => ({ ...li })) };
    },
    update: async ({ where: _w, data }: any) => {
      state.lastUpdateData = data;
      // Apply updates to state.invoice
      const { lineItems, ...rest } = data;
      state.invoice = { ...state.invoice, ...rest };
      if (lineItems?.create) {
        state.lineItems = lineItems.create.map((li: any, i: number) => ({
          ...li,
          id: `li-new-${i}`,
          invoiceId: state.invoice.id,
        }));
      }
      return { ...state.invoice, lineItems: state.lineItems };
    },
  },
  billingInvoiceLineItem: {
    deleteMany: async () => {
      state.lineItems = [];
      return { count: 0 };
    },
    create: async ({ data }: any) => {
      const li = { ...data, id: `li-created-${state.lineItems.length}` };
      state.lineItems.push(li);
      state.lastCreatedLineItem = li;
      return li;
    },
    delete: async ({ where }: any) => {
      const idx = state.lineItems.findIndex((li) => li.id === where.id);
      if (idx === -1) throw new Error("line item not found");
      const [removed] = state.lineItems.splice(idx, 1);
      state.lastDeletedId = removed.id;
      return removed;
    },
  },
  billingEventLog: {
    create: async ({ data }: any) => ({ ...data, id: "ble-1", createdAt: new Date() }),
  },
  $transaction: async (ops: any[]) => {
    const results: any[] = [];
    for (const op of ops) results.push(await op);
    return results;
  },
};

// ---------------------------------------------------------------------------
// Test suite (single top-level test, one mock registration)
// ---------------------------------------------------------------------------

test("invoiceEditEngine — all scenarios", async () => {
  mock.module("@connect/db", { namedExports: { db } });
  mock.module("./invoiceEngine", {
    namedExports: {
      logBillingEvent: async (_: any) => ({ id: "ble-1" }),
    },
  });

  const {
    replaceInvoiceLineItems,
    deleteInvoiceLineItem,
    updateInvoiceMeta,
    addInvoiceLineItem,
  } = await import("./invoiceEditEngine");

  // ── 1. replaceInvoiceLineItems — recalculates totals ─────────────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "OPEN", totalCents: 6000, amountPaidCents: 0, balanceDueCents: 6000, metadata: null },
    [{ id: "li-1", invoiceId: "inv-1", tenantId: "t-1", type: "EXTENSION", description: "Ext 101", quantity: 2, unitPriceCents: 3000, amountCents: 6000, taxable: true, metadata: null }],
  );
  const result1 = await replaceInvoiceLineItems(
    "inv-1",
    [
      { type: "EXTENSION", description: "Ext 101", quantity: 1, unitPriceCents: 3000, taxable: true },
      { type: "EXTENSION", description: "Ext 102", quantity: 1, unitPriceCents: 2500, taxable: true },
      { type: "SALES_TAX", description: "Sales Tax", quantity: 1, unitPriceCents: 440, taxable: false },
    ],
    "admin-1",
    { allowPaidEdit: false },
  );
  assert.equal(result1.invoice.subtotalCents, 5500, "subtotal = 3000+2500");
  assert.equal(result1.invoice.taxCents, 440, "tax from SALES_TAX line");
  assert.equal(result1.invoice.totalCents, 5940, "total = subtotal+tax");
  assert.equal(result1.totalWasAffected, true);
  assert.equal(result1.changed, true);

  // ── 2. replaceInvoiceLineItems — VOID guard ───────────────────────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "VOID", totalCents: 6000, amountPaidCents: 0, balanceDueCents: 6000, metadata: null },
    [],
  );
  await assert.rejects(
    () => replaceInvoiceLineItems("inv-1", [{ type: "EXTENSION", description: "x", quantity: 1, unitPriceCents: 1000 }], "admin-1"),
    (err: any) => { assert.equal(err.code, "INVOICE_VOID_NOT_EDITABLE"); return true; },
  );

  // ── 3. replaceInvoiceLineItems — PAID without confirmation ────────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "PAID", totalCents: 6000, amountPaidCents: 6000, balanceDueCents: 0, metadata: null },
    [],
  );
  await assert.rejects(
    () => replaceInvoiceLineItems("inv-1", [{ type: "EXTENSION", description: "x", quantity: 1, unitPriceCents: 1000 }], "admin-1"),
    (err: any) => { assert.equal(err.code, "INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION"); return true; },
  );

  // ── 4. replaceInvoiceLineItems — PAID with allowPaidEdit=true ─────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "PAID", totalCents: 6000, amountPaidCents: 6000, balanceDueCents: 0, metadata: null },
    [],
  );
  const result4 = await replaceInvoiceLineItems(
    "inv-1",
    [{ type: "EXTENSION", description: "x", quantity: 1, unitPriceCents: 7000 }],
    "admin-1",
    { allowPaidEdit: true },
  );
  // balance = max(0, 7000 - 6000 paid) = 1000
  assert.equal(result4.invoice.balanceDueCents, 1000, "recalculated balance for paid invoice");
  assert.equal(result4.totalWasAffected, true);

  // ── 5. deleteInvoiceLineItem — removes item and recalculates ─────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "OPEN", totalCents: 9000, amountPaidCents: 0, balanceDueCents: 9000, subtotalCents: 9000, taxCents: 0, metadata: null },
    [
      { id: "li-1", invoiceId: "inv-1", tenantId: "t-1", type: "EXTENSION", description: "Ext 101", quantity: 2, unitPriceCents: 3000, amountCents: 6000, taxable: true, metadata: null },
      { id: "li-2", invoiceId: "inv-1", tenantId: "t-1", type: "EXTENSION", description: "Ext 102", quantity: 1, unitPriceCents: 3000, amountCents: 3000, taxable: true, metadata: null },
    ],
  );
  const result5 = await deleteInvoiceLineItem("inv-1", "li-2", "admin-1");
  assert.equal(result5.deleted, true);
  assert.equal(result5.newTotalCents, 6000, "total recalculated after deletion");

  // ── 6. updateInvoiceMeta — updates dueDate and notes ────────────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "OPEN", totalCents: 6000, amountPaidCents: 0, balanceDueCents: 6000, metadata: null },
    [],
  );
  const newDue = new Date("2026-07-01T00:00:00Z");
  const result6 = await updateInvoiceMeta("inv-1", { dueDate: newDue, notes: "Updated note" }, "admin-1");
  assert.ok(result6, "returned updated invoice");

  // ── 7. addInvoiceLineItem — adds item and recalculates ───────────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "OPEN", totalCents: 6000, subtotalCents: 6000, taxCents: 0, amountPaidCents: 0, balanceDueCents: 6000, metadata: null },
    [{ id: "li-1", invoiceId: "inv-1", tenantId: "t-1", type: "EXTENSION", description: "Ext 101", quantity: 2, unitPriceCents: 3000, amountCents: 6000, taxable: true, metadata: null }],
  );
  const result7 = await addInvoiceLineItem(
    "inv-1",
    { type: "ONE_TIME", description: "Setup fee", quantity: 1, unitPriceCents: 5000 },
    "admin-1",
  );
  assert.ok(result7.lineItem, "returned new line item");
  // New total = 6000 (existing) + 5000 (new) = 11000
  assert.equal(result7.invoice.totalCents, 11000, "total includes new item");

  // ── 8. addInvoiceLineItem — rejects unknown type ────────────────────────
  resetState(
    { id: "inv-1", tenantId: "t-1", invoiceNumber: "CC-X", status: "OPEN", totalCents: 1000, amountPaidCents: 0, balanceDueCents: 1000, metadata: null },
    [],
  );
  await assert.rejects(
    () => addInvoiceLineItem("inv-1", { type: "BOGUS_TYPE", description: "x", quantity: 1, unitPriceCents: 1000 }, "admin-1"),
    (err: any) => { assert.equal(err.code, "LINE_ITEM_INVALID"); return true; },
  );
});
