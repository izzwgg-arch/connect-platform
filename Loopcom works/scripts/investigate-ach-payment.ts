/**
 * Investigate a QuickBooks ACH payment that did not sync into TrimPro.
 *
 * Usage:
 *   npx tsx scripts/investigate-ach-payment.ts INV-000329
 *   npx tsx scripts/investigate-ach-payment.ts --public-token <token>
 *   npx tsx scripts/investigate-ach-payment.ts INV-000329 --reconcile
 */
/* eslint-disable no-console */

import { prisma } from '../lib/prisma'
import { getQboSessionForTenant } from '../lib/qbo/session'
import { quickBooksService } from '../lib/services/quickbooks'
import { reconcileSingleInvoiceAchPayment } from '../lib/qbo/reconcile-ach'

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return null
  return String(process.argv[idx + 1] || '').trim() || null
}

async function main() {
  const invoiceNumber = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1])
  const publicToken = argValue('--public-token')
  const shouldReconcile = process.argv.includes('--reconcile')

  if (!invoiceNumber && !publicToken) {
    console.error(
      'Usage: npx tsx scripts/investigate-ach-payment.ts <invoiceNumber> [--reconcile]\n' +
        '   or: npx tsx scripts/investigate-ach-payment.ts --public-token <token> [--reconcile]'
    )
    process.exit(2)
  }

  let invoiceId: string | null = null

  if (publicToken) {
    const intent = await prisma.invoicePaymentIntent.findFirst({
      where: { publicToken, provider: 'qbo', method: 'ach' },
      select: { invoiceId: true, status: true, hostedUrl: true, createdAt: true, returnTokenUsedAt: true },
    })
    console.log('\n=== Payment intent (by public token) ===')
    console.log(intent)
    invoiceId = intent?.invoiceId || null
  }

  const invoice = await prisma.invoice.findFirst({
    where: invoiceId ? { id: invoiceId } : { invoiceNumber: String(invoiceNumber) },
    select: {
      id: true,
      tenantId: true,
      invoiceNumber: true,
      status: true,
      total: true,
      paidAmount: true,
      balance: true,
      qboSyncId: true,
      qboAchEnabled: true,
      updatedAt: true,
      client: { select: { name: true, email: true } },
    },
  })

  console.log('\n=== Invoice (TrimPro) ===')
  console.log(invoice)
  if (!invoice) {
    console.error('Invoice not found')
    process.exit(1)
  }

  const intents = await prisma.invoicePaymentIntent.findMany({
    where: { invoiceId: invoice.id, provider: 'qbo', method: 'ach' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      status: true,
      publicToken: true,
      hostedUrl: true,
      qboPaymentId: true,
      returnTokenUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  console.log('\n=== ACH payment intents ===')
  console.log(intents)

  const payments = await prisma.payment.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      amount: true,
      method: true,
      status: true,
      provider: true,
      providerPaymentId: true,
      reference: true,
      receiptEmailSentAt: true,
      receiptEmailAttempts: true,
      receiptEmailError: true,
      processedAt: true,
      createdAt: true,
    },
  })
  console.log('\n=== Payments on invoice ===')
  console.log(payments)

  const notifications = await prisma.notification.findMany({
    where: {
      tenantId: invoice.tenantId,
      type: 'PAYMENT_RECEIVED',
      linkId: invoice.id,
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, title: true, status: true, createdAt: true, userId: true },
  })
  console.log('\n=== PAYMENT_RECEIVED notifications ===')
  console.log(notifications.length ? notifications : '(none)')

  const since = new Date(Date.now() - 1000 * 60 * 60 * 48)
  const webhooks = await prisma.webhookEvent.findMany({
    where: {
      tenantId: invoice.tenantId,
      provider: 'quickbooks',
      receivedAt: { gte: since },
    },
    orderBy: { receivedAt: 'desc' },
    take: 30,
    select: {
      eventId: true,
      eventType: true,
      receivedAt: true,
      processed: true,
      processedAt: true,
      error: true,
    },
  })
  console.log('\n=== QuickBooks webhooks (last 48h, tenant) ===')
  console.log(webhooks.length ? webhooks : '(none)')

  const paymentEvents = await prisma.paymentEvent.findMany({
    where: {
      tenantId: invoice.tenantId,
      intent: { invoiceId: invoice.id },
    },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: {
      type: true,
      statusFrom: true,
      statusTo: true,
      providerEventId: true,
      createdAt: true,
      rawPayload: true,
    },
  })
  console.log('\n=== Payment events (intent audit) ===')
  for (const e of paymentEvents) {
    const payload = e.rawPayload as Record<string, unknown> | null
    console.log({
      type: e.type,
      statusFrom: e.statusFrom,
      statusTo: e.statusTo,
      providerEventId: e.providerEventId,
      createdAt: e.createdAt,
      source: payload && typeof payload === 'object' ? (payload as any).source : undefined,
      skippedReason:
        payload && typeof payload === 'object' ? (payload as any).skippedReason : undefined,
      appliedAmount:
        payload && typeof payload === 'object' ? (payload as any).appliedAmount : undefined,
    })
  }

  const qboIntegration = await prisma.quickBooksIntegration.findFirst({
    where: { tenantId: invoice.tenantId },
    select: {
      isConnected: true,
      realmId: true,
      reconcileLastAt: true,
    },
  })
  console.log('\n=== QuickBooks integration ===')
  console.log(qboIntegration)

  if (invoice.qboSyncId) {
    const session = await getQboSessionForTenant(invoice.tenantId)
    if (session) {
      try {
        const qboRes = await quickBooksService.makeAPIRequest(
          session.accessToken,
          session.realmId,
          `/invoice/${invoice.qboSyncId}`,
          'GET',
          undefined,
          {
            tenantId: invoice.tenantId,
            entityType: 'invoice',
            entityId: invoice.id,
            triggerSource: 'investigate_ach_payment',
          }
        )
        const qboInv = qboRes?.Invoice
        const qboBalance = Number(qboInv?.Balance ?? qboInv?.BalanceAmt ?? NaN)
        console.log('\n=== QuickBooks invoice (live) ===')
        console.log({
          qboSyncId: invoice.qboSyncId,
          qboBalance: Number.isFinite(qboBalance) ? qboBalance : null,
          trimproBalance: Number(invoice.balance),
          deltaIfQboLower: Number.isFinite(qboBalance)
            ? Math.max(0, Number(invoice.balance) - qboBalance)
            : null,
        })
      } catch (e: any) {
        console.error('\n=== QuickBooks invoice fetch FAILED ===')
        console.error(e?.message || e)
      }
    } else {
      console.log('\n=== QuickBooks session: NOT AVAILABLE ===')
    }
  } else {
    console.log('\n=== No qboSyncId — reconcile/webhook payment apply will not work ===')
  }

  console.log('\n=== Diagnosis hints ===')
  if (Number(invoice.balance) > 0 && intents.some((i) => i.status === 'LINK_CREATED')) {
    console.log('- Intent still LINK_CREATED: TrimPro never recorded payment success.')
  }
  if (payments.length === 0) {
    console.log('- No local Payment rows: webhook likely missed or failed; reconcile may fix if QBO balance is 0.')
  }
  if (notifications.length === 0 && payments.length === 0) {
    console.log('- No notification: expected until a Payment is created in TrimPro.')
  }
  const failedWebhooks = webhooks.filter((w) => w.error || w.processed === false)
  if (failedWebhooks.length) {
    console.log(`- ${failedWebhooks.length} webhook(s) with errors in last 48h — check processed/error fields above.`)
  }
  if (!webhooks.length) {
    console.log('- No recent webhooks: verify Intuit app webhook URL + QBO_WEBHOOK_VERIFIER_TOKEN in production.')
  }

  if (shouldReconcile) {
    console.log('\n=== Running reconcile (--reconcile) ===')
    await reconcileSingleInvoiceAchPayment(invoice.id, { source: 'investigate_script' })
    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      select: { status: true, balance: true, paidAmount: true },
    })
    console.log('Invoice after reconcile:', after)
  } else if (Number(invoice.balance) > 0) {
    console.log('\nTo apply payment from QBO if balance there is $0, re-run with: --reconcile')
    console.log('Or POST /api/integrations/quickbooks/sync-balances as ADMIN in the app.')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
