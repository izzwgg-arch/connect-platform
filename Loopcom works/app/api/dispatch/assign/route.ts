import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { validateRequest, jobAssignmentSchema } from '@/lib/validation'
import { createNotificationsForUsers, notifyDispatchJobActivity, notifyJobAssigned } from '@/lib/notifications'
import { publishDispatchRealtime } from '@/lib/dispatch-realtime'
import { syncAutoJobSchedules } from '@/lib/services/job-schedule-sync'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requireAnyPermission(request, ['dispatch.assign', 'dispatch.dispatch'])
  if (permError) return permError

  const user = getAuthUser(request)

  // Validate request body
  const validation = await validateRequest(request, jobAssignmentSchema)
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: validation.status })
  }

  const { jobId, userId, techId, userIds, scheduledStart, scheduledEnd, notes } = validation.data

  try {
    const parseMaybeDate = (raw?: string | null): Date | null => {
      const v = String(raw || '').trim()
      if (!v) return null
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? null : d
    }
    const parsedStart = parseMaybeDate(scheduledStart)
    const parsedEnd = parseMaybeDate(scheduledEnd)

    const normalizedUserIds = Array.from(
      new Set(
        (Array.isArray(userIds) ? userIds : [])
          .concat([userId, techId].filter(Boolean) as string[])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      )
    )

    // Verify job exists and belongs to tenant
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenantId: user.tenantId,
      },
      include: {
        assignments: { select: { userId: true } },
      },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // If assignees provided, verify users exist and are in same tenant
    if (normalizedUserIds.length > 0) {
      const assignedUsers = await prisma.user.findMany({
        where: {
          id: { in: normalizedUserIds },
          tenantId: user.tenantId,
          status: 'ACTIVE',
        },
        select: { id: true },
      })

      if (assignedUsers.length !== normalizedUserIds.length) {
        return NextResponse.json({ error: 'User not found or inactive' }, { status: 404 })
      }
    }

    const previousAssignees = new Set(job.assignments.map((a) => a.userId))
    const nextAssignees = new Set(normalizedUserIds)
    const newlyAssignedUserIds = normalizedUserIds.filter((id) => !previousAssignees.has(id))
    const changed =
      previousAssignees.size !== nextAssignees.size ||
      [...previousAssignees].some((id) => !nextAssignees.has(id))
    const scheduleChanged = Boolean(parsedStart || parsedEnd)

    // Update assignment and schedule atomically.
    const updatedJob = await prisma.$transaction(async (tx) => {
      await tx.jobAssignment.deleteMany({
        where: { jobId },
      })

      if (normalizedUserIds.length > 0) {
        await tx.jobAssignment.createMany({
          data: normalizedUserIds.map((uid) => ({
            jobId,
            userId: uid,
            notes: notes || null,
          })),
          skipDuplicates: true,
        })
      }

      const shouldSetScheduledStatus =
        normalizedUserIds.length > 0 && ['QUOTE', 'ON_HOLD'].includes(String(job.status))

      const jobUpdate = await tx.job.update({
        where: { id: jobId },
        data: {
          scheduledStart: parsedStart,
          scheduledEnd: parsedEnd,
          status: shouldSetScheduledStatus ? 'SCHEDULED' : undefined,
        },
        include: {
          assignments: {
            include: {
              user: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
          },
        },
      })

      await syncAutoJobSchedules(tx, {
        tenantId: user.tenantId,
        jobId,
        jobNumber: job.jobNumber,
        jobTitle: job.title,
        userIds: normalizedUserIds,
        scheduledStart: parsedStart,
        scheduledEnd: parsedEnd,
      })

      await tx.dispatchEvent.create({
        data: {
          tenantId: user.tenantId,
          jobId: jobId,
          eventType: changed ? 'REASSIGNED' : 'ASSIGNED',
          actorUserId: user.id,
          payload: {
            assignedTo: normalizedUserIds,
            scheduledStart: parsedStart ? parsedStart.toISOString() : null,
            scheduledEnd: parsedEnd ? parsedEnd.toISOString() : null,
            notes: notes || null,
          },
        },
      })

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entityType: 'Job',
          entityId: jobId,
          changes: {
            assignment: {
              previous: [...previousAssignees],
              next: normalizedUserIds,
            },
            scheduledStart: parsedStart ? parsedStart.toISOString() : null,
            scheduledEnd: parsedEnd ? parsedEnd.toISOString() : null,
          },
        },
      })

      return jobUpdate
    })

    // Notify newly assigned users.
    for (const uid of newlyAssignedUserIds) {
      await notifyJobAssigned(user.tenantId, uid, jobId, job.title)
    }

    // Notify all active assignees when schedule is set/changed.
    if (normalizedUserIds.length > 0 && scheduleChanged) {
      const scheduleLabel = parsedStart
        ? parsedStart.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : 'updated'
      await createNotificationsForUsers(user.tenantId, normalizedUserIds, {
        type: 'JOB_UPDATED',
        title: 'Job Schedule Updated',
        message: `${job.jobNumber} is scheduled for ${scheduleLabel}.`,
        linkUrl: `/dashboard/jobs/${jobId}`,
        linkType: 'job',
        linkId: jobId,
        actorUserId: user.id,
        action: 'job_schedule_assigned',
      })
    }

    publishDispatchRealtime(user.tenantId, {
      id: `assign_${jobId}_${Date.now()}`,
      kind: 'dispatch_event',
      ts: new Date().toISOString(),
      jobId,
      eventType: normalizedUserIds.length === 0 ? 'UNASSIGNED' : changed ? 'REASSIGNED' : 'ASSIGNED',
      payload: {
        assignedTo: normalizedUserIds,
        scheduledStart: parsedStart ? parsedStart.toISOString() : null,
        scheduledEnd: parsedEnd ? parsedEnd.toISOString() : null,
      },
      job: {
        id: jobId,
        jobNumber: job.jobNumber,
        title: job.title,
      },
    })

    await notifyDispatchJobActivity({
      tenantId: user.tenantId,
      jobId,
      title: `Assignment updated: ${job.jobNumber}`,
      message:
        normalizedUserIds.length === 0
          ? 'Job was unassigned'
          : `${normalizedUserIds.length} crew member(s) assigned`,
    })

    return NextResponse.json({ job: updatedJob })
  } catch (error) {
    console.error('Dispatch assign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
