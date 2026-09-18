import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'roles.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const roles = await prisma.role.findMany({
      where: {
        tenantId: user.tenantId,
      },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
      orderBy: {
        isSystem: 'desc',
      },
    })

    return NextResponse.json({ roles })
  } catch (error) {
    console.error('Get roles error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'roles.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { name, description, permissions, mobilePermissions } = body

    if (!name) {
      return NextResponse.json({ error: 'Role name is required' }, { status: 400 })
    }

    // Create role
    const role = await prisma.role.create({
      data: {
        tenantId: user.tenantId,
        name,
        description: description || null,
        isSystem: false,
        isActive: true,
        mobilePermissions: mobilePermissions && Array.isArray(mobilePermissions) ? mobilePermissions : [],
      },
    })

    // Assign permissions
    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      const permissionRecords = await prisma.permission.findMany({
        where: {
          key: {
            in: permissions,
          },
        },
      })

      for (const permission of permissionRecords) {
        await prisma.rolePermission.create({
          data: {
            roleId: role.id,
            permissionId: permission.id,
          },
        })
      }
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'CREATE',
        entityType: 'Role',
        entityId: role.id,
        changes: {
          name,
          description,
          permissions,
          mobilePermissions,
        },
      },
    })

    return NextResponse.json({ role }, { status: 201 })
  } catch (error) {
    console.error('Create role error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
