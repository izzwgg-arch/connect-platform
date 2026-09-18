/* eslint-disable no-console */
import { prisma } from '../lib/prisma'

async function main() {
  const invoiceNumber = String(process.argv[2] || '').trim()
  if (!invoiceNumber) {
    console.error('Usage: npx tsx scripts/check-ach-state.ts <invoiceNumber>')
    process.exit(2)
  }

  const invoice = await prisma.invoice.findFirst({
    where: { invoiceNumber },
    select: {
      id: true,
      tenantId: true,
      invoiceNumber: true,
      status: true,
      total: true,
      paidAmount: true,
      balance: true,
      qboSyncId: true,
      updatedAt: true,
    },
  })
  console.log('invoice', invoice)
  if (!invoice) return

  const payments = await prisma.payment.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      amount: true,
      method: true,
      status: true,
      reference: true,
      processedAt: true,
      createdAt: true,
    },
  })
  console.log('payments', payments)

  const notifications = await prisma.notification.findMany({
    where: {
      tenantId: invoice.tenantId,
      type: 'PAYMENT_RECEIVED',
      linkId: invoice.id,
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      title: true,
      message: true,
      status: true,
      createdAt: true,
      userId: true,
    },
  })
  console.log('payment_notifications', notifications)

  const paymentTx = await prisma.paymentTransaction.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      provider: true,
      status: true,
      amount: true,
      externalId: true,
      createdAt: true,
    },
  })
  console.log('payment_transactions', paymentTx)

  const intents = await prisma.invoicePaymentIntent.findMany({
    where: { invoiceId: invoice.id, provider: 'qbo', method: 'ach' },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { id: true, status: true, publicToken: true, qboPaymentId: true, createdAt: true },
  })
  console.log('ach_intents', intents)

  const qbPayments = payments.filter((p) => p.reference?.startsWith('qbo_'))
  console.log(
    'receipt_status',
    qbPayments.length
      ? await prisma.payment.findMany({
          where: { id: { in: qbPayments.map((p) => p.id) } },
          select: {
            id: true,
            receiptEmailSentAt: true,
            receiptEmailError: true,
            receiptEmailAttempts: true,
          },
        })
      : '(no quickbooks payments)'
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

