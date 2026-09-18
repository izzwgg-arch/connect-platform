import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getPaginationParams, createPaginationResponse } from '@/lib/pagination'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['audit_logs.view', 'audit_logs.access'])
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const entityType = searchParams.get('entityType') || ''
  const entityId = searchParams.get('entityId') || ''
  const userId = searchParams.get('userId') || ''
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const { skip, take, limit } = getPaginationParams(searchParams)

  try {
    const where: any = { tenantId: user.tenantId }
    if (entityType) where.entityType = entityType
    if (entityId) where.entityId = entityId
    if (userId) where.userId = userId
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}),
      }
    }

    const [logs, total, entityTypes] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where: { tenantId: user.tenantId },
        select: { entityType: true },
        distinct: ['entityType'],
        orderBy: { entityType: 'asc' },
        take: 100,
      }),
    ])

    return NextResponse.json({
      logs,
      entityTypes: entityTypes.map((row) => row.entityType),
      pagination: createPaginationResponse(total, limit, skip),
    })
  } catch (error) {
    console.error('audit-logs GET error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
