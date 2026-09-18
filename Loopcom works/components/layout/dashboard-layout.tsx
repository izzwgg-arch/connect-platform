'use client'

import { Sidebar } from './sidebar'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { Menu } from 'lucide-react'
import { TrimProLogo } from '@/components/branding/TrimProLogo'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { ProfileMenu } from '@/components/layout/ProfileMenu'
import { QboSyncFailureNotifier } from '@/components/qbo/QboSyncFailureNotifier'
import { GlobalSearch } from '@/components/search/GlobalSearch'
import { RoutePermissionGuard } from '@/components/permissions/RoutePermissionGuard'
import { DashboardNavCapture } from '@/components/navigation/DashboardNavCapture'

// Pages with their own fixed-height, self-scrolling app UI (chat panes, etc.)
// opt out of the standard padded content shell + footer, which otherwise
// forces a second outer scrollbar around their internal one.
const FULL_BLEED_PREFIXES = ['/dashboard/messages']

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const isFullBleed = FULL_BLEED_PREFIXES.some((prefix) => pathname?.startsWith(prefix))
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    const accessToken = localStorage.getItem('accessToken')
    const userRaw = localStorage.getItem('user')

    if (!accessToken || !userRaw) {
      router.push('/auth/login')
      return
    }

    try {
      const parsed = JSON.parse(userRaw)
      setIsAdmin(parsed?.role === 'ADMIN')
    } catch {}

    setLoading(false)
  }, [router])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-dim">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-screen flex-col bg-page">
      <DashboardNavCapture />
      {isAdmin && <QboSyncFailureNotifier />}

      {/* Top bar — the portal's 56px bar across the full width: brand · search · bell · account */}
      <header className="lw-topbar grid h-14 shrink-0 grid-cols-[auto_1fr_auto] items-center gap-3 px-4 pl-3 z-40">
        <div className="lw-topbar-brand">
          {/* Hamburger — mobile only */}
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="lw-icon-btn lg:hidden flex min-h-[44px] min-w-[44px] shrink-0"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/dashboard" aria-label="Go to dashboard" className="inline-flex items-center">
            <TrimProLogo variant="light" size="md" />
          </Link>
        </div>

        {/* Global search bar */}
        <div className="flex justify-center px-2">
          <div className="w-full max-w-[720px]">
            <GlobalSearch />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <NotificationBell />
          <ProfileMenu />
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
      <Sidebar
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

        {isFullBleed ? (
          <main className="lw-main flex-1 min-h-0 overflow-hidden bg-page">
            <RoutePermissionGuard>{children}</RoutePermissionGuard>
          </main>
        ) : (
          <main className="lw-main flex-1 overflow-y-auto overflow-x-hidden bg-page">
            <div className="min-h-full flex flex-col bg-page p-4 sm:px-[26px] sm:pb-6 sm:pt-[22px]">
              <div className="flex-1">
                <RoutePermissionGuard>{children}</RoutePermissionGuard>
              </div>
              <footer className="mt-10 border-t border-line pt-4 text-xs text-dim flex flex-wrap items-center justify-between gap-3">
                <div>© {new Date().getFullYear()} Loopcom LLC · LoopCom Works</div>
                <div className="flex items-center gap-4">
                  <Link href="/privacy" className="hover:underline">
                    Privacy Policy
                  </Link>
                  <Link href="/terms" className="hover:underline">
                    Terms
                  </Link>
                  <a className="hover:underline" href="mailto:support@loopcom.net">
                    support@loopcom.net
                  </a>
                </div>
              </footer>
            </div>
          </main>
        )}
      </div>
      </div>
    </div>
  )
}
