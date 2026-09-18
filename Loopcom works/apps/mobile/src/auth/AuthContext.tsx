import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiRequest, setUnauthorizedHandler } from '../api/client'
import { clearAuth, getAccessToken, getOrCreateDeviceId, getRefreshToken, getStoredUser, saveAuth } from './secure-storage'
import { AuthUser } from '../types/models'
import { registerPushToken, unregisterPushToken } from '../notifications/registerPush'
import { API_BASE_URL } from '../config/env'

interface AuthContextValue {
  user: AuthUser | null
  token: string | null
  isLoading: boolean
  mobilePermissions: string[]
  permissions: string[]
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshPermissions: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

/** Don't block the login screen forever if SecureStore/network hangs. */
const SESSION_RESTORE_TIMEOUT_MS = 4_000

interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [mobilePermissions, setMobilePermissions] = useState<string[]>([])
  const [permissions, setPermissions] = useState<string[]>([])

  const fetchPermissions = useCallback(async () => {
    try {
      const meResponse = await apiRequest<{
        user: AuthUser
        mobilePermissions: string[]
        permissions: string[]
      }>('/api/me')

      setMobilePermissions(meResponse.mobilePermissions || [])
      setPermissions(meResponse.permissions || [])
      return meResponse.mobilePermissions || []
    } catch (error) {
      console.error('Failed to fetch permissions:', error)
      setMobilePermissions([])
      setPermissions([])
      return []
    }
  }, [])

  const signOut = useCallback(async () => {
    const refreshToken = await getRefreshToken()
    const deviceId = await getOrCreateDeviceId()
    if (refreshToken) {
      await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'TrimProMobile',
        },
        body: JSON.stringify({ refreshToken, deviceId }),
      }).catch(() => null)
    }
    await unregisterPushToken().catch(() => null)
    setUser(null)
    setToken(null)
    setMobilePermissions([])
    setPermissions([])
    await clearAuth()
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void signOut()
    })
    return () => setUnauthorizedHandler(null)
  }, [signOut])

  useEffect(() => {
    let mounted = true
    // Absolute failsafe: never keep the splash/spinner longer than this,
    // even if SecureStore or clearAuth hangs after a timed-out restore.
    const hardFailsafe = setTimeout(() => {
      if (!mounted) return
      // Keep this Error message — release builds strip console.* strings.
      void new Error('AUTH_HARD_FAILSAFE_1_0_14')
      setUser(null)
      setToken(null)
      setMobilePermissions([])
      setPermissions([])
      setIsLoading(false)
    }, SESSION_RESTORE_TIMEOUT_MS + 2_000)

    ;(async () => {
      try {
        const [storedUser, refreshToken] = await withTimeout(
          Promise.all([getStoredUser(), getRefreshToken()]),
          SESSION_RESTORE_TIMEOUT_MS,
          'auth storage read'
        )
        if (!mounted) return

        if (storedUser && refreshToken) {
          // Trigger a protected request to force token refresh when access token expired.
          // Cap wait so a hung network never traps the user on the splash spinner.
          const meResponse = await withTimeout(
            apiRequest<{
              user: AuthUser
              mobilePermissions: string[]
              permissions: string[]
            }>('/api/me'),
            SESSION_RESTORE_TIMEOUT_MS,
            'session restore /api/me'
          )
          const latestAccessToken = await getAccessToken().catch(() => null)
          if (!mounted) return
          if (latestAccessToken) {
            setToken(latestAccessToken)
          }
          setUser(meResponse.user)
          setMobilePermissions(meResponse.mobilePermissions || [])
          setPermissions(meResponse.permissions || [])
        } else {
          // Don't await — SecureStore delete can hang on some devices.
          void clearAuth().catch(() => null)
        }
      } catch (error) {
        console.warn('[auth] session restore failed, clearing local auth state', error)
        setUser(null)
        setToken(null)
        setMobilePermissions([])
        setPermissions([])
        void clearAuth().catch(() => null)
      } finally {
        clearTimeout(hardFailsafe)
        if (mounted) setIsLoading(false)
      }
    })()
    return () => {
      mounted = false
      clearTimeout(hardFailsafe)
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const deviceId = await getOrCreateDeviceId()
    const response = await apiRequest<LoginResponse>('/api/auth/login', 'POST', {
      email,
      password,
      deviceId,
      clientType: 'mobile',
    })
    await saveAuth(response.accessToken, response.refreshToken, JSON.stringify(response.user))
    setToken(response.accessToken)
    setUser(response.user)

    // Register push immediately after login so backend always has a token.
    await registerPushToken().catch((error) => {
      console.warn('Push registration after login failed:', error)
    })

    // Fetch permissions after login
    await fetchPermissions()
  }, [fetchPermissions])

  const refreshPermissions = useCallback(async () => {
    if (token) {
      await fetchPermissions()
    }
  }, [token, fetchPermissions])

  const value = useMemo(
    () => ({
      user,
      token,
      isLoading,
      mobilePermissions,
      permissions,
      signIn,
      signOut,
      refreshPermissions,
    }),
    [isLoading, signIn, signOut, token, user, mobilePermissions, permissions, refreshPermissions]
  )

  // Never block the tree on auth bootstrap. While restoring, token is null so
  // RootNavigator shows Login; a successful restore swaps to the main app.
  // Blocking here caused infinite splash when SecureStore/network hung.
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

