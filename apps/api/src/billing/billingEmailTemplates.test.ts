import test from "node:test";
import assert from "node:assert/strict";
import { autopayReminderEmail, emailShell, invoiceSentEmail, paymentLinkEmail, paymentReceiptEmail, paymentFailedEmail } from "./emailTemplates";
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
  assert.doesNotMatch(t.html, /Sent by <strong[^>]*>Northwind Telecom<\/strong> via Loopcom billing/);
});

test("invoiceSentEmail footer always uses Loopcom sender wording and support info", () => {
  const brand = resolveInvoiceEmailBranding({ invoiceFooterNote: "Tenant legal footer" }, "Landau Home");
  const t = invoiceSentEmail({
    invoiceNumber: "INV-SENDER",
    totalCents: 1200,
    dueDate: new Date("2026-07-01"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_sender_test",
    brand,
  });
  assert.match(t.html, /Sent by Loopcom billing\./);
  assert.doesNotMatch(t.html, /Sent by Landau Home via Loopcom billing/);
  assert.match(t.html, /Loopcom/);
  assert.match(t.html, /billing@loopcom\.net/);
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
    transactionId: "tx_5",
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
    transactionId: "tx_6",
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
    transactionId: "tx_7",
    cardLabel: "Visa •••• 4242",
  });
  assert.match(t.html, /Visa/);
  assert.match(t.html, /4242/);
  // Must NOT contain full card number patterns
  assert.doesNotMatch(t.html, /\b\d{16}\b/);
});

test("paymentReceiptEmail notes both PDF attachments and embeds invoice + transaction markers", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-8",
    totalCents: 3000,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_abc",
    transactionId: "tx_abc",
    portalInvoiceUrl: "https://example.com/i",
  });
  assert.match(t.html, /Your invoice and your receipt are attached to this email as PDFs/i);
  assert.match(t.html, /connect-billing-invoice:inv_abc/);
  assert.match(t.html, /connect-billing-transaction:tx_abc/);
  assert.doesNotMatch(t.html, /\/api\/billing\/platform\/invoices\//);
});

test("paymentReceiptEmail does not include Pay Invoice CTA", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-PAID",
    totalCents: 3000,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_paid",
    transactionId: "tx_paid",
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
    transactionId: "tx_9",
    paidViaAutopay: true,
  });
  assert.match(t.html, /saved payment method/);
  // One heading and subject either way — the autopay note below carries the nuance.
  assert.match(t.subject, /Payment successful/);
  assert.match(t.html, /Payment successful/);
  assert.doesNotMatch(t.html, /Autopay successful/);
});

test("paymentReceiptEmail does not include raw card details", () => {
  const t = paymentReceiptEmail({
    invoiceNumber: "INV-10",
    totalCents: 1000,
    paidAt: new Date("2026-05-19"),
    billingInvoiceId: "inv_10",
    transactionId: "tx_10",
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
    transactionId: "tx_11",
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
  // Should contain an img tag pointing to the Loopcom wordmark
  assert.match(t.html, /loopcom-wordmark-560\.png/);
  assert.match(t.html, /<img/);
});

test("emailShell keeps the Loopcom logo even when a custom logoUrl is configured", () => {
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
  assert.match(t.html, /loopcom-wordmark-560\.png/);
  assert.doesNotMatch(t.html, /mybrand-logo\.png/);
});

// ---------------------------------------------------------------------------
// autopayReminderEmail
// ---------------------------------------------------------------------------

test("autopayReminderEmail says due in 3 days and autopay will charge", () => {
  const t = autopayReminderEmail({
    invoiceNumber: "CC-100",
    totalCents: 9900,
    dueDate: new Date("2026-06-21"),
    scheduledChargeAt: new Date("2026-06-21"),
    billingInvoiceId: "inv_rem",
  });
  assert.match(t.subject, /due in 3 days/i);
  assert.match(t.html, /due in 3 days/i);
  assert.match(t.html, /charged automatically/i);
  assert.match(t.html, /invoice PDF is attached/i);
  assert.match(t.html, /connect-billing-invoice:inv_rem/);
  assert.doesNotMatch(t.html, /Payment confirmed/i);
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

test("billing emails mention Connect Communications nowhere", () => {
  const built = invoiceSentEmail({
    invoiceNumber: "CC-202608-00014",
    totalCents: 30500,
    dueDate: new Date("2026-09-01T00:00:00Z"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_guard",
  });
  for (const part of [built.html, built.text, built.subject]) {
    assert.ok(!/Connect Communications/i.test(part), "Connect Communications still present");
    assert.ok(!/support@connectcomunications\.com/i.test(part), "old support address still present");
  }
  assert.match(built.html, /billing@loopcom\.net/);
});

// ---------------------------------------------------------------------------
// emailShell defaults
//
// The shell became reusable on 2026-08-17 so the port-complete customer email
// could sit on the hardened chrome instead of a third copy of it. Every option
// defaults to the billing behaviour, and these assertions are what stop a
// future non-billing caller from "simplifying" the defaults and silently
// restyling nine live billing emails. Proven byte-identical against the
// pre-change file at the time of the change.
// ---------------------------------------------------------------------------

test("billing emails keep the Billing eyebrow, the billing footer and the support card", () => {
  const built = invoiceSentEmail({
    invoiceNumber: "CC-202608-00099",
    totalCents: 3500,
    dueDate: new Date("2026-09-01T00:00:00Z"),
    portalInvoiceUrl: "https://example.com/i",
    billingInvoiceId: "inv_shell",
  });
  assert.match(built.html, />Billing<\/p>/, "the Billing eyebrow disappeared from billing email");
  assert.match(built.html, /Sent by Loopcom billing\./, "the billing footer changed");
  assert.match(built.html, /Need help with billing\?/, "the billing support card disappeared");
});

test("the shell can drop its billing chrome without touching the billing defaults", () => {
  const plain = emailShell("Heading", "<p>Body</p>", resolveInvoiceEmailBranding({}, null), {
    eyebrow: null,
    footerNote: "Sent by Loopcom.",
    includeSupportBlock: false,
  });
  assert.ok(!/>Billing<\/p>/.test(plain));
  assert.ok(!/Sent by Loopcom billing\./.test(plain));
  assert.ok(!/Need help with billing\?/.test(plain));
  assert.match(plain, /Sent by Loopcom\./);
  // …and the hardening survives the stripped-down variant.
  assert.match(plain, /<!--\[if mso\]>/);
  assert.match(plain, /max-width:600px/);

  // The very next call with no options is still a billing email.
  const billing = emailShell("Heading", "<p>Body</p>", resolveInvoiceEmailBranding({}, null));
  assert.match(billing, />Billing<\/p>/);
  assert.match(billing, /Sent by Loopcom billing\./);
});
