import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBillingInvoiceIdFromEmailJob,
  extractBillingTransactionIdFromEmailJob,
} from "./billingEmailAttachments";
import { billingInvoiceEmailMarker, billingPaymentTransactionMarker } from "./emailTemplates";

test("extractBillingInvoiceIdFromEmailJob reads hidden HTML marker", () => {
  const id = extractBillingInvoiceIdFromEmailJob({
    type: "BILLING_INVOICE_SENT",
    htmlBody: `<p>Pay now</p>${billingInvoiceEmailMarker("inv_abc123")}`,
    textBody: "plain",
  });
  assert.equal(id, "inv_abc123");
});

test("extractBillingTransactionIdFromEmailJob reads receipt transaction marker", () => {
  const id = extractBillingTransactionIdFromEmailJob({
    type: "BILLING_RECEIPT",
    htmlBody: billingPaymentTransactionMarker("tx_receipt_1"),
    textBody: "",
  });
  assert.equal(id, "tx_receipt_1");
});

test("extractBillingInvoiceIdFromEmailJob falls back to portal invoice path", () => {
  const id = extractBillingInvoiceIdFromEmailJob({
    type: "BILLING_INVOICE_READY",
    htmlBody: '<a href="https://example.com/billing/invoices/clxyz99">View</a>',
    textBody: "",
  });
  assert.equal(id, "clxyz99");
});

test("extractBillingInvoiceIdFromEmailJob ignores non-billing email types", () => {
  const id = extractBillingInvoiceIdFromEmailJob({
    type: "PASSWORD_RESET",
    htmlBody: billingInvoiceEmailMarker("inv_should_ignore"),
    textBody: "",
  });
  assert.equal(id, null);
});

test("extractBillingTransactionIdFromEmailJob ignores non-receipt email types", () => {
  const id = extractBillingTransactionIdFromEmailJob({
    type: "BILLING_INVOICE_SENT",
    htmlBody: billingPaymentTransactionMarker("tx_should_ignore"),
    textBody: "",
  });
  assert.equal(id, null);
});

test("payment failure email type is not a billing PDF email type", () => {
  const id = extractBillingInvoiceIdFromEmailJob({
    type: "BILLING_PAYMENT_FAILED",
    htmlBody: billingInvoiceEmailMarker("inv_1"),
    textBody: "",
  });
  assert.equal(id, null);
});
