import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

function parseStatusFilter(value: string | null): 'PENDING' | 'OPENED' | 'COMPLETED' | 'ALL' {
  const normalized = String(value || 'ALL').trim().toUpperCase()
  if (normalized === 'PENDING' || normalized === 'OPENED' || normalized === 'COMPLETED') return normalized
  return 'ALL'
}

function toApiStatus(status: 'PENDING' | 'OPENED' | 'COMPLETED') {
  return status.toLowerCase()
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.view')
  if (permError) return permError
  const user = getAuthUser(request)

  const statusFilter = parseStatusFilter(request.nextUrl.searchParams.get('status'))
  const scope = String(request.nextUrl.searchParams.get('scope') || '').toLowerCase()
  const canViewAll = String(user.role) === 'ADMIN' && scope === 'all'

  const where: any = {
    tenantId: user.tenantId,
    ...(canViewAll ? {} : { assignedUserId: user.id }),
    ...(statusFilter === 'ALL' ? {} : { status: statusFilter }),
  }

  const [rows, pendingCount, openedCount, completedCount] = await Promise.all([
    prisma.measuringRequest.findMany({
      where,
      include: {
        request: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            company: true,
            jobSiteAddress: true,
          },
        },
        createdByUser: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 300,
    }),
    prisma.measuringRequest.count({
      where: {
        ...where,
        status: 'PENDING',
      },
    }),
    prisma.measuringRequest.count({
      where: {
        ...where,
        status: 'OPENED',
      },
    }),
    prisma.measuringRequest.count({
      where: {
        ...where,
        status: 'COMPLETED',
      },
    }),
  ])

  return NextResponse.json({
    measuringRequests: rows.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      assignedUserId: row.assignedUserId,
      createdByUserId: row.createdByUserId,
      status: toApiStatus(row.status),
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      openedAt: row.openedAt?.toISOString() || null,
      completedAt: row.completedAt?.toISOString() || null,
      notificationAttempts: row.notificationAttempts,
      createdByUser: row.createdByUser
        ? { id: row.createdByUser.id, firstName: row.createdByUser.firstName, lastName: row.createdByUser.lastName }
        : null,
      request: {
        id: row.request.id,
        customerName: row.request.company || `${row.request.firstName} ${row.request.lastName}`.trim(),
        firstName: row.request.firstName,
        lastName: row.request.lastName,
        company: row.request.company,
        address: row.request.jobSiteAddress || null,
      },
    })),
    counts: {
      pending: pendingCount,
      opened: openedCount,
      completed: completedCount,
    },
  })
}
