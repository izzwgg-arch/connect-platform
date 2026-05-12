import test from "node:test";
import assert from "node:assert/strict";
import { invoiceSentEmail, paymentLinkEmail } from "./emailTemplates";
import { billingInvoicePdfApiUrl, billingInvoicePortalUrl } from "./billingEmailLifecycle";

test("invoiceSentEmail includes portal and PDF links", () => {
  const t = invoiceSentEmail({
    invoiceNumber: "INV-1",
    totalCents: 5000,
    dueDate: new Date("2026-06-01"),
    portalInvoiceUrl: "https://example.com/billing/invoices/x",
    pdfUrl: "https://example.com/api/billing/platform/invoices/x/pdf",
  });
  assert.match(t.html, /View &amp; pay in portal/);
  assert.match(t.text, /https:\/\/example\.com\/billing\/invoices\/x/);
});

test("paymentLinkEmail includes pay URL", () => {
  const t = paymentLinkEmail({
    invoiceNumber: "INV-2",
    totalCents: 100,
    dueDate: new Date("2026-01-02"),
    payUrl: "https://example.com/billing/invoices/y",
  });
  assert.match(t.html, /Open invoice/);
});

test("billing URL helpers are stable strings", () => {
  assert.match(billingInvoicePortalUrl("abc123"), /\/billing\/invoices\/abc123$/);
  assert.match(billingInvoicePdfApiUrl("abc123"), /\/pdf$/);
});
