import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import type { PdfBranding } from '@/lib/branding/pdf'
import {
  buildInvoicePdfHtml,
  buildEstimatePdfHtml,
  buildPurchaseOrderPdfHtml,
  buildCreditMemoPdfHtml,
  type PurchaseOrderPdfBranding,
} from '@/lib/documents/pdf-templates'

type AnyRecord = Record<string, any>

export interface PdfEmailAttachment {
  filename: string
  content: Buffer
  contentType: 'application/pdf'
}

function safeFilenamePart(value: unknown, fallback: string) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

/**
 * Renders the EXACT same Invoice PDF that the authenticated download route
 * produces, for attaching to invoice emails.
 */
export async function renderInvoiceEmailPdfAttachment(
  invoice: AnyRecord,
  brand: PdfBranding,
  view: 'customer' | 'company' = 'customer'
): Promise<PdfEmailAttachment> {
  const viewSuffix = view === 'company' ? '-company' : '-customer'
  return {
    filename: `Invoice-${safeFilenamePart(invoice.invoiceNumber, 'invoice')}${viewSuffix}.pdf`,
    content: await renderPdfFromHtml(buildInvoicePdfHtml(invoice, brand, { view })),
    contentType: 'application/pdf',
  }
}

/**
 * Renders the EXACT same Estimate PDF that the authenticated download route
 * produces, for attaching to estimate emails.
 */
export async function renderEstimateEmailPdfAttachment(
  estimate: AnyRecord,
  brand: PdfBranding,
  approvedOptionalItemIds: Set<string> = new Set(),
  view: 'customer' | 'company' = 'customer'
): Promise<PdfEmailAttachment> {
  const viewSuffix = view === 'company' ? '-company' : '-customer'
  return {
    filename: `Estimate-${safeFilenamePart(estimate.estimateNumber, 'estimate')}${viewSuffix}.pdf`,
    content: await renderPdfFromHtml(
      buildEstimatePdfHtml(estimate, brand, approvedOptionalItemIds, { view })
    ),
    contentType: 'application/pdf',
  }
}

export async function renderPurchaseOrderEmailPdfAttachment(
  purchaseOrder: AnyRecord,
  branding: PurchaseOrderPdfBranding
): Promise<PdfEmailAttachment> {
  return {
    filename: `PO-${safeFilenamePart(purchaseOrder.poNumber, 'purchase-order')}.pdf`,
    content: await renderPdfFromHtml(buildPurchaseOrderPdfHtml(purchaseOrder, branding)),
    contentType: 'application/pdf',
  }
}

export async function renderCreditMemoEmailPdfAttachment(
  creditMemo: AnyRecord,
  brand: PdfBranding
): Promise<PdfEmailAttachment> {
  return {
    filename: `CreditMemo-${safeFilenamePart(creditMemo.creditMemoNumber, 'credit-memo')}.pdf`,
    content: await renderPdfFromHtml(buildCreditMemoPdfHtml(creditMemo, brand)),
    contentType: 'application/pdf',
  }
}
