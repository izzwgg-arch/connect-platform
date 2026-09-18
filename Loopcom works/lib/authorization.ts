/**
 * Centralized Authorization Layer
 * Provides permission checking and enforcement
 */

import { prisma } from './prisma'
import { User } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { PERMISSIONS } from './permissions-catalog'
import { hasPermissionKey } from './permission-aliases'

export interface UserWithRoles extends User {
  userRoles?: Array<{
    role: {
      id: string
      name: string
      permissions: Array<{
        permission: {
          key: string
        }
      }>
    }
  }>
}

/**
 * Get all permissions for a user (from all their roles)
 */
const permissionsMemo = new Map<string, { expiresAt: number; permissions: string[] }>()
const PERMISSIONS_MEMO_TTL_MS = 15_000

export async function getUserPermissions(
  userId: string,
  tenantId: string
): Promise<string[]> {
  const memoKey = `${tenantId}:${userId}`
  const cached = permissionsMemo.get(memoKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.permissions
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    include: {
      userRoles: {
        where: {
          role: {
            isActive: true,
          },
        },
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

  if (!user) {
    return []
  }

  const permissions = new Set<string>()

  // Collect permissions from all active roles
  for (const userRole of user.userRoles || []) {
    for (const rolePermission of userRole.role.permissions) {
      permissions.add(rolePermission.permission.key)
    }
  }

  // Include legacy per-user permissions if present.
  if (Array.isArray(user.permissions)) {
    for (const perm of user.permissions) {
      if (typeof perm === 'string') permissions.add(perm)
    }
  }

  // Fallback for tenants that still rely on enum role without user_roles links.
  // user.role is an UPPERCASE enum (e.g. "ADMIN"/"MANAGER") but seeded roles are
  // TitleCase (e.g. "Admin"/"Manager"), so match case-insensitively — otherwise
  // this fallback never fires and such a user silently resolves to zero permissions.
  if (permissions.size === 0) {
    const fallbackRole = await prisma.role.findFirst({
      where: {
        tenantId,
        name: { equals: user.role, mode: 'insensitive' },
        isActive: true,
      },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    })
    for (const rolePermission of fallbackRole?.permissions || []) {
      permissions.add(rolePermission.permission.key)
    }
  }

  // Guarantee full admin visibility on web when user enum role is ADMIN.
  if (user.role === 'ADMIN') {
    for (const perm of PERMISSIONS) {
      permissions.add(perm.key)
    }
  }

  const result = Array.from(permissions)
  permissionsMemo.set(memoKey, { permissions: result, expiresAt: Date.now() + PERMISSIONS_MEMO_TTL_MS })
  return result
}

/**
 * Check if user has a specific permission
 */
export async function hasPermission(
  userId: string,
  tenantId: string,
  permission: string
): Promise<boolean> {
  const userPermissions = await getUserPermissions(userId, tenantId)
  return hasPermissionKey(userPermissions, permission)
}

/**
 * Check if user has any of the specified permissions
 */
export async function hasAnyPermission(
  userId: string,
  tenantId: string,
  permissions: string[]
): Promise<boolean> {
  const userPermissions = await getUserPermissions(userId, tenantId)
  return permissions.some((perm) => hasPermissionKey(userPermissions, perm))
}

/**
 * Check if user has all of the specified permissions
 */
export async function hasAllPermissions(
  userId: string,
  tenantId: string,
  permissions: string[]
): Promise<boolean> {
  const userPermissions = await getUserPermissions(userId, tenantId)
  return permissions.every((perm) => hasPermissionKey(userPermissions, perm))
}

function logPermissionDenied(
  request: NextRequest,
  user: any,
  requiredPermissions: string[],
  mode: 'all' | 'any'
) {
  const username =
    user?.email ||
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
    user?.id ||
    'unknown'
  const module = requiredPermissions[0]?.split('.')[0] || 'unknown'
  console.warn('[authorization] Permission denied', {
    userId: user?.id || null,
    username,
    module,
    permissionRequired: requiredPermissions,
    mode,
    requestedAction: `${request.method} ${request.nextUrl.pathname}`,
    timestamp: new Date().toISOString(),
  })
}

/**
 * Require permission middleware for API routes
 * Returns error response if user doesn't have permission
 */
export async function requirePermission(
  request: NextRequest,
  permission: string
): Promise<NextResponse | null> {
  const user = (request as any).user
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hasPerm = await hasPermission(user.id, user.tenantId, permission)
  if (!hasPerm) {
    logPermissionDenied(request, user, [permission], 'all')
    return NextResponse.json(
      { error: 'Forbidden: Insufficient permissions' },
      { status: 403 }
    )
  }

  return null // Permission granted
}

/**
 * Require any of the specified permissions
 */
export async function requireAnyPermission(
  request: NextRequest,
  permissions: string[]
): Promise<NextResponse | null> {
  const user = (request as any).user
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hasPerm = await hasAnyPermission(user.id, user.tenantId, permissions)
  if (!hasPerm) {
    logPermissionDenied(request, user, permissions, 'any')
    return NextResponse.json(
      { error: 'Forbidden: Insufficient permissions' },
      { status: 403 }
    )
  }

  return null
}

/**
 * Check if user can access a specific resource
 * This is for attribute-based access control (constraints)
 */
export async function canAccessResource(
  userId: string,
  tenantId: string,
  resourceType: string,
  resourceId: string,
  action: string
): Promise<boolean> {
  // First check if user has the base permission
  const permission = `${resourceType}.${action}`
  const hasBasePermission = await hasPermission(userId, tenantId, permission)

  if (!hasBasePermission) {
    return false
  }

  // Check for constraints
  const constraints = await prisma.permissionConstraint.findMany({
    where: {
      OR: [
        { userId },
        {
          role: {
            userRoles: {
              some: {
                userId,
              },
            },
          },
        },
      ],
      permission: {
        key: permission,
      },
    },
    include: {
      permission: true,
    },
  })

  // If no constraints, base permission is sufficient
  if (constraints.length === 0) {
    return true
  }

  // Apply constraints
  for (const constraint of constraints) {
    switch (constraint.constraintType) {
      case 'own_records_only':
        // Check if user owns the resource
        const resource = await prisma.$queryRawUnsafe(
          `SELECT "userId" FROM ${resourceType} WHERE id = $1 AND "tenantId" = $2`,
          resourceId,
          tenantId
        )
        if (Array.isArray(resource) && resource[0]?.userId !== userId) {
          return false
        }
        break

      case 'team_only':
        // Check if resource is assigned to user's team
        // This would require team relationships to be implemented
        // For now, return true if base permission exists
        break

      case 'assigned_jobs_only':
        if (resourceType === 'jobs') {
          const assignment = await prisma.jobAssignment.findFirst({
            where: {
              jobId: resourceId,
              userId,
            },
          })
          if (!assignment) {
            return false
          }
        }
        break

      // Add more constraint types as needed
    }
  }

  return true
}

/**
 * Get user's effective permissions (for display in UI)
 */
export async function getEffectivePermissions(
  userId: string,
  tenantId: string
): Promise<{
  permissions: string[]
  roles: Array<{ id: string; name: string; isSystem: boolean }>
}> {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
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

  if (!user) {
    return { permissions: [], roles: [] }
  }

  const permissions = new Set<string>()
  const roles = []

  for (const userRole of user.userRoles || []) {
    roles.push({
      id: userRole.role.id,
      name: userRole.role.name,
      isSystem: userRole.role.isSystem,
    })

    for (const rolePermission of userRole.role.permissions) {
      permissions.add(rolePermission.permission.key)
    }
  }

  return {
    permissions: Array.from(permissions),
    roles,
  }
}

/**
 * Get all mobile permissions for a user (from all their roles)
 */
export async function getUserMobilePermissions(
  userId: string,
  tenantId: string
): Promise<string[]> {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    include: {
      userRoles: {
        where: {
          role: {
            isActive: true,
          },
        },
        include: {
          role: true,
        },
      },
    },
  })

  if (!user) {
    return []
  }

  const mobilePermissions = new Set<string>()

  // Collect mobile permissions from all active roles
  for (const userRole of user.userRoles || []) {
    const role = userRole.role
    if (role.mobilePermissions && Array.isArray(role.mobilePermissions)) {
      for (const perm of role.mobilePermissions) {
        if (typeof perm === 'string') {
          mobilePermissions.add(perm)
        }
      }
    }
  }

  // Support legacy user-level permission arrays that may contain mobile keys.
  if (Array.isArray(user.permissions)) {
    for (const perm of user.permissions) {
      if (typeof perm === 'string' && perm.startsWith('mobile.')) {
        mobilePermissions.add(perm)
      }
    }
  }

  // Fallback role lookup when user_roles assignments are missing.
  // Case-insensitive: user.role is UPPERCASE enum, seeded role names are TitleCase.
  if (mobilePermissions.size === 0) {
    const fallbackRole = await prisma.role.findFirst({
      where: {
        tenantId,
        name: { equals: user.role, mode: 'insensitive' },
        isActive: true,
      },
      select: {
        mobilePermissions: true,
      },
    })
    const fallbackMobile = Array.isArray(fallbackRole?.mobilePermissions)
      ? (fallbackRole?.mobilePermissions as unknown[])
      : []
    for (const perm of fallbackMobile) {
      if (typeof perm === 'string') {
        mobilePermissions.add(perm)
      }
    }
  }

  // Guarantee full admin visibility on mobile.
  if (user.role === 'ADMIN') {
    for (const perm of PERMISSIONS) {
      if (perm.key.startsWith('mobile.') || perm.key === 'canCreateSchedulesForOthers') {
        mobilePermissions.add(perm.key)
      }
    }
  }

  // Backward-compatible defaults for legacy role records missing newer mobile permissions.
  if (user.role === 'FIELD') {
    mobilePermissions.add('mobile.jobs.track_time')
    mobilePermissions.add('mobile.jobs.edit_own_time_entries')
  }
  if (user.role === 'MANAGER') {
    mobilePermissions.add('mobile.jobs.track_time')
    mobilePermissions.add('mobile.jobs.edit_own_time_entries')
    mobilePermissions.add('mobile.jobs.edit_team_time_entries')
  }

  return Array.from(mobilePermissions)
}

/**
 * Check if user has a specific mobile permission
 */
export async function hasMobilePermission(
  userId: string,
  tenantId: string,
  permission: string
): Promise<boolean> {
  const mobilePermissions = await getUserMobilePermissions(userId, tenantId)
  return mobilePermissions.includes(permission)
}

/**
 * Check if user has any of the specified mobile permissions
 */
export async function hasAnyMobilePermission(
  userId: string,
  tenantId: string,
  permissions: string[]
): Promise<boolean> {
  const mobilePermissions = await getUserMobilePermissions(userId, tenantId)
  return permissions.some((perm) => mobilePermissions.includes(perm))
}

/**
 * Check if request is from mobile app (based on User-Agent header)
 */
export function isMobileRequest(request: NextRequest): boolean {
  const userAgent = request.headers.get('user-agent')
  return userAgent?.includes('TrimProMobile') || false
}

/**
 * Require mobile permission middleware for API routes
 * Returns error response if user doesn't have permission
 */
export async function requireMobilePermission(
  request: NextRequest,
  permission: string
): Promise<NextResponse | null> {
  const user = (request as any).user
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hasPerm = await hasMobilePermission(user.id, user.tenantId, permission)
  if (!hasPerm) {
    return NextResponse.json(
      { error: 'Forbidden: Insufficient mobile permissions' },
      { status: 403 }
    )
  }

  return null // Permission granted
}

/**
 * Allow either a web permission OR (on mobile requests) a mobile permission.
 * Web permission checks are unchanged for non-mobile clients.
 */
export async function requireWebOrMobilePermission(
  request: NextRequest,
  webPermission: string,
  mobilePermission: string
): Promise<NextResponse | null> {
  return requireWebOrAnyMobilePermission(request, webPermission, [mobilePermission])
}

/**
 * Allow either a web permission OR (on mobile requests) any of the mobile permissions.
 */
export async function requireWebOrAnyMobilePermission(
  request: NextRequest,
  webPermission: string,
  mobilePermissions: string[]
): Promise<NextResponse | null> {
  const user = (request as any).user
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hasWeb = await hasPermission(user.id, user.tenantId, webPermission)
  if (hasWeb) return null

  if (isMobileRequest(request)) {
    const hasMobile = await hasAnyMobilePermission(user.id, user.tenantId, mobilePermissions)
    if (hasMobile) return null
  }

  logPermissionDenied(request, user, [webPermission, ...mobilePermissions], 'any')
  return NextResponse.json(
    { error: 'Forbidden: Insufficient permissions' },
    { status: 403 }
  )
}
