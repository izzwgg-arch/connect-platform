import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { createNotification } from '@/lib/notifications'

async function authorize(request: NextRequest): Promise<{ tenantId?: string; isGlobal: boolean } | NextResponse> {
  const cronSecret = String(process.env.CRON_SECRET || '').trim()
  const providedSecret =
    String(request.headers.get('x-cron-secret') || request.headers.get('x-reminder-secret') || '').trim()

  if (cronSecret && providedSecret && cronSecret === providedSecret) {
    return { isGlobal: true }
  }

  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.edit')
  if (permError) return permError
  const user = getAuthUser(request)
  return { tenantId: user.tenantId, isGlobal: false }
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request)
  if (auth instanceof NextResponse) return auth

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const where: any = {
    status: 'PENDING',
    openedAt: null,
    OR: [{ lastNotificationAt: null }, { lastNotificationAt: { lte: twoHoursAgo } }],
    ...(auth.isGlobal ? {} : { tenantId: auth.tenantId }),
  }

  const rows = await prisma.measuringRequest.findMany({
    where,
    include: {
      request: {
        select: { firstName: true, lastName: true },
      },
    },
    take: 500,
    orderBy: { createdAt: 'asc' },
  })

  let sent = 0
  let attempted = 0

  for (const row of rows) {
    attempted += 1
    const result = await createNotification({
      tenantId: row.tenantId,
      userId: row.assignedUserId,
      type: 'OTHER',
      title: 'Reminder: Measuring request still pending.',
      message: `${row.request.firstName} ${row.request.lastName}`,
      linkType: 'measuring_request',
      linkId: row.id,
      linkUrl: `/dashboard/requests/${row.requestId}`,
      action: 'measuring_request_reminder',
    })
    if (result.ok) {
      sent += 1
      await prisma.measuringRequest.update({
        where: { id: row.id },
        data: {
          lastNotificationAt: new Date(),
          notificationAttempts: {
            increment: 1,
          },
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
