import { db } from "@connect/db";
import { renderBillingInvoicePdf } from "./pdf";

const BILLING_PDF_EMAIL_TYPES = new Set([
  "BILLING_INVOICE_SENT",
  "BILLING_INVOICE_READY",
  "BILLING_RECEIPT",
]);

export type BillingEmailPdfAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

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

/** Generate invoice PDF bytes for outbound billing emails (invoice + receipt). */
export async function loadBillingInvoicePdfAttachmentForEmailJob(job: {
  tenantId: string;
  type: string;
  htmlBody?: string | null;
  textBody?: string | null;
}): Promise<BillingEmailPdfAttachment | null> {
  const invoiceId = extractBillingInvoiceIdFromEmailJob(job);
  if (!invoiceId) return null;

  const invoice = await (db as any).billingInvoice.findFirst({
    where: { id: invoiceId, tenantId: job.tenantId },
    include: { lineItems: true, tenant: { include: { billingSettings: true } } },
  });
  if (!invoice) return null;

  const content = await renderBillingInvoicePdf(invoice);
  const filename = `Invoice-${String(invoice.invoiceNumber || invoice.id).replace(/[^\w.-]+/g, "_")}.pdf`;
  return { filename, content, contentType: "application/pdf" };
}
