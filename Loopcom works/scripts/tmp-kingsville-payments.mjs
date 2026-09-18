import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const clientId = 'cmnfjyvqo05cimc0ep0nlfbm1' // 2-4 Kingsville
const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)

const payments = await p.payment.findMany({
  where: {
    invoice: { clientId },
    createdAt: { gte: since },
  },
  orderBy: { createdAt: 'desc' },
  include: {
    invoice: { select: { invoiceNumber: true, status: true, balance: true, qboSyncId: true } },
  },
})
console.log('KINGSVILLE_PAYMENTS_48H', JSON.stringify(payments, null, 2))

const ids = payments.map((x) => x.id)
if (ids.length) {
  console.log('LOGS', JSON.stringify(await p.quickBooksSyncLog.findMany({
    where: { entityId: { in: ids }, type: 'payment' },
    orderBy: { createdAt: 'desc' },
  }), null, 2))
  console.log('JOBS', JSON.stringify(await p.qboSyncJob.findMany({
    where: { entityId: { in: ids }, entityType: 'payment' },
    orderBy: { updatedAt: 'desc' },
  }), null, 2))
}

// All recent payments tenant-wide last 24h
const recent = await p.payment.findMany({
  where: { createdAt: { gte: since } },
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: {
    id: true, amount: true, reference: true, providerPaymentId: true, solaTransactionId: true, createdAt: true,
    invoice: { select: { invoiceNumber: true, client: { select: { name: true } } } },
  },
})
console.log('ALL_PAYMENTS_48H', JSON.stringify(recent, null, 2))

await p.$disconnect()
