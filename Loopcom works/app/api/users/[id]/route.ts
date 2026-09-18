import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { requirePermission } from '@/lib/authorization'
import { getDefaultPermissions } from '@/lib/permissions'
import { parseAssignedJobTypes } from '@/lib/jobs/job-type-scope'

const ALLOWED_ROLES = new Set(['ADMIN', 'MANAGER', 'OFFICE', 'FIELD', 'SALES', 'ACCOUNTING'])
const ALLOWED_STATUSES = new Set(['ACTIVE', 'INACTIVE', 'INVITED', 'SUSPENDED'])

function deriveBaseRole(roleName: string): string {
  const normalized = roleName.trim().toUpperCase()
  return ALLOWED_ROLES.has(normalized) ? normalized : 'OFFICE'
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'users.edit')
  if (permError) return permError

  const actor = getAuthUser(request)

  try {
    const body = await request.json()
    const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : undefined
    const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : undefined
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
    const phone = typeof body.phone === 'string' ? body.phone.trim() : body.phone === null ? null : undefined
    const requestedRole = typeof body.role === 'string' ? body.role.trim().toUpperCase() : undefined
    const roleId = typeof body.roleId === 'string' ? body.roleId.trim() : ''
    const status = typeof body.status === 'string' ? body.status.trim().toUpperCase() : undefined
    const rawManagerId = typeof body.managerId === 'string' ? body.managerId.trim() : body.managerId
    const managerIdFromBody = rawManagerId === '' || rawManagerId === null ? null : rawManagerId
    const allowWebLogin = typeof body.allowWebLogin === 'boolean' ? body.allowWebLogin : true
    const allowMobileLogin = typeof body.allowMobileLogin === 'boolean' ? body.allowMobileLogin : true
    const assignedJobTypes =
      body.assignedJobTypes !== undefined ? parseAssignedJobTypes(body.assignedJobTypes) : undefined

    if (!firstName || !lastName || !email || !status || (!requestedRole && !roleId)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    let selectedRoleRecord: {
      id: string
      name: string
      permissions: Array<{ permission: { key: string } }>
    } | null = null
    if (roleId) {
      selectedRoleRecord = await prisma.role.findFirst({
        where: {
          id: roleId,
          tenantId: actor.tenantId,
          isActive: true,
        },
        include: {
          permissions: {
            include: {
              permission: {
                select: { key: true },
              },
            },
          },
        },
      })
      if (!selectedRoleRecord) {
        return NextResponse.json({ error: 'Selected role not found' }, { status: 400 })
      }
    }

    const role = selectedRoleRecord ? deriveBaseRole(selectedRoleRecord.name) : requestedRole
    if (!role || !ALLOWED_ROLES.has(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }

    if (!ALLOWED_STATUSES.has(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        id: params.id,
        tenantId: actor.tenantId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        status: true,
        managerId: true,
        allowWebLogin: true,
        allowMobileLogin: true,
        userRoles: {
          select: {
            roleId: true,
          },
        },
      },
    })

    if (!existingUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const duplicate = await prisma.user.findFirst({
      where: {
        tenantId: actor.tenantId,
        email,
        id: { not: params.id },
      },
      select: { id: true },
    })
    if (duplicate) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 400 })
    }

    let normalizedManagerId: string | null = existingUser.managerId || null
    if (role === 'FIELD') {
      if (managerIdFromBody === null) {
        normalizedManagerId = null
      } else if (managerIdFromBody !== undefined) {
        if (typeof managerIdFromBody !== 'string' || !managerIdFromBody) {
          return NextResponse.json({ error: 'Invalid manager selection' }, { status: 400 })
        }
        if (managerIdFromBody === params.id) {
          return NextResponse.json({ error: 'A user cannot be their own manager' }, { status: 400 })
        }

        const managerUser = await prisma.user.findFirst({
          where: {
            id: managerIdFromBody,
            tenantId: actor.tenantId,
            role: 'MANAGER',
          },
          select: { id: true },
        })
        if (!managerUser) {
          return NextResponse.json({ error: 'Selected manager is invalid' }, { status: 400 })
        }
        normalizedManagerId = managerUser.id
      }
    }

    const selectedPermissionKeys =
      selectedRoleRecord && selectedRoleRecord.permissions.length > 0
        ? selectedRoleRecord.permissions.map((rp) => rp.permission.key)
        : getDefaultPermissions(role)

    const updatedUser = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: params.id },
        data: {
          firstName,
          lastName,
          email,
          phone: phone || null,
          role: role as any,
          status: status as any,
          managerId: role === 'FIELD' ? normalizedManagerId : null,
          allowWebLogin,
          allowMobileLogin,
          ...(assignedJobTypes !== undefined ? { assignedJobTypes } : {}),
          permissions: selectedPermissionKeys,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          status: true,
          managerId: true,
          allowWebLogin: true,
          allowMobileLogin: true,
          assignedJobTypes: true,
        },
      })

      await tx.userRoleAssignment.deleteMany({
        where: {
          userId: params.id,
          user: { tenantId: actor.tenantId },
        },
      })

      const fallbackRoleId =
        selectedRoleRecord?.id ||
        (
          await tx.role.findFirst({
            where: {
              tenantId: actor.tenantId,
              name: role,
              isActive: true,
            },
            select: { id: true },
          })
        )?.id

      if (fallbackRoleId) {
        await tx.userRoleAssignment.create({
          data: {
            userId: params.id,
            roleId: fallbackRoleId,
            assignedBy: actor.id,
          },
        })
      }

      return updated
    })

    // Keep assignments consistent if this user is no longer a manager.
    if (existingUser.role === 'MANAGER' && role !== 'MANAGER') {
      await prisma.user.updateMany({
        where: {
          tenantId: actor.tenantId,
          managerId: params.id,
        },
        data: {
          managerId: null,
        },
      })
    }

    await prisma.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'User',
        entityId: updatedUser.id,
        changes: {
          before: existingUser,
          after: updatedUser,
          selectedRoleId: selectedRoleRecord?.id || null,
          selectedRoleName: selectedRoleRecord?.name || role,
        },
      },
    })

    return NextResponse.json({ user: updatedUser })
  } catch (error) {
    console.error('Update user error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'users.deactivate')
  if (permError) return permError

  const actor = getAuthUser(request)

  if (params.id === actor.id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 })
  }

  try {
    const existingUser = await prisma.user.findFirst({
      where: {
        id: params.id,
        tenantId: actor.tenantId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
      },
    })

    if (!existingUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    await prisma.$transaction(async (tx) => {
      await tx.userRoleAssignment.deleteMany({
        where: {
          userId: params.id,
        },
      })

      await tx.user.updateMany({
        where: {
          tenantId: actor.tenantId,
          managerId: params.id,
        },
        data: {
          managerId: null,
        },
      })

      await tx.user.delete({
        where: { id: params.id },
      })

      await tx.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          action: 'DELETE',
          entityType: 'User',
          entityId: existingUser.id,
          changes: {
            deletedUser: existingUser,
          },
        },
      })
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete user error:', error)
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 })
  }
}
