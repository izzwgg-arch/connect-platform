'use client'

import { useCallback, useEffect, useState } from 'react'
import { authFetch } from '@/lib/auth/client'
import { hasPermissionKey } from '@/lib/permission-aliases'

interface PermissionState {
  permissions: string[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

type PermissionsCacheEntry = {
  token: string
  permissions: string[]
  error: string | null
  promise: Promise<string[]> | null
}

let cache: PermissionsCacheEntry | null = null
const listeners = new Set<(patch: Partial<PermissionState>) => void>()

function notify(patch: Partial<PermissionState>) {
  for (const listener of listeners) listener(patch)
}

function clearPermissionsCache() {
  cache = null
}

async function loadPermissions(token: string, force = false): Promise<string[]> {
  if (
    !force &&
    cache &&
    cache.token === token &&
    cache.permissions.length > 0 &&
    !cache.error
  ) {
    return cache.permissions
  }

  if (!force && cache && cache.token === token && cache.promise) {
    return cache.promise
  }

  const entry: PermissionsCacheEntry = {
    token,
    permissions: !force && cache?.token === token ? cache.permissions : [],
    error: null,
    promise: null,
  }
  cache = entry

  entry.promise = (async () => {
    const response = await authFetch('/api/auth/permissions')
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'Session expired'
          : `Failed to fetch permissions (${response.status})`
      )
    }
    const data = await response.json()
    const permissions = Array.isArray(data.permissions) ? data.permissions : []
    entry.permissions = permissions
    entry.error = null
    entry.promise = null
    return permissions
  })()

  try {
    return await entry.promise
  } catch (error) {
    entry.promise = null
    entry.error = error instanceof Error ? error.message : 'Error fetching permissions'
    entry.permissions = []
    throw error
  }
}

/**
 * Hook to get user permissions for client-side UI enforcement.
 * Shared across all consumers so the sidebar/guards don't stampede /api/auth/permissions.
 */
export function usePermissions(): PermissionState {
  const [state, setState] = useState<{
    permissions: string[]
    loading: boolean
    error: string | null
  }>(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
    if (token && cache && cache.token === token && cache.permissions.length > 0 && !cache.error) {
      return { permissions: cache.permissions, loading: false, error: null }
    }
    return { permissions: [], loading: true, error: null }
  })

  const run = useCallback(async (force = false) => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      clearPermissionsCache()
      setState({ permissions: [], loading: false, error: 'Not authenticated' })
      notify({ permissions: [], loading: false, error: 'Not authenticated' })
      return
    }

    let tokenRotated = false
    if (cache && cache.token !== token) {
      // Token rotated (refresh) — keep existing permissions visible while we reload
      // against the new token, instead of flashing a full-page loading state.
      cache = {
        token,
        permissions: cache.permissions,
        error: null,
        promise: null,
      }
      tokenRotated = true
    }

    if (
      !force &&
      !tokenRotated &&
      cache &&
      cache.token === token &&
      cache.permissions.length > 0 &&
      !cache.error
    ) {
      setState({ permissions: cache.permissions, loading: false, error: null })
      return
    }

    // Keep existing permissions visible while refreshing so route guards don't
    // unmount the page and cancel in-flight customer/job document requests.
    const keepShowingExisting = (cache?.permissions?.length ?? 0) > 0
    if (!keepShowingExisting) {
      setState((prev) => ({ ...prev, loading: true, error: null }))
      notify({ loading: true, error: null })
    } else {
      setState((prev) => ({ ...prev, error: null }))
      notify({ error: null })
    }

    try {
      const permissions = await loadPermissions(token, force)
      setState({ permissions, loading: false, error: null })
      notify({ permissions, loading: false, error: null })
    } catch (error) {
      console.error('Error fetching permissions:', error)
      const message = error instanceof Error ? error.message : 'Error fetching permissions'
      setState((prev) => ({
        permissions: prev.permissions.length > 0 ? prev.permissions : [],
        loading: false,
        error: message,
      }))
      notify({ loading: false, error: message })
    }
  }, [])

  useEffect(() => {
    const onPatch = (patch: Partial<PermissionState>) => {
      setState((prev) => ({
        permissions: patch.permissions ?? prev.permissions,
        loading: patch.loading ?? prev.loading,
        error: patch.error === undefined ? prev.error : patch.error,
      }))
    }
    listeners.add(onPatch)
    void run(false)

    const onStorage = (event: StorageEvent) => {
      if (event.key === 'accessToken' || event.key === 'refreshToken') {
        clearPermissionsCache()
        void run(true)
      }
    }
    window.addEventListener('storage', onStorage)

    return () => {
      listeners.delete(onPatch)
      window.removeEventListener('storage', onStorage)
    }
  }, [run])

  const reload = useCallback(async () => {
    clearPermissionsCache()
    await run(true)
  }, [run])

  return { ...state, reload }
}

/** Call after login/logout so the next mount refetches for the new session. */
export function resetPermissionsCache() {
  clearPermissionsCache()
}

/**
 * Check if user has a specific permission
 */
export function hasPermission(permissions: string[], permission: string): boolean {
  return hasPermissionKey(permissions, permission)
}

/**
 * Check if user has any of the specified permissions
 */
export function hasAnyPermission(permissions: string[], requiredPermissions: string[]): boolean {
  return requiredPermissions.some((perm) => hasPermissionKey(permissions, perm))
}

/**
 * Check if user has all of the specified permissions
 */
export function hasAllPermissions(permissions: string[], requiredPermissions: string[]): boolean {
  return requiredPermissions.every((perm) => hasPermissionKey(permissions, perm))
}
