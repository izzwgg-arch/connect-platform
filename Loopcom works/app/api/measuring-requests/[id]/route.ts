import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

function toApiStatus(status: 'PENDING' | 'OPENED' | 'COMPLETED') {
  return status.toLowerCase()
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.view')
  if (permError) return permError
  const user = getAuthUser(request)
  const isAdmin = String(user.role) === 'ADMIN'

  const row = await prisma.measuringRequest.findFirst({
    where: {
      id: params.id,
      tenantId: user.tenantId,
      ...(isAdmin ? {} : { assignedUserId: user.id }),
    },
    include: {
      request: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          company: true,
          notes: true,
          jobSiteAddress: true,
          createdAt: true,
          status: true,
        },
      },
      assignedUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      createdByUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  })

  if (!row) {
    return NextResponse.json({ error: 'Measuring request not found' }, { status: 404 })
  }

  return NextResponse.json({
    measuringRequest: {
      id: row.id,
      requestId: row.requestId,
      assignedUserId: row.assignedUserId,
      createdByUserId: row.createdByUserId,
      status: toApiStatus(row.status),
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      openedAt: row.openedAt?.toISOString() || null,
      completedAt: row.completedAt?.toISOString() || null,
      lastNotificationAt: row.lastNotificationAt?.toISOString() || null,
      notificationAttempts: row.notificationAttempts,
      request: {
        ...row.request,
        customerName: row.request.company || `${row.request.firstName} ${row.request.lastName}`.trim(),
        createdAt: row.request.createdAt.toISOString(),
      },
      assignedUser: row.assignedUser,
      createdByUser: row.createdByUser,
    },
  })
}
