import { prisma } from '@/lib/prisma'

export type JobTimeSummary = {
  totalMinutes: number
  billableHours: number
  billableAmountCents: number
}

export function calcBillableAmountCents(totalMinutes: number, hourlyRateCents: number | null): number {
  if (!hourlyRateCents || hourlyRateCents <= 0 || totalMinutes <= 0) return 0
  return Math.round((totalMinutes / 60) * hourlyRateCents)
}

export async function getJobTimeSummary(
  tenantId: string,
  jobId: string,
  hourlyRateCents: number | null
): Promise<JobTimeSummary> {
  const aggregate = await prisma.timeEntry.aggregate({
    where: {
      tenantId,
      jobId,
      deletedAt: null,
      status: 'STOPPED',
    },
    _sum: {
      durationMinutes: true,
    },
  })

  const totalMinutes = Number(aggregate._sum.durationMinutes || 0)
  const billableHours = Number((totalMinutes / 60).toFixed(2))
  const billableAmountCents = calcBillableAmountCents(totalMinutes, hourlyRateCents)

  return {
    totalMinutes,
    billableHours,
    billableAmountCents,
  }
}

export async function syncJobBillableMinutes(tenantId: string, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true, hourlyRateCents: true },
  })
  if (!job) return null

  const summary = await getJobTimeSummary(tenantId, jobId, job.hourlyRateCents)
  await prisma.job.update({
    where: { id: jobId },
    data: {
      billableMinutesTotal: summary.totalMinutes,
    },
  })

  return summary
}
