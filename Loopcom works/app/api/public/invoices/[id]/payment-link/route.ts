import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { solaService } from '@/lib/services/sola'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { parseAddressParts } from '@/lib/address/parse'
import { requireRecaptchaV3 } from '@/lib/security/recaptcha'
import {
  buildWaterfallPlannedAmounts,
  orderInvoicesDominantFirst,
  parsePerInvoiceAmountMap,
  parsePublicPaymentAmount,
  resolvePublicPaymentPlan,
} from '@/lib/payments/bulk-card-allocation'
import { buildCardknoxFallbackUrl } from '@/lib/services/cardknox-url'
import crypto from 'crypto'

function resolvePublicAppUrl(request?: NextRequest) {
  if (process.env.NODE_ENV !== 'production' && request) {
    const origin = String(request.headers.get('origin') || '').trim()
    if (origin) return origin.replace(/\/+$/, '')
    const host = String(request.headers.get('x-forwarded-host') || request.headers.get('host') || '').trim()
    if (host && !host.includes('154.12.235.86')) {
      const proto = String(request.headers.get('x-forwarded-proto') || 'http').trim()
      return `${proto}://${host}`.replace(/\/+$/, '')
    }
  }

  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    'https://app.trimprony.com',
  ]
  const blocked = /(localhost|127\.0\.0\.1|0\.0\.0\.0|154\.12\.235\.86)(:\d+)?/i
  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (!value) continue
    if (blocked.test(value)) continue
    return value.replace(/\/+$/, '')
  }
  return 'https://app.trimprony.com'
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json().catch(() => ({}))
    const token = String(body.token || '')
    const recaptchaToken = body.recaptchaToken
    const payAllOutstanding = Boolean(body.payAllOutstanding)
    const selectedInvoiceIdsRaw = Array.isArray(body?.selectedInvoiceIds) ? body.selectedInvoiceIds : null
    const selectedInvoiceIds =
      selectedInvoiceIdsRaw
        ? Array.from(new Set(selectedInvoiceIdsRaw.map((v: any) => String(v || '').trim()).filter(Boolean)))
        : []
    const customPrevOnly = Boolean(body?.customPrevOnly)
    const customPrevAmount = parsePublicPaymentAmount(body?.customPrevAmount)
    const perInvoiceAmounts = parsePerInvoiceAmountMap(body?.plannedAmountsByInvoice ?? body?.perInvoiceAmounts)
    const partialInvoiceId = String(body?.partialInvoiceId || '').trim()
    const partialLineItemIdsRaw = Array.isArray(body?.partialLineItemIds) ? body.partialLineItemIds : null
    const partialLineItemIds = partialLineItemIdsRaw
      ? Array.from(new Set(partialLineItemIdsRaw.map((v: any) => String(v || '').trim()).filter(Boolean)))
      : []
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    const captcha = await requireRecaptchaV3({
      request,
      token: recaptchaToken,
      expectedAction: 'public_invoice_pay_card',
    })
    if (captcha) return captcha

    // Authorize: token belongs to some invoice; then allow paying any invoice for the same client.
    const authInvoice = await prisma.invoice.findFirst({
      where: { paymentToken: token },
      select: { tenantId: true, clientId: true },
    })
    if (!authInvoice) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: authInvoice.tenantId,
        clientId: authInvoice.clientId,
      },
      include: {
        client: {
          include: {
            contacts: {
              where: { isPrimary: true },
              take: 1,
            },
            addresses: {
              orderBy: [{ isDefault: 'desc' }],
            },
          },
        },
        job: {
          include: {
            addresses: {
              where: { type: 'job_site' },
              take: 1,
            },
          },
        },
        estimate: {
          select: {
            jobSiteAddress: true,
          },
        },
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const openWhere = {
      tenantId: invoice.tenantId,
      clientId: invoice.clientId,
      balance: { gt: 0 },
      status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
    }

    let invoicesToPay: Array<{ id: string; balance: any; dueDate: any; invoiceDate: any; invoiceNumber: any; qboSyncId: any }> = []
    let plannedAmountsByInvoice: Record<string, number> | null = null
    let lineItemIdsByInvoice: Record<string, string[]> | null = null
    let allocationMode: 'waterfall' | 'planned' | null = null
    let maxTotalAmount: number | null = null

    if (partialInvoiceId && partialLineItemIds.length) {
      if (selectedInvoiceIds.length !== 1 || selectedInvoiceIds[0] !== partialInvoiceId) {
        return NextResponse.json({ error: 'Partial payments require selecting exactly one invoice.' }, { status: 400 })
      }

      const target = await prisma.invoice.findFirst({
        where: {
          id: partialInvoiceId,
          tenantId: invoice.tenantId,
          clientId: invoice.clientId,
        },
        select: { id: true, balance: true, invoiceNumber: true, qboSyncId: true },
      })
      if (!target) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
      if (Number(target.balance) <= 0) return NextResponse.json({ error: 'Invoice already paid' }, { status: 400 })

      const items = await prisma.invoiceLineItem.findMany({
        where: {
          invoiceId: partialInvoiceId,
          id: { in: partialLineItemIds },
        },
        select: { id: true, total: true },
      })
      const amount = items.reduce((sum, li) => sum + Math.max(0, Number(li.total || 0)), 0)
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: 'Select at least one line item to pay.' }, { status: 400 })
      }
      const capped = Math.min(amount, Number(target.balance))
      invoicesToPay = [{ id: partialInvoiceId, balance: capped, dueDate: null, invoiceDate: null, invoiceNumber: target.invoiceNumber, qboSyncId: target.qboSyncId }]
      plannedAmountsByInvoice = { [partialInvoiceId]: capped }
      lineItemIdsByInvoice = { [partialInvoiceId]: items.map((i) => i.id) }
      allocationMode = 'planned'
      maxTotalAmount = capped
    } else if (customPrevOnly || selectedInvoiceIds.length) {
      if (customPrevOnly && customPrevAmount == null && Object.keys(perInvoiceAmounts).length === 0) {
        return NextResponse.json({ error: 'Custom amount must be greater than 0.' }, { status: 400 })
      }

      let selectedRows: Array<{
        id: string
        balance: any
        dueDate: any
        invoiceDate: any
        invoiceNumber: any
        qboSyncId: any
      }> = []

      if (selectedInvoiceIds.length) {
        selectedRows = await prisma.invoice.findMany({
          where: {
            ...(openWhere as any),
            id: { in: selectedInvoiceIds },
          },
          select: { id: true, balance: true, dueDate: true, invoiceDate: true, invoiceNumber: true, qboSyncId: true },
        })
      } else {
        const allRows = await prisma.invoice.findMany({
          where: openWhere as any,
          select: { id: true, balance: true, dueDate: true, invoiceDate: true, invoiceNumber: true, qboSyncId: true },
        })
        selectedRows = orderInvoicesDominantFirst(invoice.id, allRows)
      }

      const plan = resolvePublicPaymentPlan(invoice.id, selectedRows, {
        perInvoiceAmounts,
        globalAmount: customPrevOnly ? customPrevAmount : null,
      })
      if ('error' in plan) {
        return NextResponse.json({ error: plan.error }, { status: 400 })
      }

      invoicesToPay = plan.invoices
      plannedAmountsByInvoice = plan.plannedAmountsByInvoice
      allocationMode = plan.mode === 'full' ? null : plan.mode
      maxTotalAmount = plan.maxTotalAmount
    } else if (payAllOutstanding) {
      const allRows = await prisma.invoice.findMany({
        where: openWhere as any,
        select: { id: true, balance: true, dueDate: true, invoiceDate: true, invoiceNumber: true, qboSyncId: true },
      })
      invoicesToPay = orderInvoicesDominantFirst(invoice.id, allRows)
    } else {
      invoicesToPay = [{ id: invoice.id, balance: invoice.balance, dueDate: invoice.dueDate, invoiceDate: invoice.invoiceDate, invoiceNumber: invoice.invoiceNumber, qboSyncId: invoice.qboSyncId }]
    }

    // Ensure we're only paying open invoices with balance > 0
    invoicesToPay = invoicesToPay.filter((i) => Number(i.balance) > 0)
    if (invoicesToPay.length > 1) {
      invoicesToPay = orderInvoicesDominantFirst(invoice.id, invoicesToPay)
    }
    const sumBalances = invoicesToPay.reduce((sum, i) => sum + Math.max(0, Number(i.balance || 0)), 0)
    const amountToPay = maxTotalAmount != null ? Math.min(maxTotalAmount, sumBalances) : sumBalances

    if (!Number.isFinite(amountToPay) || amountToPay <= 0) {
      return NextResponse.json({ error: 'Invoice already paid' }, { status: 400 })
    }

    const solaSecrets = await getIntegrationSecrets(invoice.tenantId, 'sola')
    const isDev = process.env.NODE_ENV !== 'production'
    if (!solaSecrets?.secretKey && !isDev) {
      return NextResponse.json({ error: 'Sola integration is not configured (missing secret key).' }, { status: 400 })
    }

    const appUrl = resolvePublicAppUrl(request)

    // Address priority: job site → estimate job site → client billing → any client address
    const jobAddress = invoice.job?.addresses?.[0]
    const estimateAddress = parseAddressParts(invoice.estimate?.jobSiteAddress)
    const billingAddress =
      invoice.client.addresses?.find((a) => a.type?.toUpperCase() === 'BILLING') ||
      invoice.client.addresses?.find((a) => a.isDefault) ||
      invoice.client.addresses?.[0]

    // Store selected invoice ids server-side (no URL bloat); reference is what comes back in xInvoice.
    const intentKey = `pp_${crypto.randomBytes(16).toString('hex')}`
    const invoiceNumbers = invoicesToPay.map((i) => i.invoiceNumber).filter(Boolean)
    const qboInvoiceIds = invoicesToPay.map((i) => i.qboSyncId).filter(Boolean)
    await prisma.idempotencyKey.create({
      data: {
        tenantId: invoice.tenantId,
        key: intentKey,
        scope: 'public_payment_intent',
        response: {
          clientId: invoice.clientId,
          dominantInvoiceId: invoice.id,
          invoiceIds: invoicesToPay.map((i) => i.id),
          invoiceNumbers,
          qboInvoiceIds,
          plannedAmountsByInvoice,
          lineItemIdsByInvoice,
          allocationMode,
          maxTotalAmount,
          createdAt: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
      } as any,
    })

    const ref = `TPINTENT:${intentKey}`

    // xInvoice shown to the customer on the Cardknox form:
    //   - Single full invoice  → real invoice number (webhook finds by number directly)
    //   - Multiple invoices    → comma-separated invoice numbers
    //   - Partial/line-item    → single invoice number
    // The intent key travels separately in xCustom1 so the webhook can always reconcile.
    const isSingleFullInvoice =
      invoicesToPay.length === 1 &&
      !plannedAmountsByInvoice &&
      allocationMode === null &&
      maxTotalAmount === null

    const xInvoiceRef =
      invoicesToPay.length > 1 && invoiceNumbers.length > 0
        ? invoiceNumbers.join(', ')
        : invoice.invoiceNumber

    const displayRef =
      invoicesToPay.length > 1
        ? invoiceNumbers.length > 0
          ? `Invoices ${invoiceNumbers.join(', ')}`
          : `Selected Invoices (${invoicesToPay.length})`
        : `Invoice ${invoice.invoiceNumber}`
    const description =
      invoicesToPay.length > 1
        ? invoiceNumbers.length > 0
          ? `Invoices ${invoiceNumbers.join(', ')} for ${invoice.client.name}`
          : `Selected invoices for ${invoice.client.name}`
        : `Invoice ${invoice.invoiceNumber} - ${invoice.title}`

    const paymentLinkRequest = {
      invoiceId: invoice.id,
      invoiceNumber: xInvoiceRef,
      intentRef: isSingleFullInvoice ? undefined : ref,
      amount: amountToPay,
      description: description,
      clientEmail: invoice.client.email || invoice.client.contacts?.[0]?.email || undefined,
      clientName: invoice.client.name,
      clientPhone: invoice.client.phone || invoice.client.contacts?.[0]?.phone || undefined,
      billingStreet: jobAddress?.street || estimateAddress?.street || billingAddress?.street || undefined,
      billingCity: jobAddress?.city || estimateAddress?.city || billingAddress?.city || undefined,
      billingState: jobAddress?.state || estimateAddress?.state || billingAddress?.state || undefined,
      billingZip: jobAddress?.zipCode || estimateAddress?.zipCode || billingAddress?.zipCode || undefined,
      billingCountry: jobAddress?.country || billingAddress?.country || 'US',
      returnUrl: `${appUrl}/portal/pay/${invoice.id}?token=${invoice.paymentToken || ''}`,
      webhookUrl: `${appUrl}/api/webhooks/sola-payment`,
      apiKey: solaSecrets?.secretKey,
    }

    let paymentUrl = ''
    let paymentId = invoice.id
    let expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()

    if (solaSecrets?.secretKey) {
      const paymentLink = await solaService.createPaymentLink(paymentLinkRequest)
      paymentUrl = paymentLink.url
      paymentId = paymentLink.id
      expiresAt = paymentLink.expiresAt
    } else {
      paymentUrl = buildCardknoxFallbackUrl(
        {
          invoiceRef: xInvoiceRef,
          amountStr: amountToPay.toFixed(2),
          description,
          intentRef: isSingleFullInvoice ? undefined : ref,
          clientName: invoice.client.name,
          clientEmail: invoice.client.email || invoice.client.contacts?.[0]?.email || undefined,
          clientPhone: invoice.client.phone || invoice.client.contacts?.[0]?.phone || undefined,
          billingStreet: jobAddress?.street || estimateAddress?.street || billingAddress?.street || undefined,
          billingCity: jobAddress?.city || estimateAddress?.city || billingAddress?.city || undefined,
          billingState: jobAddress?.state || estimateAddress?.state || billingAddress?.state || undefined,
          billingZip: jobAddress?.zipCode || estimateAddress?.zipCode || billingAddress?.zipCode || undefined,
          billingCountry: jobAddress?.country || billingAddress?.country || 'US',
          returnUrl: `${appUrl}/portal/pay/${invoice.id}?token=${invoice.paymentToken || ''}`,
          webhookUrl: `${appUrl}/api/webhooks/sola-payment`,
        },
        { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber }
      )
    }

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        solaPaymentUrl: paymentUrl || null,
        solaTransactionId: paymentId || null,
      },
    })

    return NextResponse.json({
      paymentUrl,
      paymentId,
      expiresAt,
      mode: invoicesToPay.length > 1 ? 'multi' : 'single',
      reference: ref,
      label: displayRef,
      amount: amountToPay,
      count: invoicesToPay.length,
    })
  } catch (error: any) {
    console.error('Public payment link error:', error)
    return NextResponse.json({ error: error.message || 'Failed to create payment link' }, { status: 500 })
  }
}

