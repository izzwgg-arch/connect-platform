import { getInvoiceTemplateById, INVOICE_TEMPLATES } from '@/lib/invoices/templates/registry'

export type InvoicePdfLineItem = {
  description: string
  notes?: string
  quantity: number
  unitPrice: number
  total: number
}

export interface InvoicePdfTemplateData {
  templateId: string
  logoUrl?: string | null
  businessName: string
  businessDetails?: string | null
  clientName: string
  clientEmail?: string | null
  invoiceNumber: string
  title: string
  status: string
  invoiceDate: string
  dueDate: string
  generatedAt: string
  accentColor: string
  lineItems: InvoicePdfLineItem[]
  optionalItems: InvoicePdfLineItem[]
  subtotal: number
  optionalSubtotal: number
  discount: number
  tax: number
  paid: number
  total: number
  balance: number
  notes?: string | null
  footerText?: string | null
  paymentLink?: string | null
}

type TemplateShape = {
  font: string
  header: 'left' | 'center' | 'split' | 'band' | 'receipt'
  table: 'grid' | 'striped' | 'boxed' | 'minimal'
  totals: 'right' | 'bottom' | 'sidebar' | 'hero'
  frame: 'none' | 'single' | 'double'
  spacing: 'tight' | 'normal' | 'airy'
}

const SHAPES: Record<string, TemplateShape> = {
  'modern-minimal-left-header': { font: 'Inter, Arial, sans-serif', header: 'left', table: 'minimal', totals: 'right', frame: 'single', spacing: 'normal' },
  'modern-centered-logo': { font: 'Inter, Arial, sans-serif', header: 'center', table: 'grid', totals: 'bottom', frame: 'single', spacing: 'airy' },
  'modern-split-columns': { font: 'Inter, Arial, sans-serif', header: 'split', table: 'grid', totals: 'right', frame: 'single', spacing: 'normal' },
  'modern-full-header-band': { font: 'Inter, Arial, sans-serif', header: 'band', table: 'minimal', totals: 'hero', frame: 'none', spacing: 'airy' },
  'modern-card-sections': { font: 'Inter, Arial, sans-serif', header: 'left', table: 'boxed', totals: 'right', frame: 'single', spacing: 'normal' },
  'modern-sidebar-totals': { font: 'Inter, Arial, sans-serif', header: 'split', table: 'striped', totals: 'sidebar', frame: 'single', spacing: 'normal' },
  'modern-large-total-focus': { font: 'Inter, Arial, sans-serif', header: 'left', table: 'minimal', totals: 'hero', frame: 'single', spacing: 'airy' },
  'modern-clean-grid-table': { font: 'Inter, Arial, sans-serif', header: 'split', table: 'grid', totals: 'right', frame: 'single', spacing: 'tight' },
  'classic-ledger': { font: '"Times New Roman", Georgia, serif', header: 'left', table: 'striped', totals: 'right', frame: 'single', spacing: 'tight' },
  'classic-formal-business': { font: '"Times New Roman", Georgia, serif', header: 'split', table: 'boxed', totals: 'right', frame: 'single', spacing: 'normal' },
  'classic-serif-legal': { font: 'Georgia, serif', header: 'left', table: 'grid', totals: 'bottom', frame: 'single', spacing: 'normal' },
  'classic-double-border': { font: '"Times New Roman", Georgia, serif', header: 'center', table: 'boxed', totals: 'right', frame: 'double', spacing: 'normal' },
  'classic-letterhead': { font: 'Georgia, serif', header: 'band', table: 'minimal', totals: 'bottom', frame: 'single', spacing: 'normal' },
  'vintage-paper-look': { font: 'Georgia, serif', header: 'left', table: 'striped', totals: 'right', frame: 'single', spacing: 'airy' },
  'typewriter-monospace': { font: '"Courier New", monospace', header: 'left', table: 'grid', totals: 'bottom', frame: 'single', spacing: 'tight' },
  'old-retail-receipt-layout': { font: '"Courier New", monospace', header: 'receipt', table: 'minimal', totals: 'bottom', frame: 'none', spacing: 'tight' },
  '80s-boxed-invoice': { font: '"Courier New", monospace', header: 'split', table: 'boxed', totals: 'right', frame: 'double', spacing: 'tight' },
  'bold-high-contrast': { font: 'Inter, Arial, sans-serif', header: 'band', table: 'grid', totals: 'hero', frame: 'none', spacing: 'normal' },
  'geometric-accent': { font: 'Inter, Arial, sans-serif', header: 'split', table: 'striped', totals: 'sidebar', frame: 'single', spacing: 'airy' },
  'asymmetrical-modern': { font: 'Inter, Arial, sans-serif', header: 'left', table: 'boxed', totals: 'sidebar', frame: 'none', spacing: 'normal' },
}

function esc(v: string) {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function lineRows(items: InvoicePdfLineItem[]) {
  return items
    .map((item) => `
      <tr>
        <td>${esc(item.description)}</td>
        <td>${esc(item.notes || '')}</td>
        <td class="text-right">${item.quantity.toFixed(2)}</td>
        <td class="text-right">$${item.unitPrice.toFixed(2)}</td>
        <td class="text-right">$${item.total.toFixed(2)}</td>
      </tr>
    `)
    .join('')
}

function totalsBlock(data: InvoicePdfTemplateData, mode: TemplateShape['totals']) {
  const className = mode === 'hero' ? 'totals totals-hero' : mode === 'sidebar' ? 'totals totals-sidebar' : mode === 'bottom' ? 'totals totals-bottom' : 'totals totals-right'
  return `
    <div class="${className}">
      <div class="row"><span>Subtotal</span><span>$${data.subtotal.toFixed(2)}</span></div>
      <div class="row"><span>Discount</span><span>-$${data.discount.toFixed(2)}</span></div>
      <div class="row"><span>Tax</span><span>$${data.tax.toFixed(2)}</span></div>
      <div class="row"><span>Paid</span><span>$${data.paid.toFixed(2)}</span></div>
      <div class="row total"><span>Balance Due</span><span>$${data.balance.toFixed(2)}</span></div>
    </div>
  `
}

function headerBlock(data: InvoicePdfTemplateData, shape: TemplateShape) {
  const logo = data.logoUrl ? `<img class="logo" src="${esc(data.logoUrl)}" alt="${esc(data.businessName)} logo" />` : `<div class="logo-fallback">${esc(data.businessName)}</div>`

  if (shape.header === 'center') {
    return `
      <header class="header header-center">
        ${logo}
        <h1>Invoice</h1>
        <p>${esc(data.businessName)}</p>
        <small>${esc(data.businessDetails || '')}</small>
      </header>
    `
  }

  if (shape.header === 'split') {
    return `
      <header class="header header-split">
        <div>${logo}<h1>Invoice</h1></div>
        <div class="meta">
          <div><strong>No.</strong> ${esc(data.invoiceNumber)}</div>
          <div><strong>Status</strong> ${esc(data.status)}</div>
          <div><strong>Issued</strong> ${esc(data.invoiceDate)}</div>
          <div><strong>Due</strong> ${esc(data.dueDate)}</div>
        </div>
      </header>
    `
  }

  if (shape.header === 'band') {
    return `
      <header class="header header-band">
        <div class="band-left">${logo}</div>
        <div class="band-right">
          <h1>Invoice</h1>
          <div class="meta-inline">${esc(data.invoiceNumber)} • ${esc(data.invoiceDate)} • ${esc(data.status)}</div>
        </div>
      </header>
    `
  }

  if (shape.header === 'receipt') {
    return `
      <header class="header header-receipt">
        <h1>${esc(data.businessName)}</h1>
        <div>${esc(data.businessDetails || '')}</div>
        <div>Invoice ${esc(data.invoiceNumber)}</div>
        <div>${esc(data.invoiceDate)} | Due ${esc(data.dueDate)}</div>
      </header>
    `
  }

  return `
    <header class="header header-left">
      ${logo}
      <h1>Invoice</h1>
      <div class="meta-inline">${esc(data.invoiceNumber)} • ${esc(data.invoiceDate)} • ${esc(data.status)}</div>
    </header>
  `
}

export function renderInvoicePdfTemplate(data: InvoicePdfTemplateData): string | null {
  const template = getInvoiceTemplateById(data.templateId)
  if (!template) return null
  const shape = SHAPES[template.id]
  if (!shape) return null

  const tableClass = `items items-${shape.table}`
  const pageClass = `page frame-${shape.frame} spacing-${shape.spacing} totals-mode-${shape.totals}`
  const optionalSection =
    data.optionalItems.length > 0
      ? `
      <section class="optional">
        <h3>Optional Items</h3>
        <table class="${tableClass}">
          <thead>
            <tr><th>Item</th><th>Description</th><th class="text-right">Qty</th><th class="text-right">Unit</th><th class="text-right">Total</th></tr>
          </thead>
          <tbody>${lineRows(data.optionalItems)}</tbody>
        </table>
        <div class="optional-total">Optional Subtotal: $${data.optionalSubtotal.toFixed(2)}</div>
      </section>
    `
      : ''

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Invoice ${esc(data.invoiceNumber)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; font-family: ${shape.font}; }
      .page { max-width: 980px; margin: 0 auto; background: #fff; padding: 24px; }
      .frame-single { border: 1px solid #d1d5db; border-radius: 10px; }
      .frame-double { border: 4px double #374151; border-radius: 0; }
      .frame-none { border: none; }
      .spacing-tight { padding: 16px; }
      .spacing-normal { padding: 24px; }
      .spacing-airy { padding: 30px; }
      .header { margin-bottom: 18px; }
      .header h1 { margin: 6px 0; font-size: 30px; }
      .logo { height: 52px; max-width: 260px; object-fit: contain; display: block; }
      .logo-fallback { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 12px; font-weight: 700; color: #fff; background: ${template.preview.accentColor}; }
      .header-center { text-align: center; }
      .header-center .logo, .header-center .logo-fallback { margin: 0 auto; }
      .header-split { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: start; }
      .meta { font-size: 12px; line-height: 1.7; text-align: right; }
      .header-band { display: grid; grid-template-columns: 240px 1fr; align-items: stretch; border: 1px solid #cbd5e1; }
      .band-left { padding: 12px; background: ${template.preview.accentColor}; color: #fff; display:flex; align-items:center; justify-content:center; }
      .band-right { padding: 12px 14px; background: #f1f5f9; }
      .header-receipt { text-align: center; border-bottom: 2px dashed #6b7280; padding-bottom: 10px; font-size: 12px; }
      .meta-inline { font-size: 12px; color: #475569; }
      .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
      .box { border: 1px solid #e2e8f0; padding: 10px; border-radius: 8px; background: #fff; }
      .box h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; }
      .items { width: 100%; border-collapse: collapse; margin-top: 10px; }
      .items th, .items td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
      .items th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; }
      .items-grid { border: 1px solid #cbd5e1; }
      .items-grid td, .items-grid th { border: 1px solid #cbd5e1; }
      .items-striped tbody tr:nth-child(even) { background: #f8fafc; }
      .items-boxed { border: 2px solid #1f2937; }
      .items-boxed td, .items-boxed th { border: 1px solid #1f2937; }
      .items-minimal th, .items-minimal td { border-bottom: 1px dotted #94a3b8; }
      .text-right { text-align: right; }
      .totals { border: 1px solid #d1d5db; background: #f8fafc; padding: 12px; min-width: 280px; }
      .totals .row { display: flex; justify-content: space-between; font-size: 13px; padding: 3px 0; }
      .totals .total { border-top: 1px solid #94a3b8; margin-top: 6px; padding-top: 8px; font-size: 18px; font-weight: 700; }
      .totals-right { margin-top: 14px; margin-left: auto; }
      .totals-bottom { margin-top: 16px; width: 100%; }
      .totals-sidebar { margin-top: 0; }
      .totals-hero { margin-top: 18px; background: ${template.preview.accentColor}; color: #fff; border: none; }
      .totals-mode-sidebar .content { display: grid; grid-template-columns: 1fr 320px; gap: 14px; align-items: start; }
      .optional { margin-top: 16px; }
      .optional h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; }
      .optional-total { margin-top: 6px; text-align: right; font-size: 12px; color: #475569; }
      .notes { margin-top: 16px; border: 1px solid #e2e8f0; background: #f8fafc; border-radius: 8px; padding: 10px; white-space: pre-wrap; font-size: 13px; }
      .footer { margin-top: 16px; font-size: 12px; color: #64748b; }
      @media print { body { padding: 0; background: #fff; } .page { border: none; border-radius: 0; } }
    </style>
  </head>
  <body>
    <div class="${pageClass}">
      ${headerBlock(data, shape)}

      <div class="parties">
        <div class="box">
          <h4>Billed To</h4>
          <div>${esc(data.clientName)}</div>
          ${data.clientEmail ? `<div>${esc(data.clientEmail)}</div>` : ''}
        </div>
        <div class="box">
          <h4>Business</h4>
          <div>${esc(data.businessName)}</div>
          ${data.businessDetails ? `<div>${esc(data.businessDetails)}</div>` : ''}
          <div>${esc(data.title)}</div>
        </div>
      </div>

      <div class="content">
        <div>
          <table class="${tableClass}">
            <thead>
              <tr><th>Item</th><th>Description</th><th class="text-right">Qty</th><th class="text-right">Unit</th><th class="text-right">Total</th></tr>
            </thead>
            <tbody>${lineRows(data.lineItems)}</tbody>
          </table>
          ${optionalSection}
          ${shape.totals === 'bottom' || shape.totals === 'hero' ? totalsBlock(data, shape.totals) : ''}
        </div>
        ${shape.totals === 'sidebar' ? totalsBlock(data, 'sidebar') : ''}
      </div>

      ${shape.totals === 'right' ? totalsBlock(data, 'right') : ''}

      ${data.notes ? `<div class="notes">${esc(data.notes)}</div>` : ''}
      ${data.footerText ? `<div class="footer">${esc(data.footerText)}</div>` : ''}
      ${data.paymentLink ? `<div class="footer">Pay online: ${esc(data.paymentLink)}</div>` : ''}
    </div>
  </body>
</html>`
}

export function getDefaultTemplateId() {
  return INVOICE_TEMPLATES[0]?.id || null
}
