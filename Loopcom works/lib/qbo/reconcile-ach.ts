import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'
import { notifyInvoicePaid } from '@/lib/notifications'
import { sendPaymentReceiptIfNeeded } from '@/lib/qbo/receipts'
import { afterInvoicePayment } from '@/lib/payments/after-invoice-payment'
import { applyInvoicePayment } from '@/lib/payments/apply-payment'

function toMoney(n: number) {
  return Math.round(n * 100) / 100
}

const PUBLIC_INVOICE_RECONCILE_COOLDOWN_MS = 2 * 60 * 1000
const PUBLIC_INVOICE_RETURN_RECONCILE_WINDOW_MS = 30 * 60 * 1000

async function getLatestQboAchIntent(invoiceId: string) {
  return prisma.invoicePaymentIntent.findFirst({
    where: {
      invoiceId,
      provider: 'qbo',
      method: 'ach',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      tenantId: true,
      invoiceId: true,
      status: true,
      returnTokenUsedAt: true,
      createdAt: true,
    },
  })
}

async function logReconcileAttempt(params: {
  intentId: string | null
  tenantId: string
  source: string
  appliedAmount: number
  skippedReason?: string | null
}) {
  if (!params.intentId) return
  await prisma.paymentEvent.create({
    data: {
      tenantId: params.tenantId,
      intentId: params.intentId,
      provider: 'qbo',
      type: 'reconcile',
      rawPayload: {
        source: params.source,
        appliedAmount: params.appliedAmount,
        skippedReason: params.skippedReason || null,
      },
    },
  }).catch(() => undefined)
}

export async function shouldAttemptPublicInvoiceReconcile(invoiceId: string): Promise<boolean> {
  const intent = await getLatestQboAchIntent(invoiceId)
  if (!intent) return false

  const isActiveIntent = ['CREATED', 'LINK_CREATED', 'PENDING'].includes(String(intent.status))
  const hasRecentReturn =
    intent.returnTokenUsedAt instanceof Date &&
    Date.now() - intent.returnTokenUsedAt.getTime() <= PUBLIC_INVOICE_RETURN_RECONCILE_WINDOW_MS

  if (!isActiveIntent && !hasRecentReturn) return false

  const latestReconcileEvent = await prisma.paymentEvent.findFirst({
    where: {
      tenantId: intent.tenantId,
      intentId: intent.id,
      provider: 'qbo',
      type: 'reconcile',
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })

  if (!latestReconcileEvent?.createdAt) return true
  return Date.now() - latestReconcileEvent.createdAt.getTime() >= PUBLIC_INVOICE_RECONCILE_COOLDOWN_MS
}

export async function reconcileTenantRecentAchPayments(tenantId: string): Promise<void> {
  const intents = await prisma.invoicePaymentIntent.findMany({
    where: {
      tenantId,
      provider: 'qbo',
      method: 'ach',
      status: { in: ['CREATED', 'LINK_CREATED', 'PENDING'] as any },
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { invoiceId: true },
  })

  const invoiceIds = Array.from(new Set(intents.map((i) => i.invoiceId).filter(Boolean)))
  for (const invoiceId of invoiceIds) {
    try {
      await reconcileSingleInvoiceAchPayment(invoiceId, { source: 'qbo_reconcile_sweep' })
    } catch (e) {
      console.error('[QBO ACH] Reconcile (tenant sweep) failed:', { tenantId, invoiceId, error: e })
    }
  }
}

export async function reconcileSingleInvoiceAchPayment(
  invoiceId: string,
  options?: { qboInvoice?: any; source?: string }
): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: {
        include: {
          contacts: {
            where: { email: { not: null } },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            take: 1,
          },
        },
      },
      tenant: { select: { name: true } },
    },
  })
  if (!invoice) return
  const localBalance = Number(invoice.balance || 0)
  if (localBalance <= 0 || !invoice.qboSyncId) return

  const latestIntent = await getLatestQboAchIntent(invoice.id)
  const source = options?.source || 'qbo_reconcile'
  const session = await getQboSessionForTenant(invoice.tenantId)
  if (!session) return

  const qboInvoice =
    options?.qboInvoice ||
    (
      await quickBooksService.makeAPIRequest(
        session.accessToken,
        session.realmId,
        `/invoice/${invoice.qboSyncId}`,
        'GET',
        undefined,
        {
          tenantId: invoice.tenantId,
          entityType: 'invoice',
          entityId: invoice.id,
          triggerSource: source,
        }
      )
    )?.Invoice
  const qboBalance = Number(qboInvoice?.Balance ?? qboInvoice?.BalanceAmt ?? NaN)
  if (!Number.isFinite(qboBalance)) {
    await logReconcileAttempt({
      intentId: latestIntent?.id || null,
      tenantId: invoice.tenantId,
      source,
      appliedAmount: 0,
      skippedReason: 'invalid_qbo_balance',
    })
    return
  }

  const baselineDelta = toMoney(localBalance - qboBalance)
  if (baselineDelta <= 0) {
    await logReconcileAttempt({
      intentId: latestIntent?.id || null,
      tenantId: invoice.tenantId,
      source,
      appliedAmount: 0,
      skippedReason: 'no_balance_delta',
    })
    return
  }

  const reference = `qbo_reconcile_${invoice.qboSyncId}_${qboBalance.toFixed(2)}`
  let appliedAmount = 0

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.invoice.findUnique({
        where: { id: invoice.id },
        select: { id: true, total: true, paidAmount: true, balance: true, status: true, paidAt: true },
      })
      if (!current) return

      const curBalance = Number(current.balance || 0)
      if (curBalance <= 0) return

      const delta = toMoney(curBalance - qboBalance)
      if (delta <= 0) return

      appliedAmount = Math.min(curBalance, delta)
      if (appliedAmount <= 0) return

      const res = await applyInvoicePayment(
        {
          invoiceId: current.id,
          amount: appliedAmount,
          method: 'ACH',
          provider: 'quickbooks',
          reference,
          providerPaymentId: reference,
          providerInvoiceId: invoice.qboSyncId || null,
          providerRealmId: session.realmId,
          processedAt: new Date(),
          notes: 'QuickBooks ACH reconcile',
          dedupeWhere: { reference },
        },
        { tx }
      )
      if (!res.created || !res.invoice) {
        appliedAmount = 0
        return
      }
      appliedAmount = Math.max(0, Number(res.invoice.paidAmount) - Number(current.paidAmount))

      await tx.paymentTransaction.create({
        data: {
          tenantId: invoice.tenantId,
          provider: 'qbo_ach',
          status: 'succeeded',
          amount: appliedAmount as any,
          currency: 'USD',
          externalId: reference,
          invoiceId: current.id,
          metadata: { source },
        },
      })
    })
  } catch (e: any) {
    // Reference is unique; ignore race duplicates.
    if (e?.code !== 'P2002') throw e
  }

  if (appliedAmount <= 0) {
    await logReconcileAttempt({
      intentId: latestIntent?.id || null,
      tenantId: invoice.tenantId,
      source,
      appliedAmount: 0,
      skippedReason: 'no_payment_applied',
    })
    return
  }

  await prisma.invoicePaymentIntent.updateMany({
    where: {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      provider: 'qbo',
      method: 'ach',
      status: { in: ['CREATED', 'LINK_CREATED', 'PENDING'] as any },
    },
    data: { status: 'SUCCEEDED' as any },
  })

  await logReconcileAttempt({
    intentId: latestIntent?.id || null,
    tenantId: invoice.tenantId,
    source,
    appliedAmount,
  })

  await notifyInvoicePaid(
    invoice.tenantId,
    invoice.id,
    invoice.invoiceNumber,
    appliedAmount,
    invoice.client?.name || 'Customer',
    {
      paymentMethod: 'ACH',
      providerPaymentId: reference,
      dedupeKey: `payment-received:${invoice.tenantId}:${invoice.id}:${reference}`,
    }
  )

  await afterInvoicePayment(invoice.id).catch((error) => {
    console.error('[qbo-reconcile-ach] afterInvoicePayment failed:', { invoiceId: invoice.id, error })
  })

  const payment = await prisma.payment.findFirst({
    where: {
      invoiceId: invoice.id,
      provider: 'quickbooks',
      providerPaymentId: reference,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (payment?.id) {
    const result = await sendPaymentReceiptIfNeeded(payment.id)
    if (!result.sent && result.reason !== 'already_sent' && result.reason !== 'already_processing') {
      console.error('[QBO ACH] Reconcile receipt send failed:', result)
    }
  }
}

