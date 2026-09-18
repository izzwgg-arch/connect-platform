import { prisma } from '@/lib/prisma'
import { sendPaymentReceiptForPayment } from '@/lib/payments/receipts'

export async function sendPaymentReceiptIfNeeded(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      receiptEmailSentAt: true,
      invoice: { select: { tenantId: true } },
    },
  })
  if (!payment?.invoice) {
    return { sent: false, reason: 'payment_not_found' as const }
  }
  if (payment.receiptEmailSentAt) {
    return { sent: false, reason: 'already_sent' as const }
  }

  const lockKey = `payment_receipt_send:${payment.id}`
  try {
    await prisma.idempotencyKey.create({
      data: {
        tenantId: payment.invoice.tenantId,
        key: lockKey,
        scope: 'payment_receipt_send',
        requestHash: lockKey,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })
  } catch {
    return { sent: false, reason: 'already_processing' as const }
  }

  try {
    return await sendPaymentReceiptForPayment(paymentId, payment.invoice.tenantId)
  } finally {
    await prisma.idempotencyKey.deleteMany({ where: { key: lockKey } }).catch(() => undefined)
  }
}

export async function retryPendingPaymentReceipts(limit = 50) {
  const rows = await prisma.payment.findMany({
    where: {
      provider: 'quickbooks',
      status: 'COMPLETED',
      receiptEmailSentAt: null,
      receiptEmailAttempts: { lt: 10 },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true, invoice: { select: { tenantId: true } } },
  })

  let sent = 0
  let failed = 0
  for (const row of rows) {
    if (!row.invoice) {
      failed += 1
      continue
    }
    const result = await sendPaymentReceiptForPayment(row.id, row.invoice.tenantId)
    if (result.sent) sent += 1
    else failed += 1
  }

  return { scanned: rows.length, sent, failed }
}
