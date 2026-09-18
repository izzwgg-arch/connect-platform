'use client'

import { usePermissions, hasPermission, hasAnyPermission } from '@/hooks/usePermissions'
import { ReactNode } from 'react'

interface PermissionGuardProps {
  permission?: string
  permissions?: string[]
  requireAll?: boolean
  fallback?: ReactNode
  children: ReactNode
}

/**
 * Component that conditionally renders children based on user permissions
 */
export function PermissionGuard({
  permission,
  permissions,
  requireAll = false,
  fallback = null,
  children,
}: PermissionGuardProps) {
  const { permissions: userPermissions, loading } = usePermissions()

  if (loading) {
    return null // Or a loading spinner
  }

  let hasAccess = false

  if (permission) {
    hasAccess = hasPermission(userPermissions, permission)
  } else if (permissions) {
    hasAccess = requireAll
      ? permissions.every((p) => hasPermission(userPermissions, p))
      : hasAnyPermission(userPermissions, permissions)
  } else {
    // No permission specified, allow access
    hasAccess = true
  }

  return hasAccess ? <>{children}</> : <>{fallback}</>
}

/**
 * Higher-order component to hide elements based on permissions
 */
export function withPermission<T extends object>(
  Component: React.ComponentType<T>,
  permission: string
) {
  return function PermissionWrappedComponent(props: T) {
    return (
      <PermissionGuard permission={permission}>
        <Component {...props} />
      </PermissionGuard>
    )
  }
}
