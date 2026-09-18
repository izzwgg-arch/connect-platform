import { resetPermissionsCache } from '@/hooks/usePermissions'

/**
 * Sign the browser out. This is the sidebar's original `handleLogout` body,
 * moved here unchanged so the account menu in the top bar and the sidebar
 * share one implementation (2026-09-18 reskin — the mockups put "Sign out" in
 * the account menu).
 */
export async function logoutFromBrowser(): Promise<void> {
  const refreshToken = localStorage.getItem('refreshToken')
  if (refreshToken) {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
  }
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
  localStorage.removeItem('user')
  resetPermissionsCache()
  window.location.href = '/auth/login'
}

export interface StoredUser {
  id?: string
  email?: string
  firstName?: string | null
  lastName?: string | null
  avatar?: string | null
  role?: string
  tenantName?: string
}

/** The `user` record the login response stored in localStorage (null when absent/corrupt). */
export function readStoredUser(): StoredUser | null {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('user') : null
    return raw ? (JSON.parse(raw) as StoredUser) : null
  } catch {
    return null
  }
}

export function displayNameOf(user: StoredUser | null): string {
  if (!user) return ''
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return full || user.email || ''
}

export function initialsOf(user: StoredUser | null): string {
  const name = displayNameOf(user)
  const parts = name.split(/[\s@._-]+/).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return (letters || '?').toUpperCase()
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrator',
  MANAGER: 'Manager',
  TECHNICIAN: 'Technician',
  SALES: 'Sales',
  OFFICE: 'Office',
  USER: 'Team member',
}

export function roleLabelOf(user: StoredUser | null): string {
  const role = String(user?.role || '').toUpperCase()
  if (!role) return ''
  return ROLE_LABELS[role] || role.charAt(0) + role.slice(1).toLowerCase().replace(/_/g, ' ')
}
