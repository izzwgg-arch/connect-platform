import test from "node:test";
import assert from "node:assert/strict";
import { generateInvoicePdf, generateReceiptPdf } from "./pdf";

process.env.CREDENTIALS_MASTER_KEY ||= "test-master-key-for-billing-pdf-tests";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Buffer }) => {
    getText(): Promise<{ text: string }>;
    destroy(): Promise<void>;
  };
};

const baseInvoice = {
  id: "inv_content_1",
  tenantId: "tenant_1",
  invoiceNumber: "CC-CONTENT-001",
  status: "PAID",
  totalCents: 12500,
  balanceDueCents: 0,
  amountPaidCents: 12500,
  paidAt: new Date("2026-06-02T12:00:00Z"),
  dueDate: new Date("2026-06-15T00:00:00Z"),
  periodStart: new Date("2026-05-01T00:00:00Z"),
  periodEnd: new Date("2026-05-31T00:00:00Z"),
  createdAt: new Date("2026-05-20T00:00:00Z"),
  lineItems: [{
    description: "Hosted PBX",
    quantity: 1,
    unitPriceCents: 12500,
    amountCents: 12500,
    type: "SUBSCRIPTION",
  }],
  tenant: {
    name: "Test Tenant",
    billingSettings: {},
  },
};

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result.text || "").replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

test("invoice PDF text contains INVOICE and original billed amount", async () => {
  const pdf = await generateInvoicePdf(baseInvoice, { billedSnapshot: true });
  const text = await pdfText(pdf);
  assert.match(text, /\bINVOICE\b/i);
  assert.doesNotMatch(text, /\bRECEIPT\b/i);
  assert.match(text, /CC-CONTENT-001/);
  assert.match(text, /\$125\.00/);
});

test("receipt PDF text contains RECEIPT, PAID, payment amount, and zero balance", async () => {
  const pdf = await generateReceiptPdf(baseInvoice, {
    transactionId: "tx_content_1",
    paymentAmountCents: 12500,
    paymentDate: new Date("2026-06-02T12:00:00Z"),
    paymentMethod: "Visa ending 4242",
    processorReference: "REF-CONTENT-999",
  });
  const text = await pdfText(pdf);
  assert.match(text, /\bRECEIPT\b/i);
  assert.match(text, /\bPAID\b/i);
  assert.match(text, /\$125\.00/);
  assert.match(text, /\$0\.00/);
  assert.match(text, /REF-CONTENT-999/);
});

test("receipt PDF is not a renamed invoice — document headers differ", async () => {
  const invoicePdf = await generateInvoicePdf(baseInvoice, { billedSnapshot: true });
  const receiptPdf = await generateReceiptPdf(baseInvoice, {
    transactionId: "tx_diff",
    paymentAmountCents: 12500,
    paymentDate: new Date("2026-06-02T12:00:00Z"),
    processorReference: "REF-DIFF",
  });
  const invoiceText = await pdfText(invoicePdf);
  const receiptText = await pdfText(receiptPdf);
  assert.match(invoiceText, /\bINVOICE\b/i);
  assert.match(receiptText, /\bRECEIPT\b/i);
  assert.notEqual(invoiceText.slice(0, 120), receiptText.slice(0, 120));
});
