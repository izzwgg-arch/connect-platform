/**
 * Reusable API permission guards mapped to HTTP methods.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAnyPermission, requirePermission } from './authorization'

export type CrudAction = 'view' | 'create' | 'edit' | 'delete'

const METHOD_TO_ACTION: Record<string, CrudAction> = {
  GET: 'view',
  HEAD: 'view',
  POST: 'create',
  PUT: 'edit',
  PATCH: 'edit',
  DELETE: 'delete',
}

/** Map HTTP method to `{module}.{action}` permission. */
export async function requireCrudPermission(
  request: NextRequest,
  module: string,
  action?: CrudAction
): Promise<NextResponse | null> {
  const resolvedAction = action ?? METHOD_TO_ACTION[request.method] ?? 'view'
  return requirePermission(request, `${module}.${resolvedAction}`)
}

/** Per-method permission map, e.g. { GET: 'tasks.view', POST: 'tasks.create' }. */
export async function requireMethodPermissions(
  request: NextRequest,
  map: Partial<Record<string, string | string[]>>
): Promise<NextResponse | null> {
  const perm = map[request.method]
  if (!perm) {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
  }
  if (Array.isArray(perm)) {
    return requireAnyPermission(request, perm)
  }
  return requirePermission(request, perm)
}

/** Web permission with optional mobile bypass via mobile permission keys. */
export async function requireWebOrMobilePermission(
  request: NextRequest,
  webPermission: string,
  mobilePermissions: string[],
  isMobile: boolean
): Promise<NextResponse | null> {
  if (isMobile && mobilePermissions.length > 0) {
    return requireAnyPermission(request, mobilePermissions)
  }
  return requirePermission(request, webPermission)
}
