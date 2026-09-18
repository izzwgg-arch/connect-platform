import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const since = new Date('2026-06-10T12:00:00Z')

const [newJobs, jobActivities, paidNoJob, sampleJobs] = await Promise.all([
  p.job.count({ where: { createdAt: { gte: since } } }),
  p.activity.count({ where: { type: 'JOB_CREATED', createdAt: { gte: since } } }),
  p.invoice.count({
    where: { paidAmount: { gt: 0 }, jobId: null, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
  }),
  p.job.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { jobNumber: true, createdAt: true, client: { select: { name: true } } },
  }),
])

console.log(JSON.stringify({ newJobs, jobActivities, paidNoJob, sampleJobs }, null, 2))
await p.$disconnect()
