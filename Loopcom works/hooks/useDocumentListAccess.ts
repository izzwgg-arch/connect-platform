'use client'

import { usePermissions, hasPermission } from '@/hooks/usePermissions'

export function useDocumentListAccess(viewPermission: string, createPermission: string) {
  const { permissions, loading: permissionsLoading } = usePermissions()
  return {
    permissionsLoading,
    canViewList: hasPermission(permissions, viewPermission),
    canCreate: hasPermission(permissions, createPermission),
  }
}

export function postCreateRedirectPath(
  permissions: string[],
  moduleSegment: string,
  viewPermission: string,
  createdId: string
): string {
  if (hasPermission(permissions, viewPermission)) {
    return `/dashboard/${moduleSegment}/${createdId}`
  }
  return `/dashboard/${moduleSegment}?created=1`
}
