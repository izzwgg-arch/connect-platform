'use client'

import { Button, ButtonProps } from '@/components/ui/button'
import { usePermissions, hasPermission, hasAnyPermission } from '@/hooks/usePermissions'

interface PermissionButtonProps extends ButtonProps {
  permission?: string
  permissions?: string[]
  requireAll?: boolean
  fallback?: React.ReactNode
}

/**
 * Button that is disabled/hidden based on permissions
 */
export function PermissionButton({
  permission,
  permissions,
  requireAll = false,
  fallback = null,
  children,
  ...buttonProps
}: PermissionButtonProps) {
  const { permissions: userPermissions, loading } = usePermissions()

  if (loading) {
    return null
  }

  let hasAccess = false

  if (permission) {
    hasAccess = hasPermission(userPermissions, permission)
  } else if (permissions) {
    hasAccess = requireAll
      ? permissions.every((p) => hasPermission(userPermissions, p))
      : hasAnyPermission(userPermissions, permissions)
  } else {
    hasAccess = true
  }

  if (!hasAccess) {
    return fallback ? <>{fallback}</> : null
  }

  // Spread all button props including onClick
  return <Button {...buttonProps}>{children}</Button>
}
