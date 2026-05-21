import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INVOICE_DISPLAY_NAME,
  normalizeBrandingPayload,
  resolveInvoiceEmailBranding,
  sanitizeInvoiceLogoUrl,
} from "./invoiceBranding";
import { invoiceSentEmail } from "./emailTemplates";

test("sanitizeInvoiceLogoUrl rejects non-https", () => {
  assert.equal(sanitizeInvoiceLogoUrl("http://evil.com/x.png"), null);
  assert.equal(sanitizeInvoiceLogoUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeInvoiceLogoUrl("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
});

test("resolveInvoiceEmailBranding falls back to tenant name then platform default", () => {
  const a = resolveInvoiceEmailBranding({}, "Acme Tenant");
  assert.equal(a.displayName, "Acme Tenant");
  const b = resolveInvoiceEmailBranding({ invoiceCompanyName: "  Widgets LLC  " }, "Ignored");
  assert.equal(b.displayName, "Widgets LLC");
  const c = resolveInvoiceEmailBranding({}, null);
  assert.equal(c.displayName, DEFAULT_INVOICE_DISPLAY_NAME);
});

test("normalizeBrandingPayload clears invalid support email", () => {
  const out = normalizeBrandingPayload({ invoiceSupportEmail: "not-an-email" });
  assert.equal(out.invoiceSupportEmail, null);
});

test("invoiceSentEmail embeds company display name as billed company context", () => {
  const brand = resolveInvoiceEmailBranding({ invoiceCompanyName: "Northwind" }, "T");
  const t = invoiceSentEmail({
    invoiceNumber: "INV-9",
    totalCents: 1200,
    dueDate: new Date("2026-07-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_brand_test",
    brand,
  });
  assert.match(t.html, /Billed company/);
  assert.match(t.html, /Northwind/);
  assert.doesNotMatch(t.html, /Sent by Northwind via Connect Communications billing/);
});
