import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { createNotification } from '@/lib/notifications'
import { hasMobilePermission, isMobileRequest, requireAnyPermission, requireMobilePermission, requirePermission } from '@/lib/authorization'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['schedule.view', 'schedule.view_all'])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const canCreateForOthers =
      user.role === 'ADMIN' ||
      (await hasMobilePermission(user.id, user.tenantId, 'canCreateSchedulesForOthers')) ||
      (await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.assign'))
    const schedule = await prisma.schedule.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        job: {
          include: {
            client: {
              select: {
                id: true,
                name: true,
                companyName: true,
              },
            },
          },
        },
        lead: true,
      },
    })

    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
    }
    if (!canCreateForOthers && schedule.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ schedule })
  } catch (error) {
    console.error('Get schedule error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  if (isMobileRequest(request)) {
    const mobilePermError = await requireMobilePermission(request, 'mobile.jobs.schedule')
    if (mobilePermError) return mobilePermError
  } else {
    const permError = await requirePermission(request, 'schedule.edit')
    if (permError) return permError
  }

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      title,
      description,
      type,
      startTime,
      endTime,
      allDay,
      userId,
      jobId,
      leadId,
    } = body

    // Get existing schedule
    const existing = await prisma.schedule.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
    }

    const targetUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : existing.userId
    const canCreateForOthers =
      user.role === 'ADMIN' ||
      (await hasMobilePermission(user.id, user.tenantId, 'canCreateSchedulesForOthers')) ||
      (await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.assign'))
    if (targetUserId !== user.id && !canCreateForOthers) {
      return NextResponse.json(
        { error: 'Forbidden: You can only assign schedules to yourself' },
        { status: 403 }
      )
    }
    if (targetUserId !== existing.userId) {
      const assignedUser = await prisma.user.findFirst({
        where: {
          id: targetUserId,
          tenantId: user.tenantId,
        },
        select: { id: true },
      })
      if (!assignedUser) {
        return NextResponse.json({ error: 'Assigned user not found' }, { status: 404 })
      }
    }

    // Check for conflicts if time or user changed
    if ((startTime || endTime || userId) && (userId || existing.userId)) {
      const checkUserId = targetUserId
      const checkStartTime = startTime ? new Date(startTime) : existing.startTime
      const checkEndTime = endTime ? new Date(endTime) : existing.endTime

      const conflictingSchedules = await prisma.schedule.findMany({
        where: {
          tenantId: user.tenantId,
          userId: checkUserId,
          id: {
            not: params.id,
          },
          startTime: {
            lte: checkEndTime,
          },
          endTime: {
            gte: checkStartTime,
          },
        },
      })

      if (conflictingSchedules.length > 0) {
        return NextResponse.json(
          {
            error: 'Schedule conflict detected',
            conflicts: conflictingSchedules.map((s) => ({
              id: s.id,
              title: s.title,
              startTime: s.startTime,
              endTime: s.endTime,
            })),
          },
          { status: 409 }
        )
      }
    }

    // Update schedule
    const schedule = await prisma.schedule.update({
      where: { id: params.id },
      data: {
        title: title !== undefined ? title : existing.title,
        description: description !== undefined ? description : existing.description,
        type: type !== undefined ? type : existing.type,
        startTime: startTime !== undefined ? new Date(startTime) : existing.startTime,
        endTime: endTime !== undefined ? new Date(endTime) : existing.endTime,
        allDay: allDay !== undefined ? allDay : existing.allDay,
        userId: targetUserId,
        jobId: jobId !== undefined ? (jobId || null) : existing.jobId,
        leadId: leadId !== undefined ? (leadId || null) : existing.leadId,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
          },
        },
        lead: true,
      },
    })

    // Notify assigned user when schedule is updated or reassigned.
    if (schedule.userId !== user.id) {
      await createNotification({
        tenantId: user.tenantId,
        userId: schedule.userId,
        type: 'SCHEDULE_REMINDER',
        title: 'Schedule Updated',
        message: `Your schedule "${schedule.title}" was updated.`,
        linkType: 'schedule',
        linkId: schedule.id,
        linkUrl: '/dashboard/schedule',
        actorUserId: user.id,
        action: 'schedule_updated',
      })
    }

    // Update job scheduled dates if linked
    if (jobId && (startTime || endTime)) {
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId: user.tenantId,
        },
      })

      if (job) {
        await prisma.job.update({
          where: { id: jobId },
          data: {
            scheduledStart: startTime ? new Date(startTime) : job.scheduledStart,
            scheduledEnd: endTime ? new Date(endTime) : job.scheduledEnd,
          },
        })
      }
    }

    return NextResponse.json({ schedule })
  } catch (error) {
    console.error('Update schedule error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'schedule.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const canCreateForOthers =
      user.role === 'ADMIN' ||
      (await hasMobilePermission(user.id, user.tenantId, 'canCreateSchedulesForOthers'))
    const schedule = await prisma.schedule.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
    }
    if (!canCreateForOthers && schedule.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.schedule.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ message: 'Schedule deleted successfully' })
  } catch (error) {
    console.error('Delete schedule error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
