'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Light/dark switch — the portal's Sun/Moon pair. Reads and writes the one
 * theme state (next-themes, `.dark` on <html>); renders nothing until mounted
 * so the server and client never disagree about the icon.
 */
export function ThemeToggle({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = mounted && theme === 'dark'

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        className={cn('lw-icon-btn h-8 w-8', className)}
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    )
  }

  return (
    <div
      className={cn('inline-flex rounded-full border border-line bg-panel p-[3px]', className)}
      role="group"
      aria-label="Theme"
    >
      <button
        type="button"
        onClick={() => setTheme('light')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors',
          !isDark ? 'bg-primary text-primary-foreground' : 'text-dim hover:text-ink'
        )}
        aria-pressed={!isDark}
      >
        <Sun className="h-3.5 w-3.5" /> Light
      </button>
      <button
        type="button"
        onClick={() => setTheme('dark')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors',
          isDark ? 'bg-primary text-primary-foreground' : 'text-dim hover:text-ink'
        )}
        aria-pressed={isDark}
      >
        <Moon className="h-3.5 w-3.5" /> Dark
      </button>
    </div>
  )
}
