import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { createNotification } from '@/lib/notifications'

const REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000

async function authorize(request: NextRequest): Promise<{ tenantId?: string; isGlobal: boolean } | NextResponse> {
  const cronSecret = String(process.env.CRON_SECRET || '').trim()
  const providedSecret =
    String(request.headers.get('x-cron-secret') || request.headers.get('x-reminder-secret') || '').trim()

  if (cronSecret && providedSecret && cronSecret === providedSecret) {
    return { isGlobal: true }
  }

  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'issues.edit')
  if (permError) return permError
  const user = getAuthUser(request)
  return { tenantId: user.tenantId, isGlobal: false }
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request)
  if (auth instanceof NextResponse) return auth

  const now = new Date()
  const twoHoursAgo = new Date(now.getTime() - REMINDER_INTERVAL_MS)

  const rows = await prisma.issue.findMany({
    where: {
      ...(auth.isGlobal ? {} : { tenantId: auth.tenantId }),
      assigneeId: { not: null },
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      openedAt: null,
      updatedAt: { lte: twoHoursAgo },
      OR: [{ lastNotificationAt: null }, { lastNotificationAt: { lte: twoHoursAgo } }],
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

  for (const row of rows) {
    if (!row.assigneeId) continue
    attempted += 1
    const result = await createNotification({
      tenantId: row.tenantId,
      userId: row.assigneeId,
      type: 'ISSUE_ASSIGNED',
      title: 'Reminder: issue still open',
      message: row.title,
      linkType: 'issue',
      linkId: row.id,
      linkUrl: `/dashboard/issues/${row.id}`,
      action: 'issue_assignment_reminder',
    })
    if (result.ok) {
      sent += 1
      await prisma.issue.update({
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
  })
}
