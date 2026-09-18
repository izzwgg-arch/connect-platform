import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'

function getUserLocalDayWindow(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const localDate = params.get('localDate') // YYYY-MM-DD in device local date
  const tzOffsetMinutesRaw = params.get('tzOffsetMinutes')
  const tzOffsetMinutes = Number.parseInt(tzOffsetMinutesRaw || '0', 10)

  if (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate) && Number.isFinite(tzOffsetMinutes)) {
    const [yearStr, monthStr, dayStr] = localDate.split('-')
    const year = Number.parseInt(yearStr, 10)
    const month = Number.parseInt(monthStr, 10)
    const day = Number.parseInt(dayStr, 10)

    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      // Convert user's local midnight to UTC using timezone offset from device.
      const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + tzOffsetMinutes * 60_000
      const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000
      return {
        startUtc: new Date(startUtcMs),
        endUtc: new Date(endUtcMs),
      }
    }
  }

  // Fallback: server-local day window.
  const startUtc = new Date()
  startUtc.setHours(0, 0, 0, 0)
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000)
  return { startUtc, endUtc }
}

/**
 * Mobile API: Lightweight assignments feed for technician dashboard refresh.
 * Includes jobs, tasks, and issues assigned to the authenticated technician.
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)
  const { startUtc, endUtc } = getUserLocalDayWindow(request)

  try {
    const openTaskWhere = {
      tenantId: user.tenantId,
      assigneeId: user.id,
      status: { notIn: ['COMPLETED', 'CANCELLED'] as const },
    }

    const openIssueWhere = {
      tenantId: user.tenantId,
      assigneeId: user.id,
      status: { notIn: ['RESOLVED', 'CLOSED', 'CANCELLED'] as const },
    }

    const [jobs, tasks, issues, todaysJobs, todaysTasks, openIssues, openTasksCount, openIssuesCount] = await Promise.all([
      prisma.job.findMany({
        where: {
          tenantId: user.tenantId,
          assignments: {
            some: {
              userId: user.id,
            },
          },
        },
        select: {
          id: true,
          jobNumber: true,
          title: true,
          status: true,
          priority: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
      prisma.task.findMany({
        where: {
          tenantId: user.tenantId,
          assigneeId: user.id,
        },
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          dueDate: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 50,
      }),
      prisma.issue.findMany({
        where: {
          tenantId: user.tenantId,
          assigneeId: user.id,
        },
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          type: true,
          jobId: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 50,
      }),
      prisma.job.findMany({
        where: {
          tenantId: user.tenantId,
          assignments: {
            some: {
              userId: user.id,
            },
          },
          scheduledStart: {
            gte: startUtc,
            lt: endUtc,
          },
        },
        select: {
          id: true,
          jobNumber: true,
          title: true,
          status: true,
          priority: true,
          scheduledStart: true,
          scheduledEnd: true,
          client: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
          addresses: {
            where: { type: 'JOB_SITE' },
            take: 1,
            select: {
              street: true,
              city: true,
              state: true,
              zipCode: true,
            },
          },
        },
        orderBy: { scheduledStart: 'asc' },
        take: 50,
      }),
      prisma.task.findMany({
        where: {
          ...openTaskWhere,
          dueDate: {
            gte: startUtc,
            lt: endUtc,
          },
        },
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          dueDate: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 50,
      }),
      prisma.issue.findMany({
        where: openIssueWhere,
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          type: true,
          jobId: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 50,
      }),
      prisma.task.count({ where: openTaskWhere }),
      prisma.issue.count({ where: openIssueWhere }),
    ])

    return NextResponse.json({
      jobs,
      tasks,
      issues,
      jobsTodayCount: todaysJobs.length,
      openTasksCount,
      openIssuesCount,
      todaysJobs: todaysJobs.map((job) => ({
        id: job.id,
        jobNumber: job.jobNumber,
        title: job.title,
        status: job.status,
        priority: job.priority,
        scheduledStart: job.scheduledStart?.toISOString() || null,
        scheduledEnd: job.scheduledEnd?.toISOString() || null,
        client: job.client,
        address: job.addresses[0] || null,
      })),
      todaysTasks: todaysTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate?.toISOString() || null,
        updatedAt: task.updatedAt.toISOString(),
      })),
      openIssues: openIssues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        type: issue.type,
        jobId: issue.jobId,
        updatedAt: issue.updatedAt.toISOString(),
      })),
      serverTime: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Mobile assignments feed error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

