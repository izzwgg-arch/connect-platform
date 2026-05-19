import test from "node:test";
import assert from "node:assert/strict";
import { extractBillingInvoiceIdFromEmailJob } from "./billingEmailAttachments";
import { billingInvoiceEmailMarker } from "./emailTemplates";

test("extractBillingInvoiceIdFromEmailJob reads hidden HTML marker", () => {
  const id = extractBillingInvoiceIdFromEmailJob({
    type: "BILLING_INVOICE_SENT",
    htmlBody: `<p>Pay now</p>${billingInvoiceEmailMarker("inv_abc123")}`,
    textBody: "plain",
  });
  assert.equal(id, "inv_abc123");
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
