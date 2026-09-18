import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { renderInvoicePdfTemplate } from '@/lib/invoices/pdf/templates'

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const templateId = String(request.nextUrl.searchParams.get('templateId') || '').trim()

  const sampleData = {
    logoUrl: null,
    businessName: 'Sample Business',
    businessDetails: '(555) 555-5555 • billing@example.com • 500 Market St, NY',
    clientName: 'Sample Customer',
    clientEmail: 'customer@example.com',
    invoiceNumber: 'INV-01001',
    title: 'Sample Invoice',
    status: 'DRAFT',
    invoiceDate: '03/01/2026',
    dueDate: '03/15/2026',
    generatedAt: new Date().toLocaleString(),
    accentColor: '#12344d',
    lineItems: [
      { description: 'Cabinet installation', notes: 'Main floor', quantity: 1, unitPrice: 950, total: 950 },
      { description: 'Trim package', notes: 'Premium profile', quantity: 2, unitPrice: 180, total: 360 },
    ],
    optionalItems: [{ description: 'Hardware upgrade', notes: 'Optional', quantity: 1, unitPrice: 140, total: 140 }],
    subtotal: 1310,
    optionalSubtotal: 140,
    discount: 50,
    tax: 101.4,
    paid: 0,
    total: 1361.4,
    balance: 1361.4,
    notes: 'Thank you for your business.',
    footerText: 'Payment due within 14 days.',
    paymentLink: 'https://example.com/pay/sample',
  }

  const html =
    (templateId
      ? renderInvoicePdfTemplate({
          ...sampleData,
          templateId,
        })
      : null) ||
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Inter, Arial, sans-serif; padding: 24px; color: #111827; }
      .page { border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; }
      h1 { margin: 0 0 8px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { border: 1px solid #e5e7eb; padding: 8px; font-size: 12px; }
      th { background: #f8fafc; text-align: left; }
      .sum { margin-top: 14px; margin-left: auto; max-width: 260px; }
      .row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="page">
      <h1>Invoice ${escapeHtml(sampleData.invoiceNumber)}</h1>
      <div>${escapeHtml(sampleData.businessName)} • ${escapeHtml(sampleData.clientName)}</div>
      <table>
        <thead><tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
        <tbody>
          <tr><td>Cabinet installation</td><td>Main floor</td><td>1</td><td>$950.00</td><td>$950.00</td></tr>
          <tr><td>Trim package</td><td>Premium profile</td><td>2</td><td>$180.00</td><td>$360.00</td></tr>
        </tbody>
      </table>
      <div class="sum">
        <div class="row"><span>Subtotal</span><span>$1310.00</span></div>
        <div class="row"><span>Discount</span><span>-$50.00</span></div>
        <div class="row"><span>Tax</span><span>$101.40</span></div>
        <div class="row"><strong>Balance</strong><strong>$1361.40</strong></div>
      </div>
    </div>
  </body>
</html>`

  const pdf = await renderPdfFromHtml(html)
  return new NextResponse(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline; filename="invoice-template-preview.pdf"',
    },
  })
}
