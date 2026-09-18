import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns'
import { createNotification } from '@/lib/notifications'
import { hasMobilePermission, hasPermission, isMobileRequest, requireAnyPermission, requireMobilePermission, requirePermission } from '@/lib/authorization'
import { resolveScheduleScope } from '@/lib/schedule/scope'

function normalizeScheduleDateTime(rawDate: unknown, rawTime: unknown, fallbackIso?: string): Date | null {
  if (typeof fallbackIso === 'string' && fallbackIso.trim().length > 0) {
    const parsed = new Date(fallbackIso)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof rawDate !== 'string' || typeof rawTime !== 'string') {
    return null
  }

  const date = rawDate.trim()
  const time = rawTime.trim()
  if (!date || !time) return null

  // If time already includes a date, trust it.
  if (time.includes('T') || time.includes('-')) {
    const parsedTime = new Date(time)
    return Number.isNaN(parsedTime.getTime()) ? null : parsedTime
  }

  const parsed = new Date(`${date}T${time}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['schedule.view', 'schedule.view_all'])
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const view = searchParams.get('view') || 'week' // day, week, month
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const userId = searchParams.get('userId') || 'all'
  const userIds = searchParams.get('userIds') || ''
  const scope = searchParams.get('scope') || ''
  const jobId = searchParams.get('jobId') || ''
  const leadId = searchParams.get('leadId') || ''
  const status = searchParams.get('status') || ''

  try {
    const canCreateForOthers =
      user.role === 'ADMIN' ||
      (await hasMobilePermission(user.id, user.tenantId, 'canCreateSchedulesForOthers')) ||
      (await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.assign'))
    const canViewAllSchedule =
      user.role === 'ADMIN' ||
      canCreateForOthers ||
      (await hasMobilePermission(user.id, user.tenantId, 'mobile.schedule.view_all')) ||
      (await hasPermission(user.id, user.tenantId, 'schedule.view_all'))
    let start: Date
    let end: Date

    if (startDate && endDate) {
      start = new Date(startDate)
      end = new Date(endDate)
    } else {
      const now = new Date()
      switch (view) {
        case 'day':
          start = startOfDay(now)
          end = endOfDay(now)
          break
        case 'week':
          start = startOfWeek(now, { weekStartsOn: 1 })
          end = endOfWeek(now, { weekStartsOn: 1 })
          break
        case 'month':
          start = startOfMonth(now)
          end = endOfMonth(now)
          break
        default:
          start = startOfWeek(now, { weekStartsOn: 1 })
          end = endOfWeek(now, { weekStartsOn: 1 })
      }
    }

    const where: any = {
      tenantId: user.tenantId,
      startTime: {
        lte: end,
      },
      endTime: {
        gte: start,
      },
    }

    const scoped = resolveScheduleScope({
      requestedScope: scope,
      requestedUserId: userId,
      currentUserId: user.id,
      canViewAll: canViewAllSchedule,
    })

    const requestedUserIds = userIds
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)

    if (requestedUserIds.length > 0) {
      if (canViewAllSchedule) {
        where.userId = {
          in: requestedUserIds,
        }
      } else {
        where.userId = user.id
      }
    } else if (scoped.effectiveUserId) {
      where.userId = scoped.effectiveUserId
    }

    if (jobId) {
      where.jobId = jobId
    }

    if (leadId) {
      where.leadId = leadId
    }

    const statuses = status
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
    if (statuses.length > 0) {
      where.job = {
        status: {
          in: statuses,
        },
      }
    }

    const schedules = await prisma.schedule.findMany({
      where,
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
            status: true,
            client: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        lead: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        startTime: 'asc',
      },
    })

    // Check for conflicts
    const conflicts: string[] = []
    for (let i = 0; i < schedules.length; i++) {
      for (let j = i + 1; j < schedules.length; j++) {
        const s1 = schedules[i]
        const s2 = schedules[j]
        if (s1.userId === s2.userId) {
          // Check if time ranges overlap
          if (
            (s1.startTime <= s2.endTime && s1.endTime >= s2.startTime) ||
            (s2.startTime <= s1.endTime && s2.endTime >= s1.startTime)
          ) {
            conflicts.push(`${s1.id},${s2.id}`)
          }
        }
      }
    }

    return NextResponse.json({
      schedules,
      conflicts,
      dateRange: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      scope: scoped.scope,
    })
  } catch (error) {
    console.error('Get schedules error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  if (isMobileRequest(request)) {
    const mobilePermError = await requireMobilePermission(request, 'mobile.jobs.schedule')
    if (mobilePermError) return mobilePermError
  } else {
    const permError = await requirePermission(request, 'schedule.create')
    if (permError) return permError
  }

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      title,
      description,
      notes,
      type,
      startTime,
      endTime,
      date,
      allDay,
      userId,
      assignedUserId,
      jobId,
      leadId,
    } = body

    const targetUserId =
      typeof assignedUserId === 'string' && assignedUserId.trim().length > 0
        ? assignedUserId.trim()
        : typeof userId === 'string' && userId.trim().length > 0
          ? userId.trim()
          : user.id
    const resolvedStart = normalizeScheduleDateTime(date, startTime, startTime)
    const resolvedEnd = normalizeScheduleDateTime(date, endTime, endTime)
    const resolvedTitle =
      typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Schedule'
    const canCreateForOthers =
      user.role === 'ADMIN' ||
      (await hasMobilePermission(user.id, user.tenantId, 'canCreateSchedulesForOthers'))

    if (!resolvedStart || !resolvedEnd) {
      return NextResponse.json({ error: 'Valid start time and end time are required' }, { status: 400 })
    }
    if (resolvedEnd <= resolvedStart) {
      return NextResponse.json({ error: 'End time must be after start time' }, { status: 400 })
    }

    if (targetUserId !== user.id && !canCreateForOthers) {
      return NextResponse.json(
        { error: 'Forbidden: You can only create schedules for yourself' },
        { status: 403 }
      )
    }

    // Verify user belongs to tenant
    const assignedUser = await prisma.user.findFirst({
      where: {
        id: targetUserId,
        tenantId: user.tenantId,
      },
    })

    if (!assignedUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Check for conflicts
    const conflictingSchedules = await prisma.schedule.findMany({
      where: {
        tenantId: user.tenantId,
        userId: targetUserId,
        startTime: {
          lte: resolvedEnd,
        },
        endTime: {
          gte: resolvedStart,
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

    // Create schedule
    const schedule = await prisma.schedule.create({
      data: {
        tenantId: user.tenantId,
        title: resolvedTitle,
        description:
          (typeof description === 'string' && description.trim().length > 0
            ? description
            : typeof notes === 'string'
              ? notes
              : null) || null,
        type: type || 'OTHER',
        startTime: resolvedStart,
        endTime: resolvedEnd,
        allDay: allDay || false,
        userId: targetUserId,
        jobId: jobId || null,
        leadId: leadId || null,
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

    // Update job scheduled dates if linked
    if (jobId) {
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
            scheduledStart: resolvedStart,
            scheduledEnd: resolvedEnd,
            status: job.status === 'QUOTE' ? 'SCHEDULED' : job.status,
          },
        })
      }
    }

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'SCHEDULE_CREATED',
        description: `Schedule "${resolvedTitle}" created for ${assignedUser.firstName} ${assignedUser.lastName}`,
        jobId: jobId || undefined,
        leadId: leadId || undefined,
      },
    })

    // Create push-enabled notification for assigned user
    if (targetUserId !== user.id) {
      await createNotification({
        tenantId: user.tenantId,
        userId: targetUserId,
        type: 'SCHEDULE_REMINDER',
        title: 'New Schedule',
        message: `You have been scheduled: "${resolvedTitle}"`,
        linkType: 'schedule',
        linkId: schedule.id,
        linkUrl: '/dashboard/schedule',
        actorUserId: user.id,
        action: 'schedule_created',
      })
    }

    return NextResponse.json({ schedule }, { status: 201 })
  } catch (error) {
    console.error('Create schedule error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
