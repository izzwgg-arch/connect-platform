/**
 * Single source of truth for the customer-facing Invoice and Estimate PDF HTML.
 *
 * Both the authenticated PDF download routes AND the email-attachment renderer
 * use these builders, so the PDF a customer downloads is byte-for-byte the same
 * document that gets attached to invoice/estimate emails.
 */
import {
  calculateOrderedSubtotalRows,
  mergeApprovedOptionalItemsForSubtotals,
} from '@/lib/documents/subtotals'
import type { PdfBranding } from '@/lib/branding/pdf'
import { prepareEstimateForPdfView } from '@/lib/estimates/estimate-pdf-view'
import { prepareInvoiceForPdfView } from '@/lib/invoices/invoice-pdf-view'

type AnyRecord = Record<string, any>

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeHtmlMultiline(value: unknown) {
  return escapeHtml(value).replace(/\r?\n/g, '<br/>')
}

function formatAddress(address: {
  street?: string
  city?: string
  state?: string
  zipCode?: string
} | null | undefined): string | null {
  if (!address) return null
  const parts = [address.street, address.city, `${address.state || ''} ${address.zipCode || ''}`]
    .map((p) => (p || '').trim())
    .filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

const SHARED_DOC_CSS = (accentColor: string, accentTextColor: string) => `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px;
    font-family: Inter, Helvetica, Arial, sans-serif;
    color: #111827;
    background: #f8fafc;
  }
  .page {
    max-width: 980px;
    margin: 0 auto;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    padding: 28px;
  }
  .header {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 20px;
    align-items: start;
    margin-bottom: 24px;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo-image {
    height: 56px;
    width: auto;
    max-width: 300px;
    object-fit: contain;
    display: block;
  }
  .logo-fallback {
    height: 56px;
    min-width: 160px;
    border-radius: 10px;
    background: ${accentColor};
    color: ${accentTextColor};
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0.02em;
    padding: 0 18px;
  }
  .doc-title {
    margin: 12px 0 0;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .muted { color: #6b7280; font-size: 12px; }
  .meta {
    text-align: right;
    font-size: 13px;
    color: #374151;
    line-height: 1.7;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 22px;
  }
  .panel {
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 14px;
    background: #ffffff;
  }
  .panel h3 {
    margin: 0 0 8px;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #6b7280;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    overflow: hidden;
  }
  th, td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  td { white-space: pre-wrap; word-break: break-word; }
  th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    background: #f8fafc;
  }
  tbody tr:nth-child(even) { background: #f9fafb; }
  /* Numeric columns (qty/price/total) must never wrap — a long stacked
     description in an adjacent cell can otherwise squeeze them narrow enough
     that word-break above splits a dollar amount mid-number across lines. */
  td.text-right, th.text-right { text-align: right; white-space: nowrap; }
  .summary {
    margin-top: 16px;
    margin-left: auto;
    width: 320px;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 14px;
  }
  .summary h4 {
    margin: 0 0 10px;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #6b7280;
  }
  .summary-row {
    display: flex;
    justify-content: space-between;
    padding: 5px 0;
    font-size: 14px;
  }
  .summary-row.total {
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid #cbd5e1;
    font-size: 18px;
    font-weight: 700;
  }
  .notes {
    white-space: pre-wrap;
    background: #f8fafc;
    border: 1px solid #e5e7eb;
    padding: 12px;
    border-radius: 10px;
    line-height: 1.5;
    margin-top: 20px;
  }
  .address-block {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  .section { margin-top: 20px; }
  @media print {
    body { background: #fff; padding: 0; }
    .page { border: none; border-radius: 0; }
  }
`

function logoBlock(brand: PdfBranding, alt: string) {
  return brand.logoUrl
    ? `<img class="logo-image" src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(alt)}" />`
    : `<div class="logo-fallback">trimpro</div>`
}

export interface InvoicePdfBuildOptions {
  shouldPrint?: boolean
  /** customer (default) = bundled Line # view; company = detailed line items */
  view?: 'customer' | 'company'
}

/**
 * Build the authoritative Invoice PDF HTML. Expects a Prisma invoice that
 * includes: client (+primary contacts), lineItems (with group when using customer view),
 * optionalItems, job (+job_site addresses), estimate (jobSiteAddress).
 */
export function buildInvoicePdfHtml(
  invoice: AnyRecord,
  brand: PdfBranding,
  options: InvoicePdfBuildOptions = {}
): string {
  const { shouldPrint = false, view = 'customer' } = options
  const preparedInvoice = prepareInvoiceForPdfView(invoice, view)
  const accentColor = brand.accentColor
  const accentTextColor = brand.accentTextColor

  const lineItems = Array.isArray(preparedInvoice.lineItems) ? preparedInvoice.lineItems : []
  const optionalItems = Array.isArray(preparedInvoice.optionalItems) ? preparedInvoice.optionalItems : []

  const visibleRegularItems = calculateOrderedSubtotalRows(
    lineItems.filter((item: AnyRecord) => item.isVisibleToClient !== false) as any[]
  )
  const visibleOptionalItems = optionalItems.filter((item: AnyRecord) => item.isVisibleToClient !== false)
  // Merge optional items into the main items — all items on an invoice are being billed
  const visibleLineItems = [...visibleRegularItems, ...visibleOptionalItems]
  const subtotal = visibleLineItems.reduce((sum: number, item: AnyRecord) => {
    if (item.isSubtotal) return sum
    return sum + Number(item.quantity) * Number(item.unitPrice)
  }, 0)

  const showNameCol =
    visibleLineItems.some((li: AnyRecord) => li.showDescriptionToCustomer !== false) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showDescriptionToCustomer !== false)
  const showNotesCol =
    visibleLineItems.some((li: AnyRecord) => li.showNotesToCustomer !== false) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showNotesToCustomer !== false)
  const showCostCol =
    visibleLineItems.some((li: AnyRecord) => li.showCostToCustomer === true) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showCostToCustomer === true)
  const showPriceCol =
    visibleLineItems.some((li: AnyRecord) => li.showPriceToCustomer !== false) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showPriceToCustomer !== false)

  const buildRow = (item: AnyRecord) => {
    if (item.isSubtotal) {
      const colSpan = (showNameCol ? 1 : 0) + (showNotesCol ? 1 : 0) + 1 + (showCostCol ? 1 : 0) + (showPriceCol ? 1 : 0)
      return `<tr style="background:#f8fafc;font-weight:700;">
        <td colspan="${colSpan}" style="text-align:right">Subtotal</td>
        <td class="text-right">$${Number(item.calculatedSubtotalTotal).toFixed(2)}</td>
      </tr>`
    }
    const nameCell = item.showDescriptionToCustomer !== false ? escapeHtmlMultiline(item.description) : ''
    const notesCell = item.showNotesToCustomer !== false ? escapeHtmlMultiline(item.notes || '') : ''
    const costCell = item.showCostToCustomer === true ? `$${Number(item.unitCost || 0).toFixed(2)}` : ''
    const priceCell = item.showPriceToCustomer !== false ? `$${Number(item.unitPrice).toFixed(2)}` : ''
    return `<tr>
      ${showNameCol ? `<td>${nameCell}</td>` : ''}
      ${showNotesCol ? `<td>${notesCell}</td>` : ''}
      <td class="text-right">${Number(item.quantity).toFixed(2)}</td>
      ${showCostCol ? `<td class="text-right">${costCell}</td>` : ''}
      ${showPriceCol ? `<td class="text-right">${priceCell}</td>` : ''}
      <td class="text-right">$${Number(item.total).toFixed(2)}</td>
    </tr>`
  }

  const tableHeader = `<tr>
    ${showNameCol ? '<th>Item</th>' : ''}
    ${showNotesCol ? '<th>Description</th>' : ''}
    <th class="text-right">Qty</th>
    ${showCostCol ? '<th class="text-right">Cost</th>' : ''}
    ${showPriceCol ? '<th class="text-right">Unit Price</th>' : ''}
    <th class="text-right">Total</th>
  </tr>`

  const discount = Number(preparedInvoice.discount || 0)
  const tax = Number(preparedInvoice.taxAmount || 0)
  const optItemsSubtotal = visibleOptionalItems.reduce(
    (sum: number, item: AnyRecord) => sum + Number(item.quantity) * Number(item.unitPrice),
    0
  )
  const total = Number(preparedInvoice.total || 0) + optItemsSubtotal
  const balance = Number(preparedInvoice.balance || 0) + optItemsSubtotal
  const paid = Number(preparedInvoice.paidAmount || 0)
  const showNotes = preparedInvoice.isNotesVisibleToClient !== false && Boolean(preparedInvoice.notes)
  const generatedAt = new Date().toLocaleString()
  const invoiceDate = preparedInvoice.invoiceDate
    ? new Date(preparedInvoice.invoiceDate).toLocaleDateString()
    : new Date().toLocaleDateString()
  const dueDate = preparedInvoice.dueDate ? new Date(preparedInvoice.dueDate).toLocaleDateString() : 'N/A'
  const clientName = preparedInvoice.client?.companyName || preparedInvoice.client?.name || 'N/A'
  const primaryContact = preparedInvoice.client?.contacts?.[0] || null
  const jobSiteAddress =
    formatAddress(preparedInvoice.job?.addresses?.[0]) ||
    (preparedInvoice.estimate?.jobSiteAddress ? String(preparedInvoice.estimate.jobSiteAddress) : null)

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Invoice ${escapeHtml(preparedInvoice.invoiceNumber)}</title>
        <style>${SHARED_DOC_CSS(accentColor, accentTextColor)}</style>
        ${shouldPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">
                ${logoBlock(brand, 'Trim Pro Logo')}
              </div>
              <h1 class="doc-title">Invoice</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              ${brand.businessPhone ? `<div>${escapeHtml(brand.businessPhone)}</div>` : ''}
              ${brand.businessEmail ? `<div>${escapeHtml(brand.businessEmail)}</div>` : ''}
              ${brand.businessAddress ? `<div>${escapeHtml(brand.businessAddress)}</div>` : ''}
              <div style="margin-top:8px;"><strong>No.</strong> ${escapeHtml(preparedInvoice.invoiceNumber)}</div>
              <div><strong>Invoice Date:</strong> ${escapeHtml(invoiceDate)}</div>
              <div><strong>Due Date:</strong> ${escapeHtml(dueDate)}</div>
              <div><strong>Status:</strong> ${escapeHtml(preparedInvoice.status)}</div>
            </div>
          </div>

          <div class="grid">
            <div class="panel">
              <h3>Billed To</h3>
              <div>${escapeHtml(clientName)}</div>
              ${preparedInvoice.client?.email ? `<div class="muted">${escapeHtml(preparedInvoice.client.email)}</div>` : ''}
              ${primaryContact?.email ? `<div class="muted">${escapeHtml(primaryContact.email)}</div>` : ''}
              ${primaryContact?.phone ? `<div class="muted">${escapeHtml(primaryContact.phone)}</div>` : ''}
              ${jobSiteAddress ? `<div class="muted" style="margin-top:10px;font-weight:600;">Job Site Address</div><div class="address-block">${escapeHtmlMultiline(jobSiteAddress)}</div>` : ''}
            </div>
            <div class="panel">
              <h3>Document Details</h3>
              <div class="muted">Reference</div>
              <div>${escapeHtml(preparedInvoice.title || preparedInvoice.invoiceNumber)}</div>
              ${
                preparedInvoice.job
                  ? `<div class="muted" style="margin-top:8px;">Job</div><div>${escapeHtml(preparedInvoice.job.jobNumber)} - ${escapeHtml(preparedInvoice.job.title)}</div>`
                  : ''
              }
            </div>
          </div>

          <table>
            <thead>${tableHeader}</thead>
            <tbody>
              ${visibleLineItems.length === 0
                ? `<tr><td colspan="6" class="muted">No visible items</td></tr>`
                : visibleLineItems.map(buildRow).join('')}
            </tbody>
          </table>

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
            <div class="summary-row"><span>Discount</span><span>-$${discount.toFixed(2)}</span></div>
            <div class="summary-row"><span>Tax</span><span>$${tax.toFixed(2)}</span></div>
            <div class="summary-row"><span>Paid</span><span>$${paid.toFixed(2)}</span></div>
            <div class="summary-row total"><span>Balance Due</span><span>$${balance.toFixed(2)}</span></div>
          </div>

          ${showNotes ? `<div class="notes">${escapeHtml(preparedInvoice.notes)}</div>` : ''}

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}

        </div>
      </body>
    </html>
  `
}

export interface EstimatePdfBuildOptions {
  shouldPrint?: boolean
  /** customer (default) = bundled Line # view; company = detailed line items */
  view?: 'customer' | 'company'
}

/**
 * Build the authoritative Estimate PDF HTML. Expects a Prisma estimate that
 * includes: client, lineItems (with group when using customer view), optionalItems.
 * `approvedOptionalItemIds` controls which optional items have been approved
 * (merged into the main table).
 */
export function buildEstimatePdfHtml(
  estimate: AnyRecord,
  brand: PdfBranding,
  approvedOptionalItemIds: Set<string> = new Set(),
  options: EstimatePdfBuildOptions = {}
): string {
  const { shouldPrint = false, view = 'customer' } = options
  const preparedEstimate = prepareEstimateForPdfView(estimate, view)
  const accentColor = brand.accentColor
  const accentTextColor = brand.accentTextColor

  const lineItems = Array.isArray(preparedEstimate.lineItems) ? preparedEstimate.lineItems : []
  const optionalItems = Array.isArray(preparedEstimate.optionalItems) ? preparedEstimate.optionalItems : []

  const visibleRegularItems = lineItems.filter((item: AnyRecord) => item.isVisibleToClient !== false)
  const allVisibleOptionalItems = optionalItems.filter((item: AnyRecord) => item.isVisibleToClient !== false)
  const approvedOptionalItems = allVisibleOptionalItems.filter((li: AnyRecord) => approvedOptionalItemIds.has(li.id))
  const pendingOptionalItems = allVisibleOptionalItems.filter((li: AnyRecord) => !approvedOptionalItemIds.has(li.id))
  const visibleItems = calculateOrderedSubtotalRows(
    mergeApprovedOptionalItemsForSubtotals(visibleRegularItems as any[], approvedOptionalItems as any[])
  )
  const visibleOptionalItems = pendingOptionalItems

  const regularSubtotal = visibleRegularItems.reduce(
    (sum: number, item: AnyRecord) => sum + Number(item.quantity) * Number(item.unitPrice),
    0
  )
  const approvedOptionalSubtotal = approvedOptionalItems.reduce(
    (sum: number, item: AnyRecord) => sum + Number(item.quantity) * Number(item.unitPrice),
    0
  )
  const subtotal = regularSubtotal + approvedOptionalSubtotal
  const optionalSubtotal = pendingOptionalItems.reduce(
    (sum: number, item: AnyRecord) => sum + Number(item.quantity) * Number(item.unitPrice),
    0
  )

  const showNameCol =
    visibleItems.some((li: AnyRecord) => li.showDescriptionToCustomer !== false) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showDescriptionToCustomer !== false)
  const showNotesCol =
    visibleItems.some((li: AnyRecord) => li.showNotesToCustomer !== false) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showNotesToCustomer !== false)
  const showCostCol =
    visibleItems.some((li: AnyRecord) => li.showCostToCustomer === true) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showCostToCustomer === true)
  const showPriceCol =
    visibleItems.some((li: AnyRecord) => li.showPriceToCustomer !== false) ||
    visibleOptionalItems.some((li: AnyRecord) => li.showPriceToCustomer !== false)

  const buildRow = (item: AnyRecord) => {
    if (item.isSubtotal) {
      const colSpan = (showNameCol ? 1 : 0) + (showNotesCol ? 1 : 0) + 1 + (showCostCol ? 1 : 0) + (showPriceCol ? 1 : 0)
      return `<tr style="background:#f8fafc;font-weight:700;">
        <td colspan="${colSpan}" style="text-align:right">Subtotal</td>
        <td class="text-right">$${Number(item.calculatedSubtotalTotal).toFixed(2)}</td>
      </tr>`
    }
    const nameCell = item.showDescriptionToCustomer !== false ? escapeHtmlMultiline(item.description) : ''
    const notesCell = item.showNotesToCustomer !== false ? escapeHtmlMultiline(item.notes || '') : ''
    const costCell = item.showCostToCustomer === true ? `$${Number(item.unitCost || 0).toFixed(2)}` : ''
    const priceCell = item.showPriceToCustomer !== false ? `$${Number(item.unitPrice).toFixed(2)}` : ''
    return `<tr>
      ${showNameCol ? `<td>${nameCell}</td>` : ''}
      ${showNotesCol ? `<td>${notesCell}</td>` : ''}
      <td class="text-right">${Number(item.quantity).toFixed(2)}</td>
      ${showCostCol ? `<td class="text-right">${costCell}</td>` : ''}
      ${showPriceCol ? `<td class="text-right">${priceCell}</td>` : ''}
      <td class="text-right">$${Number(item.total).toFixed(2)}</td>
    </tr>`
  }

  const tableHeader = `<tr>
    ${showNameCol ? '<th>Item</th>' : ''}
    ${showNotesCol ? '<th>Description</th>' : ''}
    <th class="text-right">Qty</th>
    ${showCostCol ? '<th class="text-right">Cost</th>' : ''}
    ${showPriceCol ? '<th class="text-right">Unit Price</th>' : ''}
    <th class="text-right">Total</th>
  </tr>`

  const discount = Number(preparedEstimate.discount || 0)
  const taxRate = Number(preparedEstimate.taxRate || 0)
  const subtotalAfterDiscount = subtotal - discount
  const tax = subtotalAfterDiscount * taxRate
  const total = subtotalAfterDiscount + tax

  const showNotes = preparedEstimate.isNotesVisibleToClient !== false && Boolean(preparedEstimate.notes)
  const generatedAt = new Date().toLocaleString()
  const clientName = preparedEstimate.client?.companyName || preparedEstimate.client?.name || 'N/A'
  const validUntil = preparedEstimate.validUntil ? new Date(preparedEstimate.validUntil).toLocaleDateString() : 'N/A'
  const estimateDate = new Date(preparedEstimate.createdAt).toLocaleDateString()

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Estimate ${escapeHtml(estimate.estimateNumber)}</title>
        <style>${SHARED_DOC_CSS(accentColor, accentTextColor)}</style>
        ${shouldPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">
                ${logoBlock(brand, 'Trim Pro Logo')}
              </div>
              <h1 class="doc-title">Estimate</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              ${brand.businessPhone ? `<div>${escapeHtml(brand.businessPhone)}</div>` : ''}
              ${brand.businessEmail ? `<div>${escapeHtml(brand.businessEmail)}</div>` : ''}
              ${brand.businessAddress ? `<div>${escapeHtml(brand.businessAddress)}</div>` : ''}
              <div style="margin-top:8px;"><strong>No.</strong> ${escapeHtml(estimate.estimateNumber)}</div>
              <div><strong>Status:</strong> ${escapeHtml(estimate.status)}</div>
              <div><strong>Valid Until:</strong> ${escapeHtml(validUntil)}</div>
            </div>
          </div>

          <div class="grid">
            <div class="panel">
              <h3>Prepared For</h3>
              <div>${escapeHtml(clientName)}</div>
              ${estimate.client?.email ? `<div class="muted">${escapeHtml(estimate.client.email)}</div>` : ''}
              ${estimate.client?.phone ? `<div class="muted">${escapeHtml(estimate.client.phone)}</div>` : ''}
              ${estimate.jobSiteAddress ? `<div class="muted" style="margin-top:10px;font-weight:600;">Job Address</div><div>${escapeHtml(String(estimate.jobSiteAddress))}</div>` : ''}
            </div>
            <div class="panel">
              <h3>Document Details</h3>
              <div class="muted">Estimate Date</div>
              <div>${estimateDate}</div>
              <div class="muted" style="margin-top:8px;">Reference</div>
              <div>${escapeHtml(estimate.title || estimate.estimateNumber)}</div>
            </div>
          </div>

          <table>
            <thead>${tableHeader}</thead>
            <tbody>
              ${
                visibleItems.length === 0
                  ? `<tr><td colspan="6" class="muted">No visible items</td></tr>`
                  : visibleItems.map(buildRow).join('')
              }
            </tbody>
          </table>

          ${
            visibleOptionalItems.length > 0
              ? `
                <div class="section">
                  <h3>Optional Items</h3>
                  <table>
                    <thead>${tableHeader}</thead>
                    <tbody>
                      ${visibleOptionalItems.map(buildRow).join('')}
                    </tbody>
                  </table>
                  <div class="summary" style="margin-top:12px; width: 320px;">
                    <h4>Optional Subtotal</h4>
                    <div class="summary-row total"><span>Optional Items</span><span>$${optionalSubtotal.toFixed(2)}</span></div>
                  </div>
                </div>
              `
              : ''
          }

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
            <div class="summary-row"><span>Discount</span><span>-$${discount.toFixed(2)}</span></div>
            <div class="summary-row"><span>Tax</span><span>$${tax.toFixed(2)}</span></div>
            <div class="summary-row total"><span>Total</span><span>$${total.toFixed(2)}</span></div>
          </div>

          ${showNotes ? `
            <div class="section">
              <h3>Notes</h3>
              <div class="notes">${escapeHtml(estimate.notes || '')}</div>
            </div>
          ` : ''}

          ${estimate.terms ? `
            <div class="section">
              <h3>Terms &amp; Conditions</h3>
              <div class="notes">${escapeHtml(estimate.terms)}</div>
            </div>
          ` : ''}

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}
        </div>
      </body>
    </html>
  `
}

export interface PurchaseOrderPdfBranding {
  logoUrl: string | null
  businessName?: string | null
}

export interface PurchaseOrderPdfBuildOptions {
  shouldPrint?: boolean
}

export function buildPurchaseOrderPdfHtml(
  purchaseOrder: AnyRecord,
  branding: PurchaseOrderPdfBranding,
  options: PurchaseOrderPdfBuildOptions = {}
): string {
  const { shouldPrint = false } = options
  const lineItems = Array.isArray(purchaseOrder.lineItems) ? purchaseOrder.lineItems : []
  const visibleLineItems = lineItems.filter((item: AnyRecord) => item.isVisibleToClient !== false)
  const subtotal = visibleLineItems.reduce((sum: number, item: AnyRecord) => {
    if (item.isNote) return sum
    return sum + Number(item.quantity) * Number(item.unitPrice)
  }, 0)
  const total = Number(purchaseOrder.total || 0)
  const generatedAt = new Date().toLocaleString()
  const orderDate = purchaseOrder.orderDate
    ? new Date(purchaseOrder.orderDate).toLocaleDateString()
    : new Date().toLocaleDateString()
  const expectedDate = purchaseOrder.expectedDate
    ? new Date(purchaseOrder.expectedDate).toLocaleDateString()
    : 'N/A'
  const jobSiteAddress = formatAddress(purchaseOrder.job?.addresses?.[0] || null)
  const deliveryAddress =
    String(purchaseOrder.deliveryAddress || '').trim() || jobSiteAddress || ''
  const vendorNotes = String(purchaseOrder.notes || '').trim()

  const showItemCol = visibleLineItems.some((li: AnyRecord) => li.showDescriptionToCustomer !== false)
  const showDetailsCol = visibleLineItems.some((li: AnyRecord) => li.showDetailsToCustomer !== false)
  const showNotesCol = visibleLineItems.some((li: AnyRecord) => li.showNotesToCustomer !== false)
  const showPriceCol = visibleLineItems.some((li: AnyRecord) => li.showPriceToCustomer !== false)

  const poColCount =
    (showItemCol ? 1 : 0) +
    (showDetailsCol ? 1 : 0) +
    (showNotesCol ? 1 : 0) +
    1 /* quantity */ +
    (showPriceCol ? 2 : 0)

  const buildPoRow = (item: AnyRecord) => {
    if (item.isNote) {
      return `<tr>
        <td colspan="${poColCount}" style="font-style:italic;color:#4b5563;background:#f9fafb;">${escapeHtmlMultiline(item.description || '')}</td>
      </tr>`
    }
    const itemCell =
      item.showDescriptionToCustomer !== false ? escapeHtmlMultiline(item.description) : ''
    const detailsCell =
      item.showDetailsToCustomer !== false ? escapeHtmlMultiline(item.details || '') : ''
    const notesCell =
      item.showNotesToCustomer !== false ? escapeHtmlMultiline(item.notes || '') : ''
    const priceCell =
      item.showPriceToCustomer !== false ? `$${Number(item.unitPrice).toFixed(2)}` : ''
    const totalCell =
      item.showPriceToCustomer !== false ? `$${Number(item.total).toFixed(2)}` : ''
    return `<tr>
      ${showItemCol ? `<td>${itemCell}</td>` : ''}
      ${showDetailsCol ? `<td>${detailsCell}</td>` : ''}
      ${showNotesCol ? `<td>${notesCell}</td>` : ''}
      <td class="text-right">${Number(item.quantity).toFixed(2)}</td>
      ${showPriceCol ? `<td class="text-right">${priceCell}</td>` : ''}
      ${showPriceCol ? `<td class="text-right">${totalCell}</td>` : ''}
    </tr>`
  }

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Purchase Order ${escapeHtml(purchaseOrder.poNumber)}</title>
        <style>${SHARED_DOC_CSS('#12344d', '#f5e7b8')}
          .po-info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 16px;
            align-items: stretch;
          }
          .po-info-grid .panel {
            min-height: 100%;
          }
          .po-notes-panel {
            margin-bottom: 22px;
          }
          .footer {
            margin-top: 22px;
            padding-top: 12px;
            border-top: 1px solid #e5e7eb;
            font-size: 12px;
            color: #6b7280;
          }
          @media print {
            .po-info-grid { grid-template-columns: 1fr 1fr; }
          }
        </style>
        ${shouldPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">
                ${
                  branding.logoUrl
                    ? `<img class="logo-image" src="${escapeHtml(branding.logoUrl)}" alt="Trim Pro Logo" />`
                    : '<div class="logo-fallback">trimpro</div>'
                }
              </div>
              <h1 class="doc-title">Purchase Order</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              ${branding.businessName ? `<div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(branding.businessName)}</div>` : ''}
              <div><strong>No.</strong> ${escapeHtml(purchaseOrder.poNumber)}</div>
              <div><strong>Order Date:</strong> ${escapeHtml(orderDate)}</div>
              <div><strong>Expected:</strong> ${escapeHtml(expectedDate)}</div>
            </div>
          </div>

          <div class="po-info-grid">
            <div class="panel">
              <h3>Vendor</h3>
              <div><strong>${escapeHtml(purchaseOrder.vendorRef?.name || purchaseOrder.vendor || 'N/A')}</strong></div>
              ${purchaseOrder.vendorRef?.contactPerson ? `<div class="muted">Contact: ${escapeHtml(purchaseOrder.vendorRef.contactPerson)}</div>` : ''}
              ${purchaseOrder.vendorRef?.email ? `<div class="muted">${escapeHtml(purchaseOrder.vendorRef.email)}</div>` : ''}
              ${purchaseOrder.vendorRef?.phone ? `<div class="muted">${escapeHtml(purchaseOrder.vendorRef.phone)}</div>` : ''}
            </div>
            <div class="panel">
              <h3>Delivery Address</h3>
              ${
                deliveryAddress
                  ? `<div class="address-block">${escapeHtmlMultiline(deliveryAddress)}</div>`
                  : '<div class="muted">No delivery address</div>'
              }
            </div>
          </div>
          <div class="panel po-notes-panel">
            <h3>Notes</h3>
            ${
              vendorNotes
                ? `<div style="white-space:pre-wrap;">${escapeHtml(vendorNotes)}</div>`
                : '<div class="muted">—</div>'
            }
          </div>

          <table>
            <thead>
              <tr>
                ${showItemCol ? '<th>Item</th>' : ''}
                ${showDetailsCol ? '<th>Description</th>' : ''}
                ${showNotesCol ? '<th>Special notes</th>' : ''}
                <th class="text-right">Quantity</th>
                ${showPriceCol ? '<th class="text-right">Unit Price</th>' : ''}
                ${showPriceCol ? '<th class="text-right">Total</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${visibleLineItems.map((item: AnyRecord) => buildPoRow(item)).join('')}
            </tbody>
          </table>

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
            <div class="summary-row total"><span>Total</span><span>$${total.toFixed(2)}</span></div>
          </div>

          <div class="footer">
            <p>This is an official purchase order from Trim Pro.</p>
            <p>Generated on ${generatedAt}</p>
          </div>
        </div>
      </body>
    </html>
  `
}

export function buildCreditMemoPdfHtml(
  creditMemo: AnyRecord,
  brand: PdfBranding,
  options: { shouldPrint?: boolean } = {}
): string {
  const { shouldPrint = false } = options
  const accentColor = brand.accentColor
  const accentTextColor = brand.accentTextColor
  const lineItems = Array.isArray(creditMemo.lineItems) ? creditMemo.lineItems : []
  const subtotal = lineItems.reduce(
    (sum: number, item: AnyRecord) => sum + Number(item.quantity) * Number(item.unitPrice),
    0
  )
  const tax = Number(creditMemo.taxAmount || 0)
  const total = Number(creditMemo.total || subtotal + tax)
  const applied = Number(creditMemo.appliedAmount || 0)
  const remaining = Number(creditMemo.remainingCredit || Math.max(0, total - applied))
  const generatedAt = new Date().toLocaleString()
  const memoDate = creditMemo.creditMemoDate
    ? new Date(creditMemo.creditMemoDate).toLocaleDateString()
    : new Date().toLocaleDateString()
  const clientName = creditMemo.client?.companyName || creditMemo.client?.name || 'N/A'

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Credit Memo ${escapeHtml(creditMemo.creditMemoNumber)}</title>
        <style>${SHARED_DOC_CSS(accentColor, accentTextColor)}</style>
        ${shouldPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">${logoBlock(brand, 'Trim Pro Logo')}</div>
              <h1 class="doc-title">Credit Memo</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              ${brand.businessName ? `<div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>` : ''}
              <div><strong>No.</strong> ${escapeHtml(creditMemo.creditMemoNumber)}</div>
              <div><strong>Date:</strong> ${escapeHtml(memoDate)}</div>
              <div><strong>Status:</strong> ${escapeHtml(creditMemo.status || '')}</div>
            </div>
          </div>

          <div class="grid">
            <div class="panel">
              <h3>Bill To</h3>
              <div><strong>${escapeHtml(clientName)}</strong></div>
              ${creditMemo.client?.email ? `<div class="muted">${escapeHtml(creditMemo.client.email)}</div>` : ''}
              ${creditMemo.client?.phone ? `<div class="muted">${escapeHtml(creditMemo.client.phone)}</div>` : ''}
            </div>
            <div class="panel">
              <h3>Details</h3>
              ${creditMemo.sourceInvoice?.invoiceNumber ? `<div><strong>Related Invoice:</strong> ${escapeHtml(creditMemo.sourceInvoice.invoiceNumber)}</div>` : ''}
              ${creditMemo.job ? `<div><strong>Job:</strong> ${escapeHtml(creditMemo.job.jobNumber)} — ${escapeHtml(creditMemo.job.title || '')}</div>` : ''}
              ${creditMemo.notes ? `<div style="margin-top:8px;white-space:pre-wrap;">${escapeHtml(creditMemo.notes)}</div>` : '<div class="muted">—</div>'}
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="text-right">Qty</th>
                <th class="text-right">Unit Price</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              ${lineItems
                .map(
                  (item: AnyRecord) => `<tr>
                <td>${escapeHtmlMultiline(item.description)}${item.notes ? `<div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtmlMultiline(item.notes)}</div>` : ''}</td>
                <td class="text-right">${Number(item.quantity).toFixed(2)}</td>
                <td class="text-right">$${Number(item.unitPrice).toFixed(2)}</td>
                <td class="text-right">$${Number(item.total).toFixed(2)}</td>
              </tr>`
                )
                .join('')}
            </tbody>
          </table>

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
            ${tax ? `<div class="summary-row"><span>Tax</span><span>$${tax.toFixed(2)}</span></div>` : ''}
            <div class="summary-row total"><span>Credit Total</span><span>$${total.toFixed(2)}</span></div>
            <div class="summary-row"><span>Applied</span><span>$${applied.toFixed(2)}</span></div>
            <div class="summary-row"><span>Remaining</span><span>$${remaining.toFixed(2)}</span></div>
          </div>

          <div class="footer">
            <p>This is an official credit memo from Trim Pro.</p>
            <p>Generated on ${generatedAt}</p>
          </div>
        </div>
      </body>
    </html>
  `
}

type StatementLedgerRow = {
  date: Date
  type: 'INVOICE' | 'PAYMENT' | 'CREDIT_MEMO'
  description: string
  reference: string
  debit: number
  credit: number
  balance: number
}

type StatementSummary = {
  totalInvoiced: number
  totalPaid: number
  totalCredited: number
  balance: number
  invoiceCount: number
}

export function buildCustomerStatementPdfHtml(
  data: {
    client: AnyRecord
    ledger: StatementLedgerRow[]
    summary: StatementSummary
    startDate: Date | null
    endDate: Date | null
  },
  brand: PdfBranding
): string {
  const { client, ledger, summary, startDate, endDate } = data
  const generatedAt = new Date().toLocaleString()
  const billingAddress = formatAddress(client.addresses?.[0] || null)
  const periodLabel =
    startDate || endDate
      ? `${startDate ? startDate.toLocaleDateString() : 'Start'} — ${endDate ? endDate.toLocaleDateString() : 'Today'}`
      : 'All time'

  const rowLabel: Record<StatementLedgerRow['type'], string> = {
    INVOICE: 'Invoice',
    PAYMENT: 'Payment',
    CREDIT_MEMO: 'Credit Memo',
  }

  const rows = ledger
    .map(
      (t) => `<tr>
        <td>${escapeHtml(t.date.toLocaleDateString())}</td>
        <td>${escapeHtml(rowLabel[t.type])}</td>
        <td>${escapeHtml(t.reference)}</td>
        <td>${escapeHtml(t.description)}</td>
        <td class="text-right">${t.debit ? `$${t.debit.toFixed(2)}` : ''}</td>
        <td class="text-right">${t.credit ? `$${t.credit.toFixed(2)}` : ''}</td>
        <td class="text-right" style="font-weight:600;">$${t.balance.toFixed(2)}</td>
      </tr>`
    )
    .join('')

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Statement - ${escapeHtml(client.name)}</title>
        <style>${SHARED_DOC_CSS(brand.accentColor, brand.accentTextColor)}</style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">${logoBlock(brand, 'Trim Pro Logo')}</div>
              <h1 class="doc-title">Customer Statement</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              ${brand.businessPhone ? `<div>${escapeHtml(brand.businessPhone)}</div>` : ''}
              ${brand.businessEmail ? `<div>${escapeHtml(brand.businessEmail)}</div>` : ''}
              <div style="margin-top:8px;"><strong>Period:</strong> ${escapeHtml(periodLabel)}</div>
            </div>
          </div>

          <div class="grid">
            <div class="panel">
              <h3>Customer</h3>
              <div>${escapeHtml(client.companyName || client.name)}</div>
              ${client.email ? `<div class="muted">${escapeHtml(client.email)}</div>` : ''}
              ${client.phone ? `<div class="muted">${escapeHtml(client.phone)}</div>` : ''}
              ${billingAddress ? `<div class="address-block" style="margin-top:8px;">${escapeHtmlMultiline(billingAddress)}</div>` : ''}
            </div>
            <div class="panel">
              <h3>Account Summary</h3>
              <div class="muted">Invoices in period</div>
              <div>${summary.invoiceCount}</div>
              <div class="muted" style="margin-top:8px;">Total Invoiced</div>
              <div>$${summary.totalInvoiced.toFixed(2)}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Reference</th>
                <th>Description</th>
                <th class="text-right">Debit</th>
                <th class="text-right">Credit</th>
                <th class="text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              ${ledger.length === 0 ? `<tr><td colspan="7" class="muted">No transactions in this period</td></tr>` : rows}
            </tbody>
          </table>

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Total Invoiced</span><span>$${summary.totalInvoiced.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Paid</span><span>$${summary.totalPaid.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Credited</span><span>$${summary.totalCredited.toFixed(2)}</span></div>
            <div class="summary-row total"><span>Balance Due</span><span>$${summary.balance.toFixed(2)}</span></div>
          </div>

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}
        </div>
      </body>
    </html>
  `
}

const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const
type AgingBucket = (typeof AGING_BUCKETS)[number]
const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  current: 'Current',
  '1-30': '1-30 Days',
  '31-60': '31-60 Days',
  '61-90': '61-90 Days',
  '90+': '90+ Days',
}

export function buildAgingReportPdfHtml(
  data: {
    byClient: Array<{ clientId: string; clientName: string; buckets: Record<AgingBucket, number>; total: number }>
    bucketTotals: Record<AgingBucket, number>
    grandTotal: number
    asOf: Date
  },
  brand: PdfBranding
): string {
  const { byClient, bucketTotals, grandTotal, asOf } = data
  const generatedAt = new Date().toLocaleString()

  const rows = byClient
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.clientName)}</td>
        ${AGING_BUCKETS.map((b) => `<td class="text-right">${c.buckets[b] ? `$${c.buckets[b].toFixed(2)}` : ''}</td>`).join('')}
        <td class="text-right" style="font-weight:600;">$${c.total.toFixed(2)}</td>
      </tr>`
    )
    .join('')

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Accounts Receivable Aging</title>
        <style>${SHARED_DOC_CSS(brand.accentColor, brand.accentTextColor)}</style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">${logoBlock(brand, 'Trim Pro Logo')}</div>
              <h1 class="doc-title">Accounts Receivable Aging</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              <div><strong>As of:</strong> ${escapeHtml(asOf.toLocaleDateString())}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Customer</th>
                ${AGING_BUCKETS.map((b) => `<th class="text-right">${AGING_BUCKET_LABEL[b]}</th>`).join('')}
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              ${byClient.length === 0 ? `<tr><td colspan="${AGING_BUCKETS.length + 2}" class="muted">No outstanding balances</td></tr>` : rows}
            </tbody>
            <tfoot>
              <tr style="font-weight:700;background:#f8fafc;">
                <td>Total</td>
                ${AGING_BUCKETS.map((b) => `<td class="text-right">$${bucketTotals[b].toFixed(2)}</td>`).join('')}
                <td class="text-right">$${grandTotal.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}
        </div>
      </body>
    </html>
  `
}

export function buildRevenueReportPdfHtml(
  data: {
    rows: Array<{ month: string; invoiced: number; collected: number }>
    summary: { totalInvoiced: number; totalCollected: number; prevInvoiced: number; changePercent: number | null }
    startDate: Date
    endDate: Date
  },
  brand: PdfBranding
): string {
  const { rows, summary, startDate, endDate } = data
  const generatedAt = new Date().toLocaleString()

  const tableRows = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.month)}</td>
        <td class="text-right">$${r.invoiced.toFixed(2)}</td>
        <td class="text-right">$${r.collected.toFixed(2)}</td>
      </tr>`
    )
    .join('')

  const changeText =
    summary.changePercent === null
      ? 'N/A'
      : `${summary.changePercent >= 0 ? '+' : ''}${summary.changePercent.toFixed(1)}% vs previous period`

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Revenue Report</title>
        <style>${SHARED_DOC_CSS(brand.accentColor, brand.accentTextColor)}</style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">${logoBlock(brand, 'Trim Pro Logo')}</div>
              <h1 class="doc-title">Revenue by Month</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              <div><strong>Period:</strong> ${escapeHtml(startDate.toLocaleDateString())} — ${escapeHtml(endDate.toLocaleDateString())}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th class="text-right">Invoiced</th>
                <th class="text-right">Collected</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0 ? `<tr><td colspan="3" class="muted">No revenue in this period</td></tr>` : tableRows}
            </tbody>
          </table>

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Total Invoiced</span><span>$${summary.totalInvoiced.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Collected</span><span>$${summary.totalCollected.toFixed(2)}</span></div>
            <div class="summary-row total"><span>Change vs Prior Period</span><span>${escapeHtml(changeText)}</span></div>
          </div>

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}
        </div>
      </body>
    </html>
  `
}

type JobProfitabilityRow = {
  jobId: string
  jobNumber: string
  title: string
  status: string
  clientName: string
  revenue: number
  laborCost: number
  materialCost: number
  totalCost: number
  profit: number
  marginPercent: number | null
  poSpend: number
  hoursLogged: number
  hasCostData: boolean
}

export function buildJobProfitabilityPdfHtml(
  data: {
    rows: JobProfitabilityRow[]
    totals: { revenue: number; laborCost: number; materialCost: number; profit: number }
    startDate: Date | null
    endDate: Date | null
  },
  brand: PdfBranding
): string {
  const { rows, totals, startDate, endDate } = data
  const generatedAt = new Date().toLocaleString()
  const periodLabel =
    startDate || endDate
      ? `${startDate ? startDate.toLocaleDateString() : 'Start'} — ${endDate ? endDate.toLocaleDateString() : 'Today'}`
      : 'All time'

  const tableRows = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.jobNumber)}</td>
        <td>${escapeHtml(r.clientName)}</td>
        <td class="text-right">$${r.revenue.toFixed(2)}</td>
        <td class="text-right">$${r.totalCost.toFixed(2)}</td>
        <td class="text-right" style="font-weight:600;color:${r.profit < 0 ? '#dc2626' : '#111827'};">$${r.profit.toFixed(2)}</td>
        <td class="text-right">${r.marginPercent === null ? (r.hasCostData ? '' : '—') : `${r.marginPercent.toFixed(1)}%`}</td>
      </tr>`
    )
    .join('')

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Job Profitability</title>
        <style>${SHARED_DOC_CSS(brand.accentColor, brand.accentTextColor)}</style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">${logoBlock(brand, 'Trim Pro Logo')}</div>
              <h1 class="doc-title">Job Profitability</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              <div><strong>Period:</strong> ${escapeHtml(periodLabel)}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Job #</th>
                <th>Customer</th>
                <th class="text-right">Revenue</th>
                <th class="text-right">Cost</th>
                <th class="text-right">Profit</th>
                <th class="text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0 ? `<tr><td colspan="6" class="muted">No jobs in this period</td></tr>` : tableRows}
            </tbody>
          </table>

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Total Revenue</span><span>$${totals.revenue.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Labor Cost</span><span>$${totals.laborCost.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Material Cost</span><span>$${totals.materialCost.toFixed(2)}</span></div>
            <div class="summary-row total"><span>Total Profit</span><span>$${totals.profit.toFixed(2)}</span></div>
          </div>

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}
        </div>
      </body>
    </html>
  `
}

export function buildVendorSpendPdfHtml(
  data: {
    byVendor: Array<{ vendorKey: string; vendorName: string; poCount: number; total: number }>
    grandTotal: number
    startDate: Date | null
    endDate: Date | null
  },
  brand: PdfBranding
): string {
  const { byVendor, grandTotal, startDate, endDate } = data
  const generatedAt = new Date().toLocaleString()
  const periodLabel =
    startDate || endDate
      ? `${startDate ? startDate.toLocaleDateString() : 'Start'} — ${endDate ? endDate.toLocaleDateString() : 'Today'}`
      : 'All time'

  const rows = byVendor
    .map(
      (v) => `<tr>
        <td>${escapeHtml(v.vendorName)}</td>
        <td class="text-right">${v.poCount}</td>
        <td class="text-right" style="font-weight:600;">$${v.total.toFixed(2)}</td>
      </tr>`
    )
    .join('')

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Vendor Spend Report</title>
        <style>${SHARED_DOC_CSS(brand.accentColor, brand.accentTextColor)}</style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">${logoBlock(brand, 'Trim Pro Logo')}</div>
              <h1 class="doc-title">Vendor Spend</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              <div><strong>Period:</strong> ${escapeHtml(periodLabel)}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th class="text-right">Purchase Orders</th>
                <th class="text-right">Total Spend</th>
              </tr>
            </thead>
            <tbody>
              ${byVendor.length === 0 ? `<tr><td colspan="3" class="muted">No purchase order spend in this period</td></tr>` : rows}
            </tbody>
            <tfoot>
              <tr style="font-weight:700;background:#f8fafc;">
                <td>Total</td>
                <td class="text-right">${byVendor.reduce((s, v) => s + v.poCount, 0)}</td>
                <td class="text-right">$${grandTotal.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}
        </div>
      </body>
    </html>
  `
}

type PaymentHistoryRow = {
  createdAt: Date | string
  customerName: string
  invoiceNumber: string
  provider: string
  paymentMethod: string
  status: string
  amount: number
  refundedAmount: number
  providerPaymentId: string
}

export function buildPaymentHistoryPdfHtml(
  data: {
    rows: PaymentHistoryRow[]
    summary: { totalAmount: number; totalRefunded: number; succeededCount: number; failedCount: number }
    startDate: Date | null
    endDate: Date | null
  },
  brand: PdfBranding
): string {
  const { rows, summary, startDate, endDate } = data
  const generatedAt = new Date().toLocaleString()
  const periodLabel =
    startDate || endDate
      ? `${startDate ? startDate.toLocaleDateString() : 'Start'} — ${endDate ? endDate.toLocaleDateString() : 'Today'}`
      : 'All time'

  const tableRows = rows
    .map((r) => {
      const date = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)
      return `<tr>
        <td>${escapeHtml(date.toLocaleDateString())}</td>
        <td>${escapeHtml(r.customerName)}</td>
        <td>${escapeHtml(r.invoiceNumber)}</td>
        <td>${escapeHtml(r.paymentMethod)}</td>
        <td>${escapeHtml(r.status)}</td>
        <td class="text-right">$${r.amount.toFixed(2)}</td>
        <td class="text-right">${r.refundedAmount ? `$${r.refundedAmount.toFixed(2)}` : ''}</td>
      </tr>`
    })
    .join('')

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Payment History</title>
        <style>${SHARED_DOC_CSS(brand.accentColor, brand.accentTextColor)}</style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div>
              <div class="brand">${logoBlock(brand, 'Trim Pro Logo')}</div>
              <h1 class="doc-title">Payment History</h1>
              <div class="muted">Generated on ${generatedAt}</div>
            </div>
            <div class="meta">
              <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(brand.businessName)}</div>
              <div><strong>Period:</strong> ${escapeHtml(periodLabel)}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Invoice #</th>
                <th>Method</th>
                <th>Status</th>
                <th class="text-right">Amount</th>
                <th class="text-right">Refunded</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0 ? `<tr><td colspan="7" class="muted">No payments in this period</td></tr>` : tableRows}
            </tbody>
          </table>

          <div class="summary">
            <h4>Summary</h4>
            <div class="summary-row"><span>Total Amount</span><span>$${summary.totalAmount.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Refunded</span><span>$${summary.totalRefunded.toFixed(2)}</span></div>
            <div class="summary-row"><span>Succeeded</span><span>${summary.succeededCount}</span></div>
            <div class="summary-row total"><span>Failed</span><span>${summary.failedCount}</span></div>
          </div>

          ${brand.footerText ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">${escapeHtml(brand.footerText)}</div>` : ''}
        </div>
      </body>
    </html>
  `
}
