import test from "node:test";
import assert from "node:assert/strict";
import { worstNonTerminalInvoiceStatus, worstOpenInvoice } from "./billingUi";

test("billing overview ignores paid and zero-balance invoices", () => {
  const invoices = [
    { status: "PAID", balanceDueCents: 0 },
    { status: "FAILED", balanceDueCents: 0 },
    { status: "OVERDUE", balanceDueCents: 0 },
  ];

  assert.equal(worstOpenInvoice(invoices), null);
  assert.equal(worstNonTerminalInvoiceStatus(invoices), "—");
});

test("billing overview still flags invoices with an active balance", () => {
  const invoices = [
    { status: "OPEN", balanceDueCents: 1200 },
    { status: "FAILED", balanceDueCents: 500 },
  ];

  assert.equal(worstOpenInvoice(invoices)?.status, "FAILED");
  assert.equal(worstNonTerminalInvoiceStatus(invoices), "FAILED");
});
