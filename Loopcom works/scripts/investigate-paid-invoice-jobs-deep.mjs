import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const since = new Date(Date.now() - 180 * 86400000)

const paid = await p.invoice.findMany({
  where: { paidAmount: { gt: 0 }, paidAt: { gte: since } },
  select: {
    id: true,
    invoiceNumber: true,
    status: true,
    jobId: true,
    clientId: true,
    paidAt: true,
    client: { select: { name: true } },
    job: { select: { id: true, jobNumber: true, createdAt: true } },
    payments: {
      take: 1,
      orderBy: { createdAt: 'asc' },
      select: { provider: true, method: true, notes: true, solaTransactionId: true },
    },
  },
  orderBy: { paidAt: 'desc' },
})

const noJob = paid.filter((i) => !i.jobId)
const withJob = paid.filter((i) => i.jobId)

const jobsNoAddr = await p.job.findMany({
  where: {
    createdAt: { gte: since },
    addresses: { none: {} },
  },
  select: {
    id: true,
    jobNumber: true,
    createdAt: true,
    client: { select: { name: true } },
    invoices: { select: { invoiceNumber: true, paidAt: true, status: true } },
  },
  take: 30,
})

const kingsville = await p.client.findMany({
  where: {
    OR: [
      { name: { contains: 'Kingsville', mode: 'insensitive' } },
      { companyName: { contains: 'Kingsville', mode: 'insensitive' } },
    ],
  },
  select: { id: true, name: true },
})

console.log('PAID_LAST_180D', {
  total: paid.length,
  withJob: withJob.length,
  noJob: noJob.length,
  noJobSamples: noJob.slice(0, 15),
})

console.log('JOBS_NO_ADDRESS', JSON.stringify(jobsNoAddr, null, 2))
console.log('KINGSVILLE_CLIENTS', kingsville)

for (const c of kingsville) {
  const invs = await p.invoice.findMany({
    where: { clientId: c.id, paidAmount: { gt: 0 } },
    include: {
      job: { select: { jobNumber: true, createdAt: true, addresses: { select: { street: true, city: true } } } },
      estimate: { select: { jobSiteAddress: true, jobId: true } },
      payments: {
        take: 1,
        orderBy: { createdAt: 'asc' },
        select: { provider: true, method: true, notes: true, createdAt: true },
      },
    },
    orderBy: { paidAt: 'desc' },
    take: 15,
  })
  console.log(
    'KINGSVILLE_INVOICES',
    c.name,
    JSON.stringify(
      invs.map((i) => ({
        num: i.invoiceNumber,
        status: i.status,
        job: i.job?.jobNumber,
        jobId: i.jobId,
        jobCreatedAt: i.job?.createdAt,
        jobAddresses: i.job?.addresses,
        estimateJobSite: i.estimate?.jobSiteAddress,
        paidAt: i.paidAt,
        pay: i.payments[0],
      })),
      null,
      2
    )
  )
}

// Invoices paid but job created AFTER paidAt by more than 1 hour (late job creation)
const lateJobs = withJob.filter((i) => {
  if (!i.job?.createdAt || !i.paidAt) return false
  return i.job.createdAt.getTime() - i.paidAt.getTime() > 3600000
})
console.log('LATE_JOB_CREATION', JSON.stringify(lateJobs.slice(0, 20), null, 2))

await p.$disconnect()
