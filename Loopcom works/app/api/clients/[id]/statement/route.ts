import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getPdfBranding } from '@/lib/branding/pdf'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getUserFromToken } from '@/lib/auth'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'
import { buildStatementViewUrl } from '@/app/api/public/clients/[id]/statement/route'

export const runtime = 'nodejs'

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatCurrency(amount: number) {
  return '$' + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDate(date: Date | string | null) {
  if (!date) return '-'
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// ─── shared helper ────────────────────────────────────────────────────────────

async function buildStatementHtml(clientId: string, tenantId: string): Promise<{
  html: string
  clientName: string
  totalOutstanding: number
  openCount: number
} | null> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, tenantId },
    include: {
      addresses: { where: { type: 'BILLING' }, take: 1 },
    },
  })
  if (!client) return null

  const openInvoices = await prisma.invoice.findMany({
    where: {
      clientId: client.id,
      tenantId,
      status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] },
      balance: { gt: 0 },
    },
    orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }],
  })

  const totalOutstanding = openInvoices.reduce((sum, inv) => sum + Number(inv.balance), 0)
  const brand = await getPdfBranding(tenantId)

  const billingAddr = client.addresses?.[0]
  const clientAddress = billingAddr
    ? [
        billingAddr.street,
        [billingAddr.city, billingAddr.state, (billingAddr as any).zip || billingAddr.zipCode]
          .filter(Boolean)
          .join(', '),
      ]
        .filter(Boolean)
        .join('\n')
    : null

  const statementDate = formatDate(new Date())

  const invoiceRows = openInvoices
    .map(
      (inv) => `
      <tr>
        <td>${escapeHtml(inv.invoiceNumber)}</td>
        <td>${escapeHtml(formatDate(inv.invoiceDate))}</td>
        <td>${escapeHtml(formatDate(inv.dueDate))}</td>
        <td style="text-align:right">${escapeHtml(formatCurrency(Number(inv.total)))}</td>
        <td style="text-align:right">${escapeHtml(formatCurrency(Number(inv.paidAmount || 0)))}</td>
        <td style="text-align:right; font-weight:600; color:#b45309">${escapeHtml(formatCurrency(Number(inv.balance)))}</td>
      </tr>
    `
    )
    .join('')

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Statement - ${escapeHtml(client.name)}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: Inter, Helvetica, Arial, sans-serif;
        color: #111827;
        background: #f8fafc;
        padding: 30px;
      }
      .page {
        max-width: 900px;
        margin: 0 auto;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        padding: 36px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 32px;
        padding-bottom: 24px;
        border-bottom: 2px solid #f0c974;
      }
      .logo-image { height: 52px; width: auto; max-width: 240px; object-fit: contain; }
      .logo-fallback {
        height: 52px; min-width: 140px; border-radius: 10px;
        background: ${escapeHtml(brand.accentColor)};
        color: ${escapeHtml(brand.accentTextColor)};
        display: flex; align-items: center; justify-content: center;
        font-size: 22px; font-weight: 700; padding: 0 16px;
      }
      .business-info { font-size: 12px; color: #6b7280; line-height: 1.8; text-align: right; }
      .business-info .biz-name { font-size: 14px; font-weight: 700; color: #111827; }
      .statement-title {
        font-size: 28px; font-weight: 800; color: #243f53; margin-bottom: 24px; letter-spacing: -0.02em;
      }
      .meta-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px;
      }
      .meta-box { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }
      .meta-label { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
      .meta-value { font-size: 14px; color: #111827; white-space: pre-line; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      thead tr { background: #243f53; color: #ffffff; }
      th {
        padding: 11px 14px; font-size: 11px; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.05em; text-align: left;
      }
      td { padding: 11px 14px; font-size: 13px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
      tbody tr:nth-child(even) { background: #f9fafb; }
      tbody tr:last-child td { border-bottom: none; }
      .total-section {
        margin-top: 20px; display: flex; justify-content: flex-end;
      }
      .total-box {
        background: linear-gradient(135deg, #243f53 0%, #1e4d6e 100%);
        color: #fff; border-radius: 12px; padding: 20px 28px; min-width: 260px;
      }
      .total-label { font-size: 13px; opacity: 0.8; margin-bottom: 6px; }
      .total-amount { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; color: #f0c974; }
      .footer {
        margin-top: 28px; padding-top: 20px; border-top: 1px solid #e5e7eb;
        font-size: 11px; color: #9ca3af; text-align: center;
      }
      @media print {
        body { background: #fff; padding: 0; }
        .page { border: none; border-radius: 0; padding: 20px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <div>
          ${
            brand.logoUrl
              ? `<img class="logo-image" src="${escapeHtml(String(brand.logoUrl))}" alt="${escapeHtml(brand.businessName)}" />`
              : `<div class="logo-fallback">${escapeHtml(brand.businessName.substring(0, 8))}</div>`
          }
        </div>
        <div class="business-info">
          <div class="biz-name">${escapeHtml(brand.businessName)}</div>
          ${brand.businessPhone ? `<div>${escapeHtml(brand.businessPhone)}</div>` : ''}
          ${brand.businessEmail ? `<div>${escapeHtml(brand.businessEmail)}</div>` : ''}
          ${brand.businessAddress ? `<div>${escapeHtml(brand.businessAddress)}</div>` : ''}
        </div>
      </div>

      <div class="statement-title">Account Statement</div>

      <div class="meta-grid">
        <div class="meta-box">
          <div class="meta-label">Bill To</div>
          <div class="meta-value">
            <strong>${escapeHtml(client.name)}</strong>
            ${client.companyName ? `\n${escapeHtml(client.companyName)}` : ''}
            ${clientAddress ? `\n${escapeHtml(clientAddress)}` : ''}
            ${client.email ? `\n${escapeHtml(client.email)}` : ''}
            ${client.phone ? `\n${escapeHtml(client.phone)}` : ''}
          </div>
        </div>
        <div class="meta-box">
          <div class="meta-label">Statement Details</div>
          <div class="meta-value">
            <strong>Statement Date:</strong> ${escapeHtml(statementDate)}\n
            <strong>Open Invoices:</strong> ${openInvoices.length}\n
            <strong>Total Outstanding:</strong> <span style="color:#b45309;font-weight:700">${escapeHtml(formatCurrency(totalOutstanding))}</span>
          </div>
        </div>
      </div>

      ${
        openInvoices.length === 0
          ? `<div style="text-align:center; padding:40px; color:#6b7280; font-size:16px;">
               No open invoices found. This account is fully paid.
             </div>`
          : `
        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Invoice Date</th>
              <th>Due Date</th>
              <th style="text-align:right">Amount</th>
              <th style="text-align:right">Amount Paid</th>
              <th style="text-align:right">Balance Due</th>
            </tr>
          </thead>
          <tbody>${invoiceRows}</tbody>
        </table>

        <div class="total-section">
          <div class="total-box">
            <div class="total-label">Total Outstanding Balance</div>
            <div class="total-amount">${escapeHtml(formatCurrency(totalOutstanding))}</div>
          </div>
        </div>
      `
      }

      <div class="footer">
        This statement was generated on ${escapeHtml(statementDate)} and reflects all open invoices as of this date.
        Please contact us if you have any questions about your account.
      </div>
    </div>
  </body>
</html>`

  return { html, clientName: client.name, totalOutstanding, openCount: openInvoices.length }
}

// ─── GET: preview / download ──────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // Support both Authorization header and ?t= query param (for direct PDF download links)
  const queryToken = request.nextUrl.searchParams.get('t') || ''
  let user: { id: string; tenantId: string; email: string; role: string } | null = null

  if (queryToken) {
    const u = await getUserFromToken(queryToken)
    if (u && u.status === 'ACTIVE') {
      user = { id: u.id, tenantId: u.tenantId, email: u.email, role: u.role }
    }
  }

  if (!user) {
    const authError = await authenticateRequest(request)
    if (authError) return authError
    user = getAuthUser(request)
  }

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  ;(request as any).user = user
  const permError = await requirePermission(request, 'clients.view')
  if (permError) return permError

  const format = request.nextUrl.searchParams.get('format') || 'html'
  const download = request.nextUrl.searchParams.get('download') === '1'

  try {
    const result = await buildStatementHtml(params.id, user.tenantId)
    if (!result) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }
    const { html, clientName } = result
    const safeName = clientName.replace(/[^a-z0-9]/gi, '-')

    if (format === 'pdf') {
      try {
        const pdf = await renderPdfFromHtml(html)
        return new NextResponse(pdf as unknown as BodyInit, {
          headers: {
            'Content-Type': 'application/pdf',
            'Cache-Control': 'no-store',
            'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="Statement-${safeName}.pdf"`,
          },
        })
      } catch (e) {
        console.error('Statement PDF render failed, falling back to HTML:', e)
        return new NextResponse(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="Statement-${safeName}.html"`,
          },
        })
      }
    }

    return new NextResponse(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('Statement GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── POST: send statement by email ───────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.view')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const recipientEmail = String(body?.email || '').trim().toLowerCase()
    if (!recipientEmail || !recipientEmail.includes('@')) {
      return NextResponse.json({ error: 'Valid email address is required' }, { status: 400 })
    }

    const result = await buildStatementHtml(params.id, user.tenantId)
    if (!result) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }
    const { html, clientName, totalOutstanding, openCount } = result

    // Build a signed public URL so the client can view the statement in their browser
    const appUrl = (
      process.env.PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.CANONICAL_PUBLIC_APP_URL ||
      'https://app.trimprony.com'
    ).replace(/\/+$/, '')
    const viewUrl = buildStatementViewUrl(params.id, appUrl)

    // Generate PDF attachment
    let pdfAttachment: Buffer | null = null
    try {
      pdfAttachment = await renderPdfFromHtml(html) as Buffer
    } catch {
      // Non-fatal — send without PDF if rendering fails
    }

    const { buildStatementEmail } = await import('@/lib/email/templates/statement')
    const emailHtml = buildStatementEmail({
      clientName,
      recipientEmail,
      openCount,
      totalOutstanding: formatCurrency(totalOutstanding),
      viewUrl,
      hasPdf: !!pdfAttachment,
    })

    // Use the tenant's configured email integration (same as invoice/estimate emails)
    const emailSecrets = await getIntegrationSecrets(user.tenantId, 'email')
    if (!emailSecrets) {
      return NextResponse.json(
        { error: 'Email is not configured. Please set up an email integration in Settings > Integrations.' },
        { status: 400 }
      )
    }

    const sendResult = await sendEmailWithAttachments({
      secrets: emailSecrets,
      to: recipientEmail,
      subject: `Account Statement - ${clientName}`,
      html: emailHtml,
      text: `Hi ${clientName},\n\nPlease find your account statement${pdfAttachment ? ' attached as a PDF' : ''}.\n\nYou currently have ${openCount} open invoice${openCount !== 1 ? 's' : ''} with a total outstanding balance of ${formatCurrency(totalOutstanding)}.\n\nView your statement online: ${viewUrl}\n\nIf you have any questions, please contact us.`,
      attachments: pdfAttachment
        ? [{ filename: `Statement-${clientName.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfAttachment, contentType: 'application/pdf' }]
        : undefined,
    })

    if (!sendResult.success) {
      console.error('Statement email send failed:', sendResult.error || sendResult.message)
      return NextResponse.json(
        { error: sendResult.message || 'Failed to send email' },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true, sentTo: recipientEmail })
  } catch (error) {
    console.error('Statement email error:', error)
    return NextResponse.json({ error: 'Failed to send statement email' }, { status: 500 })
  }
}
