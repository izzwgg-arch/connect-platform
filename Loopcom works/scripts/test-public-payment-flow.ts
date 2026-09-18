import crypto from 'crypto'
import { prisma } from '@/lib/prisma'

function mask(value: string, keep = 4) {
  const v = String(value || '')
  if (v.length <= keep * 2) return '***'
  return `${v.slice(0, keep)}…${v.slice(-keep)}`
}

function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.APP_URL ||
    'https://app.trimprony.com'
  ).replace(/\/+$/, '')
}

function getPublicLinkSecret() {
  const secret = String(process.env.ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || '').trim()
  if (!secret) throw new Error('ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required')
  return secret
}

async function main() {
  const appUrl = getAppUrl()

  // Prefer a tenant that has SOLA configured.
  const solaConn = await prisma.integrationConnection.findFirst({
    where: { provider: 'sola', status: 'CONNECTED' },
    select: { tenantId: true },
  })

  const invoice = await prisma.invoice.findFirst({
    where: {
      tenantId: solaConn?.tenantId,
      balance: { gt: 0 },
      paymentToken: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      invoiceNumber: true,
      paymentToken: true,
      balance: true,
      tenantId: true,
    },
  })

  if (!invoice?.paymentToken) {
    throw new Error('No suitable invoice found (need balance>0 and paymentToken set). Send an invoice once to generate a token.')
  }

  const token = String(invoice.paymentToken)
  console.log('[PAYFLOW] Using invoice:', {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    tenantId: invoice.tenantId,
    token: mask(token),
  })

  // 1) Public invoice JSON (token gated)
  {
    const url = `${appUrl}/api/public/invoices/${invoice.id}?token=${encodeURIComponent(token)}`
    const res = await fetch(url)
    const data = await res.json().catch(() => ({}))
    console.log('[PAYFLOW] GET public invoice:', res.status, data?.invoice?.invoiceNumber || data?.error || '')
    if (!res.ok) throw new Error(`Public invoice fetch failed: ${res.status} ${(data && data.error) || ''}`.trim())
  }

  // 2) Public invoice PDF HTML (token gated)
  {
    const url = `${appUrl}/api/public/invoices/${invoice.id}/pdf?token=${encodeURIComponent(token)}&sent=${Date.now()}`
    const res = await fetch(url)
    const text = await res.text()
    console.log('[PAYFLOW] GET public invoice pdf:', res.status, `len=${text.length}`)
    if (!res.ok) throw new Error(`Public invoice PDF failed: ${res.status}`)
    if (!text.toLowerCase().includes('<html')) throw new Error('Public invoice PDF did not return HTML')
  }

  // 3) Create payment link via public endpoint used by portal (/portal/pay/*)
  {
    const url = `${appUrl}/api/public/invoices/${invoice.id}/payment-link`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const data = await res.json().catch(() => ({}))
    console.log('[PAYFLOW] POST public payment-link:', res.status, data?.paymentUrl ? `paymentUrl=${data.paymentUrl}` : data?.error || '')
    if (!res.ok) throw new Error(`Public payment-link failed: ${res.status} ${(data && data.error) || ''}`.trim())
    if (!data?.paymentUrl) throw new Error('Public payment-link response missing paymentUrl')
  }

  // 4) Signed public Estimate PDF (from estimate email flow)
  const estimate = await prisma.estimate.findFirst({
    where: {
      tenantId: invoice.tenantId,
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, estimateNumber: true },
  })
  if (estimate?.id) {
    const sent = Date.now()
    const sig = crypto
      .createHmac('sha256', getPublicLinkSecret())
      .update(`${estimate.id}.${sent}`)
      .digest('hex')
    const url = `${appUrl}/api/public/estimates/${estimate.id}/pdf?sent=${sent}&sig=${sig}`
    const res = await fetch(url)
    const text = await res.text()
    console.log('[PAYFLOW] GET public estimate pdf:', res.status, estimate.estimateNumber, `len=${text.length}`)
    if (!res.ok) throw new Error(`Public estimate PDF failed: ${res.status}`)
    if (!text.toLowerCase().includes('<html')) throw new Error('Public estimate PDF did not return HTML')
  } else {
    console.log('[PAYFLOW] No estimate found for tenant; skipping estimate PDF test')
  }

  console.log('[PAYFLOW] OK')
}

main()
  .catch((err) => {
    console.error('[PAYFLOW] FAIL:', err?.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

