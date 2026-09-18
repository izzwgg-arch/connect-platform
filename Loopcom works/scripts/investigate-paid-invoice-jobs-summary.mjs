import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const paidNoJob = await p.invoice.count({ where: { status: 'PAID', jobId: null } })
const partialNoJob = await p.invoice.count({
  where: { status: 'PARTIAL', jobId: null, paidAmount: { gt: 0 } },
})
const solaPaidNoJob = await p.invoice.count({
  where: { jobId: null, paidAmount: { gt: 0 }, payments: { some: { provider: 'sola' } } },
})
const manualPaidNoJob = await p.invoice.count({
  where: {
    jobId: null,
    paidAmount: { gt: 0 },
    payments: { some: { OR: [{ provider: 'manual' }, { provider: 'quick_pay' }] } },
  },
})
const qboPaidNoJob = await p.invoice.count({
  where: { jobId: null, paidAmount: { gt: 0 }, payments: { some: { provider: 'quickbooks' } } },
})

const recentPaidNoJob = await p.invoice.findMany({
  where: { status: 'PAID', jobId: null, paidAt: { gte: new Date('2026-05-01') } },
  select: {
    invoiceNumber: true,
    paidAt: true,
    client: { select: { name: true } },
    payments: {
      take: 1,
      orderBy: { createdAt: 'asc' },
      select: { provider: true, method: true, notes: true },
    },
  },
  orderBy: { paidAt: 'desc' },
  take: 20,
})

const solaRecentNoJob = await p.invoice.findMany({
  where: {
    jobId: null,
    paidAmount: { gt: 0 },
    payments: { some: { provider: 'sola' } },
    paidAt: { gte: new Date('2026-05-01') },
  },
  select: {
    invoiceNumber: true,
    status: true,
    paidAt: true,
    client: { select: { name: true } },
    payments: { take: 1, orderBy: { createdAt: 'asc' }, select: { provider: true, notes: true, createdAt: true } },
  },
  orderBy: { paidAt: 'desc' },
  take: 15,
})

console.log(
  JSON.stringify(
    { paidNoJob, partialNoJob, solaPaidNoJob, manualPaidNoJob, qboPaidNoJob, recentPaidNoJob, solaRecentNoJob },
    null,
    2
  )
)

await p.$disconnect()
