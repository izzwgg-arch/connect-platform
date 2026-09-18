import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

const bulkPayments = await p.payment.findMany({
  where: {
    createdAt: { gte: since },
    OR: [
      { solaTransactionId: { contains: ':' } },
      { notes: { contains: 'Bulk payment' } },
    ],
  },
  orderBy: { createdAt: 'desc' },
  take: 30,
  select: {
    id: true,
    invoiceId: true,
    amount: true,
    reference: true,
    providerPaymentId: true,
    solaTransactionId: true,
    createdAt: true,
    invoice: { select: { invoiceNumber: true, status: true, balance: true, qboSyncId: true, client: { select: { name: true } } } },
  },
})
console.log('BULK_PAYMENTS_7D', JSON.stringify(bulkPayments, null, 2))

const paymentIds = bulkPayments.map((x) => x.id)
if (paymentIds.length) {
  const logs = await p.quickBooksSyncLog.findMany({
    where: { entityId: { in: paymentIds }, type: 'payment' },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true, status: true, error: true, qboId: true, createdAt: true },
  })
  console.log('SYNC_LOGS', JSON.stringify(logs, null, 2))

  const jobs = await p.qboSyncJob.findMany({
    where: { entityId: { in: paymentIds }, entityType: 'payment' },
    orderBy: { updatedAt: 'desc' },
    select: { entityId: true, status: true, retryCount: true, lastError: true, updatedAt: true },
  })
  console.log('JOBS', JSON.stringify(jobs, null, 2))
}

const recentPayErrors = await p.quickBooksSyncLog.findMany({
  where: { type: 'payment', status: 'error', createdAt: { gte: since } },
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: { entityId: true, error: true, createdAt: true },
})
console.log('PAYMENT_ERRORS_7D', JSON.stringify(recentPayErrors, null, 2))

// Client 2-4 Kingsville all invoices
const client = await p.client.findFirst({
  where: { name: { contains: '2-4 Kingsville', mode: 'insensitive' } },
  select: { id: true, name: true, tenantId: true },
})
if (client) {
  const invs = await p.invoice.findMany({
    where: { clientId: client.id },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: { id: true, invoiceNumber: true, status: true, balance: true, qboSyncId: true, updatedAt: true },
  })
  console.log('KINGSVILLE_INVOICES', JSON.stringify(invs, null, 2))
}

await p.$disconnect()
