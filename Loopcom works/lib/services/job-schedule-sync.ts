import type { PrismaClient } from '@prisma/client'

const AUTO_SCHEDULE_MARKER = '[AUTO_JOB_SCHEDULE]'

type DbClient = PrismaClient | Prisma.TransactionClient

type SyncJobSchedulesParams = {
  tenantId: string
  jobId: string
  jobNumber?: string | null
  jobTitle: string
  userIds: string[]
  scheduledStart: Date | null
  scheduledEnd: Date | null
}

/**
 * Keeps per-user schedule rows in sync with job assignment/scheduling.
 * Only rows created by this sync marker are mutated/deleted.
 */
export async function syncAutoJobSchedules(db: DbClient, params: SyncJobSchedulesParams) {
  const distinctUserIds = Array.from(new Set(params.userIds.filter(Boolean)))

  const existingAutoSchedules = await db.schedule.findMany({
    where: {
      tenantId: params.tenantId,
      jobId: params.jobId,
      type: 'JOB',
      description: {
        startsWith: AUTO_SCHEDULE_MARKER,
      },
    },
    select: { id: true, userId: true },
  })

  // If job is unscheduled or unassigned, clear auto-generated schedule rows.
  if (!params.scheduledStart || !params.scheduledEnd || distinctUserIds.length === 0) {
    if (existingAutoSchedules.length > 0) {
      await db.schedule.deleteMany({
        where: {
          id: { in: existingAutoSchedules.map((s) => s.id) },
          tenantId: params.tenantId,
        },
      })
    }
    return
  }

  const keepUserIdSet = new Set(distinctUserIds)
  const staleIds = existingAutoSchedules.filter((s) => !keepUserIdSet.has(s.userId)).map((s) => s.id)
  if (staleIds.length > 0) {
    await db.schedule.deleteMany({
      where: {
        id: { in: staleIds },
        tenantId: params.tenantId,
      },
    })
  }

  const existingByUserId = new Map(existingAutoSchedules.map((s) => [s.userId, s.id]))
  const titlePrefix = params.jobNumber ? `${params.jobNumber} - ` : ''
  const scheduleTitle = `Job Schedule: ${titlePrefix}${params.jobTitle}`
  const scheduleDescription = `${AUTO_SCHEDULE_MARKER} Auto-synced from job assignment`

  for (const userId of distinctUserIds) {
    const existingId = existingByUserId.get(userId)
    if (existingId) {
      await db.schedule.update({
        where: { id: existingId },
        data: {
          title: scheduleTitle,
          description: scheduleDescription,
          startTime: params.scheduledStart,
          endTime: params.scheduledEnd,
          allDay: false,
          userId,
        },
      })
    } else {
      await db.schedule.create({
        data: {
          tenantId: params.tenantId,
          title: scheduleTitle,
          description: scheduleDescription,
          type: 'JOB',
          startTime: params.scheduledStart,
          endTime: params.scheduledEnd,
          allDay: false,
          userId,
          jobId: params.jobId,
        },
      })
    }
  }
}
