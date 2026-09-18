import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { syncAutoJobSchedules } from '@/lib/services/job-schedule-sync'
import { createNotificationsForUsers } from '@/lib/notifications'

const DEFAULT_DURATION_MINUTES = 60

function parseDateOrNull(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === '') return null
  const date = new Date(String(raw))
  if (Number.isNaN(date.getTime())) return null
  return date
}

function withDefaultEnd(start: Date | null, end: Date | null): Date | null {
  if (!start) return null
  if (end && end > start) return end
  return new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60 * 1000)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permissionError = await requireAnyPermission(request, [
    'schedule_jobs',
    'schedule.dispatch',
    'schedule.reschedule',
    'schedule.edit',
  ])
  if (permissionError) return permissionError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const requestedStart = parseDateOrNull(body?.scheduledStart)
    const requestedEnd = parseDateOrNull(body?.scheduledEnd)
    const force = Boolean(body?.force)

    if (body?.scheduledStart && !requestedStart) {
      return NextResponse.json({ error: 'Invalid scheduledStart datetime' }, { status: 400 })
    }
    if (body?.scheduledEnd && !requestedEnd) {
      return NextResponse.json({ error: 'Invalid scheduledEnd datetime' }, { status: 400 })
    }

    const job = await prisma.job.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        assignments: {
          select: { userId: true },
        },
      },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const scheduledStart = requestedStart
    const scheduledEnd = requestedStart ? withDefaultEnd(requestedStart, requestedEnd) : null

    const assignmentUserIds = job.assignments.map((assignment) => assignment.userId)
    let conflicts: Array<{ id: string; jobNumber: string; title: string }> = []

    if (scheduledStart && scheduledEnd && assignmentUserIds.length > 0) {
      const conflictingJobs = await prisma.job.findMany({
        where: {
          tenantId: user.tenantId,
          id: { not: job.id },
          status: { not: 'CANCELLED' },
          scheduledStart: { not: null, lt: scheduledEnd },
          scheduledEnd: { not: null, gt: scheduledStart },
          assignments: {
            some: {
              userId: { in: assignmentUserIds },
            },
          },
        },
        select: {
          id: true,
          jobNumber: true,
          title: true,
        },
        take: 10,
      })

      conflicts = conflictingJobs
      if (conflicts.length > 0 && !force) {
        return NextResponse.json(
          {
            error: 'Scheduling conflict detected',
            code: 'SCHEDULE_CONFLICT',
            conflicts,
          },
          { status: 409 }
        )
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedJob = await tx.job.update({
        where: { id: job.id },
        data: {
          scheduledStart,
          scheduledEnd,
        },
      })

      await syncAutoJobSchedules(tx, {
        tenantId: user.tenantId,
        jobId: job.id,
        jobNumber: job.jobNumber,
        jobTitle: job.title,
        userIds: assignmentUserIds,
        scheduledStart: updatedJob.scheduledStart,
        scheduledEnd: updatedJob.scheduledEnd,
      })

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entityType: 'Job',
          entityId: job.id,
          changes: {
            source: 'schedule_drag_drop',
            before: {
              scheduledStart: job.scheduledStart?.toISOString() || null,
              scheduledEnd: job.scheduledEnd?.toISOString() || null,
            },
            after: {
              scheduledStart: updatedJob.scheduledStart?.toISOString() || null,
              scheduledEnd: updatedJob.scheduledEnd?.toISOString() || null,
            },
            forceConflictOverride: force,
            conflictCount: conflicts.length,
          },
        },
      })

      return updatedJob
    })

    if (assignmentUserIds.length > 0) {
      const scheduleMessage = updated.scheduledStart
        ? `${job.jobNumber} is now scheduled for ${updated.scheduledStart.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}.`
        : `${job.jobNumber} was moved to unscheduled.`

      await createNotificationsForUsers(user.tenantId, assignmentUserIds, {
        type: 'JOB_UPDATED',
        title: 'Job Schedule Updated',
        message: scheduleMessage,
        linkUrl: `/dashboard/jobs/${job.id}`,
        linkType: 'job',
        linkId: job.id,
        actorUserId: user.id,
        action: 'job_schedule_dragdrop_updated',
      })
    }

    return NextResponse.json({
      job: updated,
      conflicts,
    })
  } catch (error) {
    console.error('Patch job schedule error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
