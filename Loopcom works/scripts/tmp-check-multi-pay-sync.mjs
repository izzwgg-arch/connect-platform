import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const invId = process.argv[2] || 'cmpqzmtt901pb6zleo8y5a6zd'

const inv = await p.invoice.findUnique({
  where: { id: invId },
  select: {
    id: true,
    invoiceNumber: true,
    status: true,
    balance: true,
    clientId: true,
    qboSyncId: true,
    tenantId: true,
    client: { select: { name: true } },
  },
})
console.log('INVOICE', JSON.stringify(inv, null, 2))

const clientPayments = await p.payment.findMany({
  where: { invoice: { clientId: inv?.clientId } },
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: {
    id: true,
    invoiceId: true,
    amount: true,
    status: true,
    method: true,
    reference: true,
    providerPaymentId: true,
    solaTransactionId: true,
    processedAt: true,
    createdAt: true,
    invoice: { select: { invoiceNumber: true, status: true, balance: true, qboSyncId: true } },
  },
})
console.log('CLIENT_RECENT_PAYMENTS', JSON.stringify(clientPayments, null, 2))

const paymentIds = clientPayments.map((x) => x.id)
if (paymentIds.length) {
  const logs = await p.quickBooksSyncLog.findMany({
    where: { entityId: { in: paymentIds }, type: 'payment' },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { entityId: true, status: true, error: true, qboId: true, action: true, createdAt: true },
  })
  console.log('PAYMENT_SYNC_LOGS', JSON.stringify(logs, null, 2))

  const jobs = await p.qboSyncJob.findMany({
    where: { entityId: { in: paymentIds }, entityType: 'payment' },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { entityId: true, status: true, attempts: true, retryCount: true, lastError: true, updatedAt: true },
  })
  console.log('SYNC_JOBS', JSON.stringify(jobs, null, 2))

  const mappings = await p.quickBooksEntityMapping.findMany({
    where: { entityType: 'payment', localEntityId: { in: paymentIds } },
    select: { localEntityId: true, qboEntityId: true },
  })
  console.log('QBO_MAPPINGS', JSON.stringify(mappings, null, 2))
}

const open = await p.invoice.findMany({
  where: {
    clientId: inv?.clientId,
    tenantId: inv?.tenantId,
    balance: { gt: 0 },
    status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] },
  },
  select: { id: true, invoiceNumber: true, status: true, balance: true, qboSyncId: true },
  orderBy: { dueDate: 'asc' },
})
console.log('CLIENT_OPEN', JSON.stringify(open, null, 2))

await p.$disconnect()
