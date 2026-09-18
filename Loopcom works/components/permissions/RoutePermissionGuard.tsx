'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ShieldAlert } from 'lucide-react'
import { getRoutePermission } from '@/lib/route-permissions'
import { usePermissions, hasPermission, hasAnyPermission } from '@/hooks/usePermissions'

interface RoutePermissionGuardProps {
  children: React.ReactNode
}

/**
 * Blocks direct URL access to dashboard routes when the user lacks view permission.
 */
export function RoutePermissionGuard({ children }: RoutePermissionGuardProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { permissions, loading, error, reload } = usePermissions()
  const [checked, setChecked] = useState(false)
  const [allowed, setAllowed] = useState(true)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (loading) return

    const required = getRoutePermission(pathname || '')
    if (!required) {
      setAllowed(true)
      setChecked(true)
      return
    }

    // Permissions failed to load — keep page blocked but show retry, not "Access Denied".
    if (error) {
      setAllowed(false)
      setChecked(true)
      return
    }

    const hasAccess = Array.isArray(required)
      ? hasAnyPermission(permissions, required)
      : hasPermission(permissions, required)

    setAllowed(hasAccess)
    setChecked(true)
  }, [loading, pathname, permissions, error])

  // Only block the first check. Refreshing permissions must not unmount the page
  // (that aborts/races client data fetches and surfaces false "Failed to load" errors).
  if (!checked || (loading && !allowed && !error)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent" />
      </div>
    )
  }

  if (!allowed) {
    const permissionsFailed = Boolean(error)
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4 text-center">
        <ShieldAlert className="h-12 w-12 text-red-500" />
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {permissionsFailed ? 'Couldn’t verify permissions' : 'Access Denied'}
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            {permissionsFailed
              ? 'Please retry. If this keeps happening, log out and back in.'
              : 'You do not have permission to view this page.'}
          </p>
        </div>
        <button
          type="button"
          disabled={retrying}
          onClick={async () => {
            if (permissionsFailed) {
              setRetrying(true)
              try {
                await reload()
              } finally {
                setRetrying(false)
              }
              return
            }
            router.push('/dashboard')
          }}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
        >
          {permissionsFailed ? (retrying ? 'Retrying…' : 'Retry') : 'Go to Dashboard'}
        </button>
      </div>
    )
  }

  return <>{children}</>
}
