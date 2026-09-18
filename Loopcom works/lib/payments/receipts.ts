import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { splitEmailList } from '@/lib/email'
import { getPdfBranding } from '@/lib/branding/pdf'
import { getEmailBranding } from '@/lib/email/branding'
import { sendPaymentReceiptEmail } from '@/lib/services/email'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'

const RECEIPT_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000

function randomToken() {
  return crypto.randomBytes(32).toString('hex')
}

export function appBaseUrl() {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.CANONICAL_PUBLIC_APP_URL ||
    'https://app.trimprony.com'
  ).replace(/\/+$/, '')
}

export function formatPaymentMethodLabel(payment: {
  method: string
  provider?: string | null
  notes?: string | null
}) {
  const method = String(payment.method || '').toUpperCase()
  const provider = String(payment.provider || '').toLowerCase()

  if (provider === 'quickbooks' && method === 'ACH') return 'ACH (QuickBooks)'
  if (provider === 'quick_pay') return 'Quick Pay'
  if (provider === 'sola') return 'Card'
  if (method === 'CHECK') return 'Check'
  if (method === 'CARD') return 'Card'
  if (method === 'ACH') return 'ACH'
  if (method === 'BANK_TRANSFER') return 'Bank Transfer'
  if (method === 'CASH') return 'Cash'
  if (method === 'OTHER' && payment.notes) {
    const match = payment.notes.match(/paid — (.+)$/i)
    if (match?.[1]) return match[1]
  }
  return method.replace(/_/g, ' ')
}

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatMoney(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount || 0))
}

function formatReceiptDate(value: Date | string | null | undefined) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export type PaymentReceiptContext = {
  payment: {
    id: string
    amount: number
    method: string
    provider: string | null
    notes: string | null
    reference: string | null
    providerPaymentId: string | null
    providerInvoiceId: string | null
    processedAt: Date | null
    createdAt: Date
    receiptToken: string | null
    receiptTokenExpiresAt: Date | null
    receiptEmailSentAt: Date | null
  }
  invoice: {
    id: string
    invoiceNumber: string
    tenantId: string
  }
  tenantName: string
  clientName: string
  clientEmail: string | null
  methodLabel: string
  receiptUrl: string
  invoiceUrl: string
}

const paymentReceiptInclude = {
  invoice: {
    include: {
      tenant: { select: { name: true } },
      client: {
        select: {
          name: true,
          email: true,
          contacts: {
            where: { email: { not: null } },
            orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
            take: 1,
            select: { email: true },
          },
        },
      },
    },
  },
} as const

type PaymentWithReceiptInclude = {
  id: string
  amount: unknown
  method: string
  provider: string | null
  notes: string | null
  reference: string | null
  providerPaymentId: string | null
  providerInvoiceId: string | null
  processedAt: Date | null
  createdAt: Date
  receiptToken: string | null
  receiptTokenExpiresAt: Date | null
  receiptEmailSentAt: Date | null
  invoice: {
    id: string
    invoiceNumber: string
    tenantId: string
    paymentToken: string | null
    tenant: { name: string } | null
    client: {
      name: string
      email: string | null
      contacts: { email: string | null }[]
    } | null
  }
}

function mapPaymentToReceiptContext(
  payment: PaymentWithReceiptInclude,
  tokenOverride?: { receiptToken: string; receiptTokenExpiresAt: Date }
): PaymentReceiptContext {
  const clientEmail =
    splitEmailList(payment.invoice.client?.email || '')[0] ||
    String(payment.invoice.client?.contacts?.[0]?.email || '').trim() ||
    null

  const appUrl = appBaseUrl()
  const token = tokenOverride?.receiptToken || payment.receiptToken || ''

  return {
    payment: {
      id: payment.id,
      amount: Number(payment.amount || 0),
      method: payment.method,
      provider: payment.provider,
      notes: payment.notes,
      reference: payment.reference,
      providerPaymentId: payment.providerPaymentId,
      providerInvoiceId: payment.providerInvoiceId,
      processedAt: payment.processedAt,
      createdAt: payment.createdAt,
      receiptToken: token || payment.receiptToken,
      receiptTokenExpiresAt:
        tokenOverride?.receiptTokenExpiresAt || payment.receiptTokenExpiresAt,
      receiptEmailSentAt: payment.receiptEmailSentAt,
    },
    invoice: {
      id: payment.invoice.id,
      invoiceNumber: payment.invoice.invoiceNumber,
      tenantId: payment.invoice.tenantId,
    },
    tenantName: payment.invoice.tenant?.name || 'TrimPro',
    clientName: payment.invoice.client?.name || 'Customer',
    clientEmail,
    methodLabel: formatPaymentMethodLabel(payment),
    receiptUrl: token ? `${appUrl}/pay/receipt/${encodeURIComponent(token)}` : '',
    invoiceUrl: payment.invoice.paymentToken
      ? `${appUrl}/portal/pay/${payment.invoice.id}?token=${encodeURIComponent(payment.invoice.paymentToken)}`
      : `${appUrl}/portal/pay/${payment.invoice.id}`,
  }
}

export function isPaymentReceiptTokenValid(
  payment: { receiptTokenExpiresAt: Date | null }
): boolean {
  if (!payment.receiptTokenExpiresAt) return true
  return payment.receiptTokenExpiresAt.getTime() > Date.now()
}

export async function loadPaymentReceiptContext(
  paymentId: string,
  tenantId: string
): Promise<PaymentReceiptContext | null> {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      invoice: { tenantId },
    },
    include: paymentReceiptInclude,
  })

  if (!payment?.invoice) return null

  const receiptToken = payment.receiptToken || randomToken()
  const receiptTokenExpiresAt =
    payment.receiptTokenExpiresAt || new Date(Date.now() + RECEIPT_TOKEN_TTL_MS)

  if (!payment.receiptToken) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { receiptToken, receiptTokenExpiresAt },
    })
  }

  return mapPaymentToReceiptContext(payment as PaymentWithReceiptInclude, {
    receiptToken,
    receiptTokenExpiresAt: payment.receiptTokenExpiresAt || receiptTokenExpiresAt,
  })
}

export async function loadPaymentReceiptContextByToken(
  receiptToken: string
): Promise<PaymentReceiptContext | null> {
  const token = String(receiptToken || '').trim()
  if (!token) return null

  const payment = await prisma.payment.findFirst({
    where: { receiptToken: token },
    include: paymentReceiptInclude,
  })

  if (!payment?.invoice) return null
  if (!isPaymentReceiptTokenValid(payment)) return null

  return mapPaymentToReceiptContext(payment as PaymentWithReceiptInclude)
}

export function buildPaymentReceiptHtml(ctx: PaymentReceiptContext, logoUrl?: string | null) {
  const paidAt = ctx.payment.processedAt || ctx.payment.createdAt
  const paymentId =
    ctx.payment.providerPaymentId || ctx.payment.reference || ctx.payment.id.slice(0, 12)

  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="Logo" style="max-height:56px;max-width:200px;margin-bottom:12px;" />`
    : `<div style="font-size:22px;font-weight:800;color:#1e4d6e;margin-bottom:8px;">${escapeHtml(ctx.tenantName)}</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Payment Receipt — ${escapeHtml(ctx.invoice.invoiceNumber)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 0; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; }
    .header { background: #f8fafc; padding: 24px; border-bottom: 1px solid #e5e7eb; }
    .body { padding: 24px; }
    .amount { font-size: 32px; font-weight: 800; color: #1e4d6e; margin: 8px 0 0; }
    table.details { width: 100%; border-collapse: collapse; margin-top: 20px; }
    table.details td { padding: 10px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; vertical-align: top; }
    table.details td.label { color: #6b7280; width: 40%; font-weight: 600; }
    table.details td.value { text-align: right; font-weight: 600; }
    .footer { margin-top: 24px; font-size: 12px; color: #6b7280; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="header">
        ${logoBlock}
        <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;">Payment Receipt</div>
        <div class="amount">${escapeHtml(formatMoney(ctx.payment.amount))}</div>
        <div style="font-size:13px;color:#64748b;margin-top:6px;">Invoice ${escapeHtml(ctx.invoice.invoiceNumber)}</div>
      </div>
      <div class="body">
        <table class="details">
          <tr><td class="label">Customer</td><td class="value">${escapeHtml(ctx.clientName)}</td></tr>
          <tr><td class="label">Payment Date</td><td class="value">${escapeHtml(formatReceiptDate(paidAt))}</td></tr>
          <tr><td class="label">Payment Method</td><td class="value">${escapeHtml(ctx.methodLabel)}</td></tr>
          <tr><td class="label">Payment ID</td><td class="value">${escapeHtml(paymentId)}</td></tr>
          ${
            ctx.payment.providerInvoiceId
              ? `<tr><td class="label">Provider Invoice ID</td><td class="value">${escapeHtml(ctx.payment.providerInvoiceId)}</td></tr>`
              : ''
          }
          ${
            ctx.payment.reference
              ? `<tr><td class="label">Reference</td><td class="value">${escapeHtml(ctx.payment.reference)}</td></tr>`
              : ''
          }
        </table>
      </div>
    </div>
    <p class="footer">Thank you for your business — ${escapeHtml(ctx.tenantName)}</p>
  </div>
</body>
</html>`
}

async function buildPaymentReceiptPdfFromContext(ctx: PaymentReceiptContext) {
  const brand = await getPdfBranding(ctx.invoice.tenantId)
  const html = buildPaymentReceiptHtml(ctx, brand.logoUrl)
  return {
    buffer: await renderPdfFromHtml(html, { waitUntil: 'load' }),
    filename: `receipt-${ctx.invoice.invoiceNumber}-${ctx.payment.id.slice(0, 8)}.pdf`,
    html,
    ctx,
  }
}

export async function getPaymentReceiptHtmlByToken(receiptToken: string) {
  const ctx = await loadPaymentReceiptContextByToken(receiptToken)
  if (!ctx) return null

  const brand = await getPdfBranding(ctx.invoice.tenantId)
  return {
    html: buildPaymentReceiptHtml(ctx, brand.logoUrl),
    ctx,
  }
}

export async function generatePaymentReceiptPdf(paymentId: string, tenantId: string) {
  const ctx = await loadPaymentReceiptContext(paymentId, tenantId)
  if (!ctx) return null

  const result = await buildPaymentReceiptPdfFromContext(ctx)
  return {
    buffer: result.buffer,
    filename: result.filename,
    ctx: result.ctx,
  }
}

export async function generatePaymentReceiptPdfByToken(receiptToken: string) {
  const ctx = await loadPaymentReceiptContextByToken(receiptToken)
  if (!ctx) return null

  const result = await buildPaymentReceiptPdfFromContext(ctx)
  return {
    buffer: result.buffer,
    filename: result.filename,
    ctx: result.ctx,
  }
}

function resolveReceiptRecipients(options?: {
  to?: string
  emails?: string[] | string
}): string[] {
  const fromList = Array.isArray(options?.emails)
    ? options.emails
    : splitEmailList(options?.emails || '')
  const fromTo = splitEmailList(options?.to || '')
  const seen = new Set<string>()
  const unique: string[] = []
  for (const email of [...fromList, ...fromTo]) {
    const trimmed = String(email || '').trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

export async function sendPaymentReceiptForPayment(
  paymentId: string,
  tenantId: string,
  options?: { to?: string; emails?: string[] | string; forceResend?: boolean }
) {
  const ctx = await loadPaymentReceiptContext(paymentId, tenantId)
  if (!ctx) {
    return { sent: false, reason: 'payment_not_found' as const }
  }

  if (!options?.forceResend && ctx.payment.receiptEmailSentAt) {
    return { sent: false, reason: 'already_sent' as const, receiptUrl: ctx.receiptUrl }
  }

  const explicitRecipients = resolveReceiptRecipients(options)
  // Manual sends pass explicit recipients; automatic paths fall back to client email.
  const recipients =
    explicitRecipients.length > 0
      ? explicitRecipients
      : ctx.clientEmail
        ? [ctx.clientEmail]
        : []

  if (recipients.length === 0) {
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        receiptEmailAttempts: { increment: 1 },
        receiptEmailError: 'No recipient email found',
      },
    })
    return { sent: false, reason: 'missing_email' as const }
  }

  const branding = await getEmailBranding(tenantId)
  let pdfAttachment: Buffer | undefined
  let pdfFilename: string | undefined
  try {
    const pdf = await generatePaymentReceiptPdf(paymentId, tenantId)
    if (pdf) {
      pdfAttachment = pdf.buffer
      pdfFilename = pdf.filename
    }
  } catch (pdfError) {
    console.warn('Receipt PDF attachment skipped:', pdfError)
  }

  try {
    await sendPaymentReceiptEmail({
      to: recipients,
      tenantId,
      recipientName: ctx.clientName,
      invoiceNumber: ctx.invoice.invoiceNumber,
      amount: ctx.payment.amount,
      paidAt: ctx.payment.processedAt || ctx.payment.createdAt,
      reference: ctx.payment.reference,
      companyName: ctx.tenantName,
      invoiceUrl: ctx.invoiceUrl,
      receiptUrl: ctx.receiptUrl,
      paymentMethod: ctx.methodLabel,
      providerPaymentId: ctx.payment.providerPaymentId || ctx.payment.reference,
      providerInvoiceId: ctx.payment.providerInvoiceId,
      logoUrl: branding?.emailLogoUrl || branding?.webLogoUrl || null,
      pdfAttachment,
      pdfFilename,
    })

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        receiptEmailSentAt: new Date(),
        receiptEmailError: null,
        receiptEmailAttempts: { increment: 1 },
      },
    })

    return {
      sent: true,
      reason: 'sent' as const,
      sentTo: recipients.join(', '),
      receiptUrl: ctx.receiptUrl,
    }
  } catch (error: any) {
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        receiptEmailAttempts: { increment: 1 },
        receiptEmailError: error?.message || 'Unknown receipt send error',
      },
    })
    return {
      sent: false,
      reason: 'send_failed' as const,
      error: error?.message || 'send_failed',
    }
  }
}
