import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { createNotification } from '@/lib/notifications'

const REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000
const DAY_START_HOUR = 8
const DAY_END_HOUR = 20
const MAX_DAILY_REMINDERS = 2

async function authorize(request: NextRequest): Promise<{ tenantId?: string; isGlobal: boolean } | NextResponse> {
  const cronSecret = String(process.env.CRON_SECRET || '').trim()
  const providedSecret =
    String(request.headers.get('x-cron-secret') || request.headers.get('x-reminder-secret') || '').trim()

  if (cronSecret && providedSecret && cronSecret === providedSecret) {
    return { isGlobal: true }
  }

  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'tasks.edit')
  if (permError) return permError
  const user = getAuthUser(request)
  return { tenantId: user.tenantId, isGlobal: false }
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request)
  if (auth instanceof NextResponse) return auth

  const now = new Date()
  const hour = now.getHours()
  if (hour < DAY_START_HOUR || hour >= DAY_END_HOUR) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'outside_daytime_window' })
  }

  const fourHoursAgo = new Date(now.getTime() - REMINDER_INTERVAL_MS)
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)

  const rows = await prisma.task.findMany({
    where: {
      ...(auth.isGlobal ? {} : { tenantId: auth.tenantId }),
      status: { in: ['TODO', 'IN_PROGRESS'] },
      openedAt: null,
      updatedAt: { lte: fourHoursAgo },
      OR: [{ lastNotificationAt: null }, { lastNotificationAt: { lte: fourHoursAgo } }],
    },
    select: {
      id: true,
      tenantId: true,
      assigneeId: true,
      title: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })

  let sent = 0
  let attempted = 0
  let skippedDailyCap = 0

  for (const row of rows) {
    const sentToday = await prisma.notification.count({
      where: {
        tenantId: row.tenantId,
        userId: row.assigneeId,
        linkType: 'task',
        linkId: row.id,
        createdAt: { gte: dayStart },
        data: {
          path: ['action'],
          equals: 'task_assignment_reminder',
        },
      },
    })

    if (sentToday >= MAX_DAILY_REMINDERS) {
      skippedDailyCap += 1
      continue
    }

    attempted += 1
    const result = await createNotification({
      tenantId: row.tenantId,
      userId: row.assigneeId,
      type: 'TASK_ASSIGNED',
      title: 'Reminder: task still pending',
      message: row.title,
      linkType: 'task',
      linkId: row.id,
      linkUrl: `/dashboard/tasks/${row.id}`,
      action: 'task_assignment_reminder',
    })

    if (result.ok) {
      sent += 1
      await prisma.task.update({
        where: { id: row.id },
        data: {
          lastNotificationAt: new Date(),
          notificationAttempts: { increment: 1 },
        },
      })
    }
  }

  return NextResponse.json({
    ok: true,
    checked: rows.length,
    attempted,
    sent,
    skippedDailyCap,
  })
}
