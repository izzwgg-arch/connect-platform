import test, { mock } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, any>;

const sampleInvoice: Row = {
  id: "inv_1",
  tenantId: "tenant_1",
  invoiceNumber: "CC-2026-001",
  status: "PAID",
  totalCents: 12500,
  balanceDueCents: 0,
  amountPaidCents: 12500,
  paidAt: new Date("2026-06-02"),
  dueDate: new Date("2026-06-01"),
  periodStart: new Date("2026-05-01"),
  periodEnd: new Date("2026-05-31"),
  createdAt: new Date("2026-05-19"),
  lineItems: [{
    description: "Business voice plan",
    quantity: 1,
    unitPriceCents: 12500,
    amountCents: 12500,
    type: "SUBSCRIPTION",
  }],
  tenant: {
    name: "Acme Corp",
    billingSettings: { billingEmail: "billing@acme.com" },
  },
};

const sampleTransaction: Row = {
  id: "tx_approved_1",
  tenantId: "tenant_1",
  invoiceId: "inv_1",
  status: "APPROVED",
  amountCents: 12500,
  processorTransactionId: "REF123456",
  createdAt: new Date("2026-06-02"),
  paymentMethod: { brand: "Visa", last4: "4242" },
};

const db = {
  billingInvoice: {
    findFirst: async ({ where }: { where: Row }) => {
      if (where.id === sampleInvoice.id && where.tenantId === sampleInvoice.tenantId) return sampleInvoice;
      return null;
    },
  },
  paymentTransaction: {
    findFirst: async ({ where }: { where: Row }) => {
      if (where.id && where.id === sampleTransaction.id) return sampleTransaction;
      if (where.invoiceId === sampleInvoice.id && where.status === "APPROVED") return sampleTransaction;
      return null;
    },
  },
};

mock.module("@connect/db", { namedExports: { db } });

process.env.CREDENTIALS_MASTER_KEY ||= "test-master-key-for-billing-pdf-tests";

let attachmentsMod: typeof import("./billingEmailAttachments");
async function loadAttachmentsModule() {
  attachmentsMod ||= await import("./billingEmailAttachments");
  return attachmentsMod;
}

test("receipt email attachments include invoice and receipt PDFs with distinct filenames", async () => {
  const { loadBillingPdfAttachmentsForEmailJob } = await loadAttachmentsModule();
  const { billingInvoiceEmailMarker, billingPaymentTransactionMarker } = await import("./emailTemplates");
  const attachments = await loadBillingPdfAttachmentsForEmailJob({
    tenantId: "tenant_1",
    type: "BILLING_RECEIPT",
    htmlBody: `${billingInvoiceEmailMarker("inv_1")}${billingPaymentTransactionMarker("tx_approved_1")}`,
  });

  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].filename, "invoice-CC-2026-001.pdf");
  assert.equal(attachments[1].filename, "receipt-REF123456.pdf");
  assert.notEqual(attachments[0].filename, attachments[1].filename);
  assert.ok(attachments[0].content.length > 500);
  assert.ok(attachments[1].content.length > 500);
  assert.notEqual(attachments[0].content.compare(attachments[1].content), 0);
});

test("unpaid invoice email still sends only one invoice PDF attachment", async () => {
  const { loadBillingPdfAttachmentsForEmailJob } = await loadAttachmentsModule();
  const { billingInvoiceEmailMarker } = await import("./emailTemplates");
  const attachments = await loadBillingPdfAttachmentsForEmailJob({
    tenantId: "tenant_1",
    type: "BILLING_INVOICE_SENT",
    htmlBody: billingInvoiceEmailMarker("inv_1"),
  });

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, "invoice-CC-2026-001.pdf");
  assert.ok(attachments[0].content.length > 500);
});

test("payment failure email type sends no PDF attachments", async () => {
  const { loadBillingPdfAttachmentsForEmailJob } = await loadAttachmentsModule();
  const { billingInvoiceEmailMarker } = await import("./emailTemplates");
  const attachments = await loadBillingPdfAttachmentsForEmailJob({
    tenantId: "tenant_1",
    type: "BILLING_PAYMENT_FAILED",
    htmlBody: billingInvoiceEmailMarker("inv_1"),
  });
  assert.equal(attachments.length, 0);
});

test("autopay reminder email sends exactly one invoice PDF attachment", async () => {
  const { loadBillingPdfAttachmentsForEmailJob } = await loadAttachmentsModule();
  const { billingInvoiceEmailMarker } = await import("./emailTemplates");
  const attachments = await loadBillingPdfAttachmentsForEmailJob({
    tenantId: "tenant_1",
    type: "BILLING_AUTOPAY_REMINDER",
    htmlBody: billingInvoiceEmailMarker("inv_1"),
  });
  assert.equal(attachments.length, 1);
  assert.match(attachments[0].filename, /^invoice-/);
});
