import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { createNotificationsForUsers } from '@/lib/notifications'
import { publishDispatchRealtime } from '@/lib/dispatch-realtime'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requireAnyPermission(request, ['dispatch.notify', 'dispatch.assign'])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const message = String(body?.message || '').trim()
    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    }

    const assigned = await prisma.jobAssignment.findMany({
      where: {
        job: {
          tenantId: user.tenantId,
          status: { in: ['SCHEDULED', 'IN_PROGRESS', 'ON_HOLD'] as any[] },
        },
      },
      select: { userId: true },
    })
    const userIds = Array.from(new Set(assigned.map((a) => a.userId)))

    if (userIds.length > 0) {
      await createNotificationsForUsers(user.tenantId, userIds, {
        type: 'OTHER',
        title: 'Dispatch Broadcast',
        message,
        linkType: 'dispatch',
        linkUrl: '/dashboard/dispatch',
      })
    }

    publishDispatchRealtime(user.tenantId, {
      id: `broadcast_${Date.now()}`,
      kind: 'system',
      ts: new Date().toISOString(),
      eventType: 'BROADCAST',
      payload: { message, recipients: userIds.length },
    })

    return NextResponse.json({ success: true, recipients: userIds.length })
  } catch (error) {
    console.error('Dispatch broadcast error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

