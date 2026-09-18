import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

function toApiStatus(status: 'PENDING' | 'OPENED' | 'COMPLETED') {
  return status.toLowerCase()
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.edit')
  if (permError) return permError
  const user = getAuthUser(request)
  const isAdmin = String(user.role) === 'ADMIN'

  const row = await prisma.measuringRequest.findFirst({
    where: {
      id: params.id,
      tenantId: user.tenantId,
      ...(isAdmin ? {} : { assignedUserId: user.id }),
    },
    select: { id: true, openedAt: true },
  })
  if (!row) {
    return NextResponse.json({ error: 'Measuring request not found' }, { status: 404 })
  }

  const now = new Date()
  const updated = await prisma.measuringRequest.update({
    where: { id: row.id },
    data: {
      status: 'COMPLETED',
      openedAt: row.openedAt || now,
      completedAt: now,
    },
  })

  return NextResponse.json({
    measuringRequest: {
      id: updated.id,
      status: toApiStatus(updated.status),
      openedAt: updated.openedAt?.toISOString() || null,
      completedAt: updated.completedAt?.toISOString() || null,
    },
  })
}
