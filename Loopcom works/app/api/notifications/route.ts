import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'dashboard.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')
  const status = searchParams.get('status') // 'UNREAD' | 'READ' | null for all

  try {
    const where: any = {
      tenantId: user.tenantId,
      userId: user.id,
    }

    if (status) {
      where.status = status
    }

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
    })

    const unreadCount = await prisma.notification.count({
      where: {
        tenantId: user.tenantId,
        userId: user.id,
        status: 'UNREAD',
      },
    })

    const unreadByLinkTypeGroups = await prisma.notification.groupBy({
      by: ['linkType'],
      where: {
        tenantId: user.tenantId,
        userId: user.id,
        status: 'UNREAD',
        linkType: { not: null },
      },
      _count: { _all: true },
    })
    const unreadByLinkType: Record<string, number> = {}
    for (const group of unreadByLinkTypeGroups) {
      if (group.linkType) unreadByLinkType[group.linkType] = group._count._all
    }

    return NextResponse.json({ notifications, unreadCount, unreadByLinkType })
  } catch (error) {
    console.error('Get notifications error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
