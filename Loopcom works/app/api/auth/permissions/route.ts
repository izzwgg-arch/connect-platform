import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { getUserPermissions, getUserMobilePermissions } from '@/lib/authorization'
import {
  ACCESS_ALL_JOB_TYPES_PERMISSION,
  getUserAssignedJobTypes,
} from '@/lib/jobs/job-type-scope'
import { hasPermissionKey } from '@/lib/permission-aliases'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)

  try {
    const permissions = await getUserPermissions(user.id, user.tenantId)
    const mobilePermissions = await getUserMobilePermissions(user.id, user.tenantId)
    const assignedJobTypes = await getUserAssignedJobTypes(user.id, user.tenantId)
    const canAccessAllJobTypes =
      user.role === 'ADMIN' || hasPermissionKey(permissions, ACCESS_ALL_JOB_TYPES_PERMISSION)

    return NextResponse.json({
      permissions,
      mobilePermissions,
      assignedJobTypes,
      canAccessAllJobTypes,
    })
  } catch (error) {
    console.error('Get permissions error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
