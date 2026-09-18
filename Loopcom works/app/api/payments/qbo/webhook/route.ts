import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyIntuitWebhookSignature, hashPayload } from '@/lib/qbo/webhook'
import { rateLimitOrThrow } from '@/lib/security/rate-limit'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'
import { notifyInvoicePaid } from '@/lib/notifications'
import { sendPaymentReceiptIfNeeded } from '@/lib/qbo/receipts'
import { reconcileSingleInvoiceAchPayment } from '@/lib/qbo/reconcile-ach'
import { afterInvoicePayment } from '@/lib/payments/after-invoice-payment'
import { applyInvoicePayment as applyPaymentCore } from '@/lib/payments/apply-payment'
import {
  fetchQboPaymentMethodName,
  mapInboundQboPaymentMethodFromName,
  recordPaymentQboMapping,
} from '@/lib/qbo/payment-method-mapping'

export const dynamic = 'force-dynamic'

function moneyToNumber(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function logWebhook(event: string, payload: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      area: 'qbo_webhook',
      event,
      ...payload,
    })
  )
}

async function applyInvoicePayment(params: {
  tenantId: string
  invoiceId: string
  amount: number
  providerPaymentId: string
  providerInvoiceId?: string
  providerRealmId?: string
  reference: string
  rawEvent: any
  method?: 'CARD' | 'CHECK' | 'CASH' | 'ACH' | 'BANK_TRANSFER' | 'OTHER'
  notes?: string | null
}) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, tenantId: params.tenantId },
    include: {
      client: { select: { name: true } },
    },
  })
  if (!invoice) return

  // Idempotency: provider + providerPaymentId is unique.
  const existing = await prisma.payment.findFirst({
    where: {
      provider: 'quickbooks',
      providerPaymentId: params.providerPaymentId,
    },
  })
  if (existing) {
    logWebhook('payment_already_applied', {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      providerPaymentId: params.providerPaymentId,
      existingPaymentId: existing.id,
    })
    await recordPaymentQboMapping({
      tenantId: params.tenantId,
      localPaymentId: existing.id,
      qboPaymentId: params.providerPaymentId,
    })
    await notifyInvoicePaid(
      params.tenantId,
      invoice.id,
      invoice.invoiceNumber,
      Number(existing.amount || 0),
      invoice.client?.name || 'Customer',
      {
        paymentMethod: existing.method || 'ACH',
        providerPaymentId: params.providerPaymentId,
        dedupeKey: `payment-received:${params.tenantId}:${invoice.id}:${params.providerPaymentId}`,
      }
    )
    return existing.id
  }

  let createdPaymentId: string | null = null
  let amount = 0

  await prisma.$transaction(async (tx) => {
    const res = await applyPaymentCore(
      {
        invoiceId: invoice.id,
        amount: params.amount,
        method: params.method || 'ACH',
        provider: 'quickbooks',
        reference: params.reference,
        providerPaymentId: params.providerPaymentId,
        providerInvoiceId: params.providerInvoiceId || null,
        providerRealmId: params.providerRealmId || null,
        rawPayload: params.rawEvent ?? undefined,
        processedAt: new Date(),
        notes: params.notes || 'QuickBooks payment',
        dedupeWhere: { provider: 'quickbooks', providerPaymentId: params.providerPaymentId },
      },
      { tx }
    )
    if (!res.created || !res.paymentId || !res.invoice) return
    createdPaymentId = res.paymentId
    amount = Math.max(0, Number(res.invoice.paidAmount) - Number(invoice.paidAmount))

    await tx.paymentTransaction.create({
      data: {
        tenantId: params.tenantId,
        provider: 'qbo_ach',
        status: 'succeeded',
        amount: amount as any,
        currency: 'USD',
        externalId: params.reference,
        invoiceId: invoice.id,
        rawEvent: params.rawEvent ?? undefined,
        metadata: { source: 'qbo_webhook', providerPaymentId: params.providerPaymentId },
      },
    })
  })

  if (!createdPaymentId || amount <= 0) return createdPaymentId

  if (createdPaymentId) {
    await recordPaymentQboMapping({
      tenantId: params.tenantId,
      localPaymentId: createdPaymentId,
      qboPaymentId: params.providerPaymentId,
    })
  }

  const paymentMethodLabel =
    params.method === 'ACH'
      ? 'ACH'
      : params.method === 'CARD'
        ? 'Card'
        : params.method === 'CHECK'
          ? 'Check'
          : params.method === 'CASH'
            ? 'Cash'
            : params.notes?.replace(/^QuickBooks — /i, '') || 'QuickBooks'

  await notifyInvoicePaid(
    params.tenantId,
    invoice.id,
    invoice.invoiceNumber,
    amount,
    invoice.client?.name || 'Customer',
    {
      paymentMethod: paymentMethodLabel,
      providerPaymentId: params.providerPaymentId,
      dedupeKey: `payment-received:${params.tenantId}:${invoice.id}:${params.providerPaymentId}`,
    }
  )

  if (createdPaymentId) {
    await afterInvoicePayment(invoice.id).catch((error) => {
      console.error('[qbo-webhook] afterInvoicePayment failed:', { invoiceId: invoice.id, error })
    })
  }

  return createdPaymentId
}

async function processPaymentEntity(params: {
  tenantId: string
  realmId: string
  paymentId: string
  providerEventId: string
  payload: any
}) {
  const session = await getQboSessionForTenant(params.tenantId)
  if (!session) throw new Error('QBO session missing for tenant')

  const paymentRes = await quickBooksService.makeAPIRequest(
    session.accessToken,
    session.realmId,
    `/payment/${params.paymentId}`,
    'GET',
    undefined,
    {
      tenantId: params.tenantId,
      entityType: 'payment',
      entityId: params.paymentId,
      triggerSource: 'qbo_webhook',
    }
  )
  const payment = paymentRes?.Payment
  const totalAmt = moneyToNumber(payment?.TotalAmt)
  const lines: any[] = Array.isArray(payment?.Line) ? payment.Line : []
  const linked = lines.flatMap((l) => (Array.isArray(l?.LinkedTxn) ? l.LinkedTxn : []))
  const linkedInvoices = linked.filter((t) => String(t?.TxnType || '').toLowerCase() === 'invoice')

  let qboMethodName: string | null = null
  const paymentMethodRefId = String(payment?.PaymentMethodRef?.value || '')
  if (paymentMethodRefId) {
    qboMethodName = await fetchQboPaymentMethodName({
      tenantId: params.tenantId,
      paymentId: params.paymentId,
      accessToken: session.accessToken,
      realmId: session.realmId,
      paymentMethodRefId,
    })
  }
  const inboundMethod = mapInboundQboPaymentMethodFromName(qboMethodName)

  logWebhook('payment_canonical_fetched', {
    tenantId: params.tenantId,
    realmId: params.realmId,
    paymentId: params.paymentId,
    linkedInvoiceCount: linkedInvoices.length,
    qboPaymentMethod: qboMethodName,
    mappedMethod: inboundMethod.method,
  })

  for (const li of linkedInvoices) {
    const qboInvoiceId = String(li?.TxnId || '')
    if (!qboInvoiceId) continue
    const localInvoice = await prisma.invoice.findFirst({
      where: { tenantId: params.tenantId, qboSyncId: qboInvoiceId },
      select: { id: true },
    })
    if (!localInvoice?.id) {
      logWebhook('payment_invoice_mapping_missing', {
        tenantId: params.tenantId,
        realmId: params.realmId,
        paymentId: params.paymentId,
        qboInvoiceId,
      })
      continue
    }

    const lineAmount = moneyToNumber(li?.Amount ?? totalAmt)
    const createdPaymentId = await applyInvoicePayment({
      tenantId: params.tenantId,
      invoiceId: localInvoice.id,
      amount: lineAmount,
      providerPaymentId: params.paymentId,
      providerInvoiceId: qboInvoiceId,
      providerRealmId: params.realmId,
      reference: `qbo_payment_${params.paymentId}`,
      rawEvent: params.payload,
      method: inboundMethod.method,
      notes: inboundMethod.notes,
    })

    await prisma.invoicePaymentIntent.updateMany({
      where: {
        tenantId: params.tenantId,
        invoiceId: localInvoice.id,
        provider: 'qbo',
        method: 'ach',
        status: { in: ['CREATED', 'LINK_CREATED', 'PENDING'] as any },
      },
      data: {
        status: 'SUCCEEDED',
        qboPaymentId: params.paymentId,
      },
    })

    if (createdPaymentId) {
      const receiptResult = await sendPaymentReceiptIfNeeded(createdPaymentId)
      logWebhook('receipt_send_attempted', {
        tenantId: params.tenantId,
        invoiceId: localInvoice.id,
        paymentId: createdPaymentId,
        providerPaymentId: params.paymentId,
        sent: receiptResult.sent,
        reason: receiptResult.reason,
      })
    }

    const intent = await prisma.invoicePaymentIntent.findFirst({
      where: {
        tenantId: params.tenantId,
        invoiceId: localInvoice.id,
        provider: 'qbo',
        method: 'ach',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (intent?.id) {
      await prisma.paymentEvent.create({
        data: {
          tenantId: params.tenantId,
          intentId: intent.id,
          provider: 'qbo',
          providerEventId: params.providerEventId,
          type: 'webhook',
          statusFrom: 'PENDING',
          statusTo: 'SUCCEEDED',
          payloadHash: hashPayload(JSON.stringify(params.payload || {})),
          rawPayload: params.payload,
        },
      }).catch(() => undefined)
    }
  }
}

async function processInvoiceEntity(params: {
  tenantId: string
  realmId: string
  invoiceId: string
}) {
  const session = await getQboSessionForTenant(params.tenantId)
  if (!session) throw new Error('QBO session missing for tenant')
  const invoiceRes = await quickBooksService.makeAPIRequest(
    session.accessToken,
    session.realmId,
    `/invoice/${params.invoiceId}`,
    'GET',
    undefined,
    {
      tenantId: params.tenantId,
      entityType: 'invoice',
      entityId: params.invoiceId,
      triggerSource: 'qbo_webhook',
    }
  )
  const qboInvoice = invoiceRes?.Invoice
  const qboBalance = moneyToNumber(qboInvoice?.Balance ?? qboInvoice?.BalanceAmt)

  const localInvoice = await prisma.invoice.findFirst({
    where: { tenantId: params.tenantId, qboSyncId: params.invoiceId },
    select: { id: true, balance: true },
  })
  if (!localInvoice?.id) {
    logWebhook('invoice_mapping_missing', {
      tenantId: params.tenantId,
      realmId: params.realmId,
      qboInvoiceId: params.invoiceId,
    })
    return
  }

  // Always reconcile on any QB invoice update — this captures partial payments,
  // checks, and any other payment method recorded directly in QuickBooks.
  // reconcileSingleInvoiceAchPayment already handles the delta safely (idempotent).
  await reconcileSingleInvoiceAchPayment(localInvoice.id, {
    qboInvoice,
    source: 'qbo_webhook',
  })

  if (qboBalance <= 0) {
    // Mark any open ACH payment intents as succeeded when QB confirms full payment.
    await prisma.invoicePaymentIntent.updateMany({
      where: {
        tenantId: params.tenantId,
        invoiceId: localInvoice.id,
        provider: 'qbo',
        method: 'ach',
        status: { in: ['CREATED', 'LINK_CREATED', 'PENDING'] as any },
      },
      data: { status: 'SUCCEEDED' },
    })
  }

  logWebhook('invoice_canonical_fetched', {
    tenantId: params.tenantId,
    realmId: params.realmId,
    qboInvoiceId: params.invoiceId,
    qboBalance,
    localInvoiceId: localInvoice.id,
    localBalanceBefore: Number(localInvoice.balance),
  })
}

export async function POST(request: NextRequest) {
  try {
    rateLimitOrThrow(request, { key: 'qbo-webhook', limit: 120, windowMs: 60_000 })
  } catch (res: any) {
    return res
  }

  const rawBody = await request.text()
  const signature = request.headers.get('intuit-signature')
  const verifierToken = process.env.QBO_WEBHOOK_VERIFIER_TOKEN

  const ok = verifyIntuitWebhookSignature({ rawBody, signatureHeader: signature, verifierToken })
  if (!ok) {
    logWebhook('signature_invalid', { hasSignature: Boolean(signature) })
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }
  logWebhook('signature_valid', { hasSignature: Boolean(signature) })

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const payloadHash = hashPayload(rawBody)

  const notifications: any[] = Array.isArray(payload?.eventNotifications) ? payload.eventNotifications : []
  for (const n of notifications) {
    const realmId = String(n?.realmId || '')
    if (!realmId) continue

    // Find the tenant for this realm.
    const qboRow = await prisma.quickBooksIntegration.findFirst({
      where: { realmId, isConnected: true },
      select: { tenantId: true },
    })
    if (!qboRow?.tenantId) continue

    const dataChange = n?.dataChangeEvent
    const entities: any[] = Array.isArray(dataChange?.entities) ? dataChange.entities : []

    for (const e of entities) {
      const name = String(e?.name || e?.entityName || '')
      const id = String(e?.id || '')
      const operation = String(e?.operation || '')
      const seq = String(e?.sequenceNumber || '')

      const providerEventId = `qbo:${realmId}:${name}:${id}:${operation}:${seq}`
      logWebhook('entity_received', {
        tenantId: qboRow.tenantId,
        realmId,
        providerEventId,
        entityName: name,
        entityId: id,
        operation,
      })

      // Store webhook event for idempotency + audit.
      const already = await prisma.webhookEvent.findUnique({
        where: { eventId: providerEventId },
        select: { id: true },
      })
      if (already) continue

      const webhookRow = await prisma.webhookEvent.create({
        data: {
          tenantId: qboRow.tenantId,
          provider: 'quickbooks',
          eventId: providerEventId,
          eventType: name || 'unknown',
          rawPayload: payload,
          payloadHash,
          processed: false,
        },
      })

      try {
        if (name.toLowerCase() === 'payment' && id) {
          await processPaymentEntity({
            tenantId: qboRow.tenantId,
            realmId,
            paymentId: id,
            providerEventId,
            payload,
          })
        } else if (name.toLowerCase() === 'invoice' && id) {
          await processInvoiceEntity({
            tenantId: qboRow.tenantId,
            realmId,
            invoiceId: id,
          })
        }

        await prisma.webhookEvent.update({
          where: { id: webhookRow.id },
          data: { processed: true, processedAt: new Date(), error: null },
        })
        logWebhook('entity_processed', {
          tenantId: qboRow.tenantId,
          realmId,
          providerEventId,
          processed: true,
        })
      } catch (err: any) {
        await prisma.webhookEvent.update({
          where: { id: webhookRow.id },
          data: { processed: false, processedAt: new Date(), error: err?.message || 'Webhook processing failed' },
        })
        logWebhook('entity_processed', {
          tenantId: qboRow.tenantId,
          realmId,
          providerEventId,
          processed: false,
          error: err?.message || 'Webhook processing failed',
        })
      }
    }
  }

  return NextResponse.json({ ok: true })
}

