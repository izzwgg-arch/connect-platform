import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { getUserPermissions, getUserMobilePermissions, getEffectivePermissions } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)

  try {
    // Get full user data
    const fullUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!fullUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get permissions
    const webPermissions = await getUserPermissions(user.id, user.tenantId)
    const mobilePermissions = await getUserMobilePermissions(user.id, user.tenantId)
    const { roles } = await getEffectivePermissions(user.id, user.tenantId)

    // Get primary role (first active role, or fallback to user.role enum)
    const primaryRole = fullUser.userRoles?.[0]?.role || null

    return NextResponse.json({
      user: {
        id: fullUser.id,
        email: fullUser.email,
        firstName: fullUser.firstName,
        lastName: fullUser.lastName,
        phone: fullUser.phone,
        avatar: fullUser.avatar,
        role: fullUser.role, // UserRole enum (ADMIN, OFFICE, FIELD, etc.)
        status: fullUser.status,
        tenantId: fullUser.tenantId,
      },
      role: primaryRole
        ? {
            id: primaryRole.id,
            name: primaryRole.name,
            description: primaryRole.description,
            isSystem: primaryRole.isSystem,
          }
        : null,
      roles: roles,
      permissions: webPermissions,
      mobilePermissions: mobilePermissions,
    })
  } catch (error) {
    console.error('Get user info error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
