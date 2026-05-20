import assert from "node:assert/strict";
import test from "node:test";
import { billingInvoiceNumberPrefix, nextInvoiceSequenceAfter } from "./invoiceEngine";

test("nextInvoiceSequenceAfter increments fixed-width suffix", () => {
  const prefix = "CC-202605";
  assert.equal(nextInvoiceSequenceAfter(null, prefix), 1);
  assert.equal(nextInvoiceSequenceAfter("CC-202605-00009", prefix), 10);
  assert.equal(nextInvoiceSequenceAfter("CC-202605-00042", prefix), 43);
});

test("nextInvoiceSequenceAfter ignores non-matching or malformed numbers", () => {
  const prefix = billingInvoiceNumberPrefix(new Date("2026-05-15T12:00:00Z"));
  assert.equal(prefix, "CC-202605");
  assert.equal(nextInvoiceSequenceAfter("CC-202604-99999", prefix), 1);
  assert.equal(nextInvoiceSequenceAfter("CC-202605-ABC12", prefix), 1);
});

test("billing invoice numbers from two tenants do not reuse the same global sequence", () => {
  const prefix = "CC-202605";
  const afterTenantA = nextInvoiceSequenceAfter("CC-202605-00011", prefix);
  assert.equal(afterTenantA, 12);
  const formatted = `${prefix}-${String(afterTenantA).padStart(5, "0")}`;
  assert.equal(formatted, "CC-202605-00012");
});
