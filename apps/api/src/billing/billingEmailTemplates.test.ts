import test from "node:test";
import assert from "node:assert/strict";
import { invoiceSentEmail, paymentLinkEmail, paymentReceiptEmail, paymentFailedEmail } from "./emailTemplates";
import { billingInvoicePdfApiUrl, billingInvoicePortalUrl, billingInvoicePublicPayUrl } from "./billingEmailLifecycle";
import { verifyBillingInvoicePayToken } from "./billingPayToken";
import { resolveInvoiceEmailBranding } from "./invoiceBranding";

// ---------------------------------------------------------------------------
// invoiceSentEmail
// ---------------------------------------------------------------------------

test("invoiceSentEmail includes Pay Invoice CTA and attached-PDF note", () => {
  const t = invoiceSentEmail({
    invoiceNumber: "INV-1",
    totalCents: 5000,
    dueDate: new Date("2026-06-01"),
    portalInvoiceUrl: "https://example.com/pay/invoice/token123",
    billingInvoiceId: "inv_x",
  });
  assert.match(t.html, /Pay Invoice/);
  assert.match(t.text, /https:\/\/example\.com\/pay\/invoice\/token123/);
  assert.match(t.html, /invoice PDF is attached/i);
  assert.match(t.html, /connect-billing-invoice:inv_x/);
  assert.doesNotMatch(t.html, /\/api\/billing\/platform\/invoices\//);
});

test("invoiceSentEmail shows invoice number and amount", () => {
  const t = invoiceSentEmail({
    invoiceNumber: "INV-42",
    totalCents: 9900,
    dueDate: new Date("2026-07-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_test",
  });
  assert.match(t.html, /INV-42/);
  assert.match(t.html, /\$99\.00/);
  assert.match(t.subject, /INV-42/);
  assert.match(t.subject, /\$99\.00/);
});

test("invoiceSentEmail renders service period when provided", () => {
  const t = invoiceSentEmail({
    invoiceNumber: "INV-3",
    totalCents: 1000,
    dueDate: new Date("2026-06-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_test",
    servicePeriod: "May 1 – May 31, 2026",
  });
  assert.match(t.html, /May 1/);
  assert.match(t.html, /May 31/);
});

test("invoiceSentEmail omits service period row when not provided", () => {
  const t = invoiceSentEmail({
    invoiceNumber: "INV-4",
    totalCents: 1000,
    dueDate: new Date("2026-06-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_test",
  });
  assert.doesNotMatch(t.html, /Service period/);
});

test("invoiceSentEmail shows tenant or branded name only as billed company context", () => {
  const brand = resolveInvoiceEmailBranding({ invoiceCompanyName: "Northwind Telecom" }, "T");
  const t = invoiceSentEmail({
    invoiceNumber: "INV-9",
    totalCents: 1200,
    dueDate: new Date("2026-07-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_test",
    brand,
  });
  assert.match(t.html, /Billed company/);
  assert.match(t.html, /Northwind Telecom/);
  assert.doesNotMatch(t.subject, /Northwind Telecom/);
  assert.doesNotMatch(t.html, /Sent by <strong[^>]*>Northwind Telecom<\/strong> via Connect Communications billing/);
});

test("invoiceSentEmail footer always uses Connect sender wording and support info", () => {
  const brand = resolveInvoiceEmailBranding({ invoiceFooterNote: "Tenant legal footer" }, "Landau Home");
  const t = invoiceSentEmail({
    invoiceNumber: "INV-SENDER",
    totalCents: 1200,
    dueDate: new Date("2026-07-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_sender_test",
    brand,
  });
  assert.match(t.html, /Sent by Connect Communications billing\./);
  assert.doesNotMatch(t.html, /Sent by Landau Home via Connect Communications billing/);
  assert.match(t.html, /Connect Communications, LLC/);
  assert.match(t.html, /support@connectcomunications\.com/);
  assert.match(t.html, /connectcomunications\.com/);
  assert.match(t.html, /845-723-1213/);
  assert.doesNotMatch(t.html, /Tenant legal footer/);
});

test("invoiceSentEmail uses white/light background (not dark)", () => {
  const t = invoiceSentEmail({
    invoiceNumber: "INV-0",
    totalCents: 100,
    dueDate: new Date("2026-07-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_test",
  });
  // Light outer background
  assert.match(t.html, /#f3f6fa/);
  // White card
  assert.match(t.html, /#ffffff/);
  // Must NOT have the old dark background
  assert.doesNotMatch(t.html, /#0b1220/);
});

// ---------------------------------------------------------------------------
// paymentLinkEmail
// ---------------------------------------------------------------------------

test("paymentLinkEmail includes pay URL", () => {
  const t = paymentLinkEmail({
    invoiceNumber: "INV-2",
    totalCents: 100,
    dueDate: new Date("2026-01-02"),
    payUrl: "https://example.com/billing/invoices/y",
  });
  assert.match(t.html, /Pay Invoice/);
  assert.match(t.html, /https:\/\/example\.com\/billing\/invoices\/y/);
  assert.match(t.text, /INV-2/);
});

test("invoice and payment link HTML do not expose raw payment URL as visible content", () => {
  const invoice = invoiceSentEmail({
    invoiceNumber: "INV-RAW",
    totalCents: 100,
    dueDate: new Date("2026-01-02"),
    portalInvoiceUrl: "https://example.com/pay/invoice/raw-token",
    billingInvoiceId: "inv_raw",
  });
  const link = paymentLinkEmail({
    invoiceNumber: "INV-RAW2",
    totalCents: 100,
    dueDate: new Date("2026-01-02"),
    payUrl: "https://example.com/pay/invoice/raw-token-2",
  });
  assert.doesNotMatch(invoice.html, />\s*https:\/\/example\.com\/pay\/invoice\/raw-token\s*</);
  assert.doesNotMatch(link.html, />\s*https:\/\/example\.com\/pay\/invoice\/raw-token-2\s*</);
});

// ---------------------------------------------------------------------------
// paymentReceiptEmail
// ---------------------------------------------------------------------------

test("paymentReceiptEmail includes invoice number and amount", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-5",
    totalCents: 7500,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_5",
    portalInvoiceUrl: "https://example.com/i",
  });
  assert.match(t.html, /INV-5/);
  assert.match(t.html, /\$75\.00/);
  assert.match(t.subject, /INV-5/);
});

test("paymentReceiptEmail shows payment confirmation badge", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-6",
    totalCents: 1000,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_test_6",
  });
  assert.match(t.html, /Payment confirmed/);
  assert.match(t.html, /Thank you/);
});

test("paymentReceiptEmail includes masked card label when provided", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-7",
    totalCents: 2000,
    paidAt: new Date("2026-05-01"),
    billingInvoiceId: "inv_7",
    cardLabel: "Visa •••• 4242",
  });
  assert.match(t.html, /Visa/);
  assert.match(t.html, /4242/);
  // Must NOT contain full card number patterns
  assert.doesNotMatch(t.html, /\b\d{16}\b/);
});

test("paymentReceiptEmail notes PDF attachment and embeds invoice marker", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-8",
    totalCents: 3000,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_abc",
    portalInvoiceUrl: "https://example.com/i",
  });
  assert.match(t.html, /invoice PDF is attached/i);
  assert.match(t.html, /connect-billing-invoice:inv_abc/);
  assert.doesNotMatch(t.html, /\/api\/billing\/platform\/invoices\//);
});

test("paymentReceiptEmail does not include Pay Invoice CTA", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-PAID",
    totalCents: 3000,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_paid",
    portalInvoiceUrl: "https://example.com/i",
  });
  assert.doesNotMatch(t.html, /Pay Invoice/);
  assert.doesNotMatch(t.text, /Pay invoice:/);
});

test("paymentReceiptEmail shows autopay note when paidViaAutopay", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-9",
    totalCents: 5000,
    paidAt: new Date("2026-05-01"),
    billingInvoiceId: "inv_9",
    paidViaAutopay: true,
  });
  assert.match(t.html, /saved payment method/);
  assert.match(t.subject, /Autopay receipt/);
});

test("paymentReceiptEmail does not include raw card details", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-10",
    totalCents: 1000,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_10",
    cardLabel: "Visa •••• 4242",
  });
  // No raw token / CVV / full card number
  assert.doesNotMatch(t.html, /xToken/);
  assert.doesNotMatch(t.html, /cvv/i);
  assert.doesNotMatch(t.html, /rawResponse/i);
});

test("paymentReceiptEmail uses white/light background", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-11",
    totalCents: 100,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_11",
  });
  assert.match(t.html, /#f3f6fa/);
  assert.doesNotMatch(t.html, /#0b1220/);
});

// ---------------------------------------------------------------------------
// paymentFailedEmail
// ---------------------------------------------------------------------------

test("paymentFailedEmail includes invoice and update URL", () => {
  const t = paymentFailedEmail({
    invoiceNumber: "INV-12",
    totalCents: 4000,
    reason: "Card declined",
    updateUrl: "https://example.com/billing/payments",
  });
  assert.match(t.html, /INV-12/);
  assert.match(t.html, /Card declined/);
  assert.match(t.html, /Update saved card/);
});

// ---------------------------------------------------------------------------
// Logo fallback
// ---------------------------------------------------------------------------

test("emailShell renders img tag even without logoUrl (uses fallback)", () => {
  const brand = resolveInvoiceEmailBranding({}, null);
  const t = invoiceSentEmail({
    invoiceNumber: "INV-LF",
    totalCents: 100,
    dueDate: new Date("2026-06-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_test",
    brand,
  });
  // Should contain an img tag pointing to connect-logo.png
  assert.match(t.html, /connect-logo\.png/);
  assert.match(t.html, /<img/);
});

test("emailShell keeps Connect logo even when custom logoUrl is configured", () => {
  const brand = resolveInvoiceEmailBranding(
    { invoiceLogoUrl: "https://cdn.example.com/mybrand-logo.png" },
    "My Brand",
  );
  const t = invoiceSentEmail({
    invoiceNumber: "INV-CL",
    totalCents: 100,
    dueDate: new Date("2026-06-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_test",
    brand,
  });
  assert.match(t.html, /connect-logo\.png/);
  assert.doesNotMatch(t.html, /mybrand-logo\.png/);
});

// ---------------------------------------------------------------------------
// Billing URL helpers
// ---------------------------------------------------------------------------

test("billing URL helpers are stable strings", () => {
  process.env.BILLING_PAY_TOKEN_SECRET = "test-secret";
  assert.match(billingInvoicePortalUrl("abc123"), /\/billing\/invoices\/abc123$/);
  const publicUrl = billingInvoicePublicPayUrl("abc123", "tenant123");
  assert.match(publicUrl, /\/pay\/invoice\//);
  const token = decodeURIComponent(publicUrl.split("/pay/invoice/")[1]);
  assert.deepEqual(verifyBillingInvoicePayToken(token)?.invoiceId, "abc123");
  assert.match(billingInvoicePdfApiUrl("abc123"), /\/pdf$/);
});
