'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useTheme } from 'next-themes'
import { Bell, ChevronDown, HelpCircle, LogOut, Moon, Sun, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { displayNameOf, initialsOf, logoutFromBrowser, readStoredUser, type StoredUser } from '@/lib/auth/client-logout'

/**
 * Account menu in the top bar — the portal's ProfileMenu pattern (mockup board 04):
 * 24px avatar + name + chevron opens a 260px panel with My profile, Notification
 * settings, the Light/Dark segmented control, Help & support, and Sign out.
 * Every entry is an existing page or the existing logout call — nothing new behind it.
 */
export function ProfileMenu() {
  const [user, setUser] = useState<StoredUser | null>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    setUser(readStoredUser())
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isDark = mounted && theme === 'dark'
  const name = displayNameOf(user) || 'Account'

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="lw-profile-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <span className="lw-profile-avatar">{initialsOf(user)}</span>
        <span className="lw-profile-name hidden sm:inline">{name}</span>
        <ChevronDown className="h-3.5 w-3.5 text-dim" strokeWidth={2} />
      </button>

      {open && (
        <div className="lw-dd right-0 top-[calc(100%+6px)] w-[260px]" role="menu">
          <div className="flex items-center gap-2.5 border-b border-line px-2.5 pb-2.5 pt-2">
            <span className="lw-avatar h-[34px] w-[34px] text-xs">{initialsOf(user)}</span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-bold text-ink">{name}</span>
              {user?.email && <span className="block truncate text-[11.5px] text-dim">{user.email}</span>}
            </span>
          </div>
          <Link href="/dashboard/settings" className="lw-dd-item" role="menuitem" onClick={() => setOpen(false)}>
            <User className="h-[15px] w-[15px]" /> My profile
          </Link>
          <Link href="/dashboard/notifications" className="lw-dd-item" role="menuitem" onClick={() => setOpen(false)}>
            <Bell className="h-[15px] w-[15px]" /> Notifications
          </Link>
          <div className="lw-dd-label">Appearance</div>
          <div className="flex gap-1.5 px-2.5 pb-2 pt-0.5" role="group" aria-label="Theme">
            <button
              type="button"
              onClick={() => setTheme('light')}
              className={cn('lw-seg-btn', !isDark && 'is-on')}
              aria-pressed={!isDark}
            >
              <Sun className="h-[13px] w-[13px]" strokeWidth={2} /> Light
            </button>
            <button
              type="button"
              onClick={() => setTheme('dark')}
              className={cn('lw-seg-btn', isDark && 'is-on')}
              aria-pressed={isDark}
            >
              <Moon className="h-[13px] w-[13px]" strokeWidth={2} /> Dark
            </button>
          </div>
          <div className="lw-dd-sep" />
          <Link href="/dashboard/help" className="lw-dd-item" role="menuitem" onClick={() => setOpen(false)}>
            <HelpCircle className="h-[15px] w-[15px]" /> Help &amp; support
          </Link>
          <div className="lw-dd-sep" />
          <button type="button" className="lw-dd-item is-danger" role="menuitem" onClick={() => void logoutFromBrowser()}>
            <LogOut className="h-[15px] w-[15px]" /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}
