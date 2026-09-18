import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const user = getAuthUser(request)

  const url = new URL(request.url)
  const cursor = String(url.searchParams.get('cursor') || '').trim()
  const limitRaw = Number(url.searchParams.get('limit') || '25')
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 25

  const notifications = await prisma.notification.findMany({
    where: {
      tenantId: user.tenantId,
      userId: user.id,
    },
    orderBy: { createdAt: 'desc' },
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    take: limit,
    select: {
      id: true,
      type: true,
      title: true,
      message: true,
      status: true,
      linkType: true,
      linkId: true,
      linkUrl: true,
      data: true,
      createdAt: true,
      readAt: true,
    },
  })

  const unreadCount = await prisma.notification.count({
    where: {
      tenantId: user.tenantId,
      userId: user.id,
      status: 'UNREAD',
    },
  })

  return NextResponse.json({
    notifications,
    unreadCount,
    nextCursor: notifications.length === limit ? notifications[notifications.length - 1]?.id || null : null,
  })
}
