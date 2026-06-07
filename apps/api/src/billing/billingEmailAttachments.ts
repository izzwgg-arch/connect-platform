import { db } from "@connect/db";
import { externalMethodLabel, type ExternalPaymentMethodType } from "./externalPayment";
import {
  generateInvoicePdf,
  generateReceiptPdf,
  type BillingReceiptPdfContext,
} from "./pdf";

const BILLING_PDF_EMAIL_TYPES = new Set([
  "BILLING_INVOICE_SENT",
  "BILLING_INVOICE_READY",
  "BILLING_AUTOPAY_REMINDER",
  "BILLING_RECEIPT",
]);

export type BillingEmailPdfAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

function safePdfBasename(value: string): string {
  return String(value || "document").replace(/[^\w.-]+/g, "_");
}

/** Parse portal invoice URL embedded in queued billing email bodies. */
export function extractBillingInvoiceIdFromEmailJob(job: {
  type: string;
  htmlBody?: string | null;
  textBody?: string | null;
}): string | null {
  if (!BILLING_PDF_EMAIL_TYPES.has(job.type)) return null;
  const hay = `${job.htmlBody || ""}\n${job.textBody || ""}`;
  const marker = hay.match(/connect-billing-invoice:([A-Za-z0-9_-]+)/);
  if (marker?.[1]) return marker[1];
  const portal = hay.match(/\/billing\/invoices\/([A-Za-z0-9_-]+)/);
  return portal?.[1] || null;
}

/** Parse payment transaction marker embedded in receipt email bodies. */
export function extractBillingTransactionIdFromEmailJob(job: {
  type: string;
  htmlBody?: string | null;
  textBody?: string | null;
}): string | null {
  if (job.type !== "BILLING_RECEIPT") return null;
  const hay = `${job.htmlBody || ""}\n${job.textBody || ""}`;
  const marker = hay.match(/connect-billing-transaction:([A-Za-z0-9_-]+)/);
  return marker?.[1] || null;
}

function paymentMethodLabelFromTransaction(transaction: any): string | null {
  if (!transaction) return null;
  const pm = transaction.paymentMethod;
  if (pm?.last4) return `${pm.brand || "Card"} ending ${pm.last4}`;
  if (transaction.externalMethod) {
    return externalMethodLabel(transaction.externalMethod as ExternalPaymentMethodType);
  }
  const raw = transaction.rawResponseSafeJson as Record<string, unknown> | null;
  const last4 = raw?.cardLast4 ? String(raw.cardLast4) : null;
  if (last4) return `${String(raw?.cardBrand || "Card")} ending ${last4}`;
  return null;
}

function buildReceiptPdfContext(invoice: any, transaction: any): BillingReceiptPdfContext {
  const paymentDate = transaction?.paymentDate
    ? new Date(transaction.paymentDate)
    : invoice.paidAt
      ? new Date(invoice.paidAt)
      : transaction?.createdAt
        ? new Date(transaction.createdAt)
        : new Date();
  return {
    transactionId: String(transaction?.id || "payment"),
    paymentAmountCents: Number(transaction?.amountCents ?? invoice.totalCents ?? 0),
    paymentDate,
    paymentMethod: paymentMethodLabelFromTransaction(transaction),
    processorReference: transaction?.processorTransactionId
      ? String(transaction.processorTransactionId)
      : transaction?.externalReference
        ? String(transaction.externalReference)
        : null,
  };
}

async function loadBillingInvoiceRecord(tenantId: string, invoiceId: string): Promise<any | null> {
  return (db as any).billingInvoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: { lineItems: true, tenant: { include: { billingSettings: true } } },
  });
}

async function loadReceiptPaymentTransaction(
  tenantId: string,
  invoiceId: string,
  transactionId: string | null,
): Promise<any | null> {
  if (transactionId) {
    const tx = await (db as any).paymentTransaction.findFirst({
      where: { id: transactionId, tenantId, invoiceId, status: "APPROVED" },
      include: { paymentMethod: true },
    });
    if (tx) return tx;
  }
  return (db as any).paymentTransaction.findFirst({
    where: { tenantId, invoiceId, status: "APPROVED" },
    orderBy: { createdAt: "desc" },
    include: { paymentMethod: true },
  });
}

/** Generate PDF attachments for outbound billing emails. */
export async function loadBillingPdfAttachmentsForEmailJob(job: {
  tenantId: string;
  type: string;
  htmlBody?: string | null;
  textBody?: string | null;
}): Promise<BillingEmailPdfAttachment[]> {
  const invoiceId = extractBillingInvoiceIdFromEmailJob(job);
  if (!invoiceId) return [];

  const invoice = await loadBillingInvoiceRecord(job.tenantId, invoiceId);
  if (!invoice) return [];

  const invoiceBasename = safePdfBasename(invoice.invoiceNumber || invoice.id);

  if (job.type === "BILLING_RECEIPT") {
    const transactionId = extractBillingTransactionIdFromEmailJob(job);
    const transaction = await loadReceiptPaymentTransaction(job.tenantId, invoiceId, transactionId);
    const receiptContext = buildReceiptPdfContext(invoice, transaction);
    const receiptBasename = safePdfBasename(
      receiptContext.processorReference || receiptContext.transactionId || invoiceBasename,
    );
    const [invoiceContent, receiptContent] = await Promise.all([
      generateInvoicePdf(invoice, { billedSnapshot: true }),
      generateReceiptPdf(invoice, receiptContext),
    ]);
    return [
      {
        filename: `invoice-${invoiceBasename}.pdf`,
        content: invoiceContent,
        contentType: "application/pdf",
      },
      {
        filename: `receipt-${receiptBasename}.pdf`,
        content: receiptContent,
        contentType: "application/pdf",
      },
    ];
  }

  const content = await generateInvoicePdf(invoice);
  return [{
    filename: `invoice-${invoiceBasename}.pdf`,
    content,
    contentType: "application/pdf",
  }];
}

/** @deprecated Use loadBillingPdfAttachmentsForEmailJob — returns first attachment only. */
export async function loadBillingInvoicePdfAttachmentForEmailJob(job: {
  tenantId: string;
  type: string;
  htmlBody?: string | null;
  textBody?: string | null;
}): Promise<BillingEmailPdfAttachment | null> {
  const attachments = await loadBillingPdfAttachmentsForEmailJob(job);
  return attachments[0] ?? null;
}
