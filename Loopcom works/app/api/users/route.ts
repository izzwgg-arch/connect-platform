import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'

/**
 * Users listing (used by Dashboard -> Maps tech filter).
 *
 * GET /api/users?role=FIELD&limit=100
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  // Allow either explicit user-list permission or dispatch access (maps is dispatch-adjacent).
  const permError = await requireAnyPermission(request, ['users.view', 'dispatch.view', 'jobs.assign'])
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)

  const role = searchParams.get('role') || undefined
  const status = searchParams.get('status') || undefined
  const search = searchParams.get('search') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10) || 50, 200)
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10) || 0, 0)

  try {
    const where: any = {
      tenantId: user.tenantId,
    }
    if (role) where.role = role
    if (status) where.status = status
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          phone: true,
          avatar: true,
          lastLoginAt: true,
        },
      }),
      prisma.user.count({ where }),
    ])

    return NextResponse.json({
      users: users.map((u) => ({
        ...u,
        lastLoginAt: u.lastLoginAt?.toISOString() || null,
      })),
      total,
      limit,
      offset,
    })
  } catch (error) {
    console.error('Users list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

