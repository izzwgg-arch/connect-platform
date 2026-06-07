import test from "node:test";
import assert from "node:assert/strict";
import { generateInvoicePdf, generateReceiptPdf, renderBillingInvoicePdf } from "./pdf";

process.env.CREDENTIALS_MASTER_KEY ||= "test-master-key-for-billing-pdf-tests";

const baseInvoice = {
  id: "inv_pdf_1",
  tenantId: "tenant_1",
  invoiceNumber: "CC-TEST-001",
  status: "PAID",
  totalCents: 9900,
  balanceDueCents: 0,
  amountPaidCents: 9900,
  paidAt: new Date("2026-06-02T12:00:00Z"),
  dueDate: new Date("2026-06-15T00:00:00Z"),
  periodStart: new Date("2026-05-01T00:00:00Z"),
  periodEnd: new Date("2026-05-31T00:00:00Z"),
  createdAt: new Date("2026-05-20T00:00:00Z"),
  lineItems: [{
    description: "Hosted PBX",
    quantity: 1,
    unitPriceCents: 9900,
    amountCents: 9900,
    type: "SUBSCRIPTION",
  }],
  tenant: {
    name: "Test Tenant",
    billingSettings: {},
  },
};

test("generateInvoicePdf billed snapshot produces a distinct invoice PDF", async () => {
  const billed = await generateInvoicePdf(baseInvoice, { billedSnapshot: true });
  const paid = await generateInvoicePdf(baseInvoice);
  assert.ok(billed.length > 500);
  assert.ok(paid.length > 500);
  assert.notEqual(billed.compare(paid), 0);
});

test("generateReceiptPdf produces a distinct receipt PDF", async () => {
  const invoicePdf = await generateInvoicePdf(baseInvoice, { billedSnapshot: true });
  const receiptPdf = await generateReceiptPdf(baseInvoice, {
    transactionId: "tx_pdf_1",
    paymentAmountCents: 9900,
    paymentDate: new Date("2026-06-02T12:00:00Z"),
    paymentMethod: "Visa ending 4242",
    processorReference: "REF999",
  });
  assert.ok(receiptPdf.length > 500);
  assert.notEqual(invoicePdf.compare(receiptPdf), 0);
});

test("renderBillingInvoicePdf documentType receipt differs from billed invoice snapshot", async () => {
  const invoicePdf = await renderBillingInvoicePdf(baseInvoice, { documentType: "invoice", billedSnapshot: true });
  const receiptPdf = await renderBillingInvoicePdf(baseInvoice, {
    documentType: "receipt",
    receipt: {
      transactionId: "tx_pdf_pair",
      paymentAmountCents: 9900,
      paymentDate: new Date("2026-06-02T12:00:00Z"),
      paymentMethod: "Visa ending 4242",
      processorReference: "REF999",
    },
  });
  assert.notEqual(invoicePdf.compare(receiptPdf), 0);
});

test("generateInvoicePdf without snapshot reflects current paid invoice state", async () => {
  const pdf = await generateInvoicePdf(baseInvoice);
  assert.ok(pdf.length > 500);
});
