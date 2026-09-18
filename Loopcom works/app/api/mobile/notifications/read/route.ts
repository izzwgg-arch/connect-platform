import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const user = getAuthUser(request)

  const body = await request.json().catch(() => ({}))
  const notificationId = body?.notificationId ? String(body.notificationId) : null
  const markAll = Boolean(body?.markAll)

  if (!markAll && !notificationId) {
    return NextResponse.json({ error: 'notificationId or markAll is required' }, { status: 400 })
  }

  if (markAll) {
    await prisma.notification.updateMany({
      where: {
        tenantId: user.tenantId,
        userId: user.id,
        status: 'UNREAD',
      },
      data: {
        status: 'READ',
        readAt: new Date(),
      },
    })
    return NextResponse.json({ success: true })
  }

  await prisma.notification.updateMany({
    where: {
      id: notificationId!,
      tenantId: user.tenantId,
      userId: user.id,
    },
    data: {
      status: 'READ',
      readAt: new Date(),
    },
  })
  return NextResponse.json({ success: true })
}
