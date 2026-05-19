import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBillingInvoiceDeletable } from "./deleteBillingInvoice.js";

test("assertBillingInvoiceDeletable: allows OPEN without payments", () => {
  const r = assertBillingInvoiceDeletable({ status: "OPEN", transactions: [] });
  assert.equal(r.ok, true);
});

test("assertBillingInvoiceDeletable: allows VOID cleanup", () => {
  const r = assertBillingInvoiceDeletable({ status: "VOID" });
  assert.equal(r.ok, true);
});

test("assertBillingInvoiceDeletable: blocks PAID", () => {
  const r = assertBillingInvoiceDeletable({ status: "PAID" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "invoice_paid");
});

test("assertBillingInvoiceDeletable: blocks when any transaction APPROVED", () => {
  const r = assertBillingInvoiceDeletable({
    status: "OPEN",
    transactions: [{ status: "DECLINED" }, { status: "APPROVED" }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "invoice_has_approved_payment");
});

test("assertBillingInvoiceDeletable: allows declined-only attempts", () => {
  const r = assertBillingInvoiceDeletable({
    status: "FAILED",
    transactions: [{ status: "DECLINED" }, { status: "ERROR" }],
  });
  assert.equal(r.ok, true);
});
