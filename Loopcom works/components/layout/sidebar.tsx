'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { TrimProLogo } from '@/components/branding/TrimProLogo'
import { PermissionGuard } from '@/components/permissions/PermissionGuard'
import { SIDEBAR_PAGE_MODULE_IDS, getModuleById, getModuleSidebarPermissions } from '@/lib/page-module-permissions'
import { displayNameOf, initialsOf, readStoredUser, roleLabelOf, type StoredUser } from '@/lib/auth/client-logout'
import {
  LayoutDashboard,
  Users,
  Briefcase,
  Calendar,
  FileText,
  DollarSign,
  ShoppingCart,
  CheckSquare,
  AlertCircle,
  Phone,
  MessageSquare,
  Settings,
  HelpCircle,
  BarChart3,
  FileBarChart,
  Radio,
  Map,
  Mail,
  Package,
  Building2,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  ScrollText,
  Receipt,
  Factory,
  Inbox,
} from 'lucide-react'
import { useRef, useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'

// Maps a nav item to the Notification.linkType whose unread count should
// show a "New" badge next to it. Only items an assignee needs to be alerted
// about are included here.
const NAV_ITEM_LINK_TYPES: Record<string, string> = {
  Jobs: 'job',
  Requests: 'request',
  Issues: 'issue',
  Tasks: 'task',
  Messages: 'message',
}

// The same 25 pages, hrefs and permission keys TrimPro had. Only the Requests
// icon changed (Inbox — the mockups) so it no longer duplicates Clients'.
const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permission: 'dashboard.view' },
  { name: 'Clients', href: '/dashboard/clients', icon: Users, permission: 'clients.view' },
  { name: 'Requests', href: '/dashboard/requests', icon: Inbox, permission: 'leads.view' },
  { name: 'Jobs', href: '/dashboard/jobs', icon: Briefcase, permission: 'jobs.view' },
  { name: 'Production', href: '/dashboard/production', icon: Factory, permission: 'production.view' },
  { name: 'Schedule', href: '/dashboard/schedule', icon: Calendar, permission: 'schedule.view' },
  { name: 'Estimates', href: '/dashboard/estimates', icon: FileText, permission: 'estimates.view' },
  { name: 'Invoices', href: '/dashboard/invoices', icon: DollarSign, permission: 'invoices.view' },
  { name: 'Credit Memos', href: '/dashboard/credit-memos', icon: Receipt, permission: 'invoices.view' },
  { name: 'Purchase Orders', href: '/dashboard/purchase-orders', icon: ShoppingCart, permission: 'purchase_orders.view' },
  { name: 'Items', href: '/dashboard/items', icon: Package, permission: 'settings.view' },
  { name: 'Vendors', href: '/dashboard/vendors', icon: Building2, permission: 'purchase_orders.view' },
  { name: 'Tasks', href: '/dashboard/tasks', icon: CheckSquare, permission: 'tasks.view' },
  { name: 'Issues', href: '/dashboard/issues', icon: AlertCircle, permission: 'issues.view' },
  { name: 'Teams', href: '/dashboard/teams', icon: Users, permission: 'teams.view' },
  { name: 'Calls', href: '/dashboard/calls', icon: Phone, permission: 'calls.view' },
  { name: 'Messages', href: '/dashboard/messages', icon: MessageSquare, permission: 'messages.view' },
  { name: 'Email', href: '/dashboard/email', icon: Mail, permission: 'messages.view' },
  { name: 'Maps', href: '/dashboard/maps', icon: Map, permission: 'jobs.view' },
  { name: 'Analytics', href: '/dashboard/analytics', icon: BarChart3, permission: 'analytics.view' },
  { name: 'Reports', href: '/dashboard/reports', icon: FileBarChart, permission: 'reports.view' },
  { name: 'Dispatch', href: '/dashboard/dispatch', icon: Radio, permission: 'dispatch.view' },
  { name: 'Audit Logs', href: '/dashboard/audit-logs', icon: ScrollText, permission: 'audit_logs.access' },
  { name: 'Settings', href: '/dashboard/settings', icon: Settings, permission: 'settings.view' },
  { name: 'Help', href: '/dashboard/help', icon: HelpCircle, permission: 'dashboard.view' },
]

// The approved mockups group those pages into the portal's sections (board 03).
// Grouping is presentation only: every entry above keeps its href + permission.
const SECTIONS: Array<{ label: string; items: string[] }> = [
  { label: 'Workspace', items: ['Dashboard', 'Clients', 'Requests', 'Jobs', 'Production', 'Schedule'] },
  { label: 'Money', items: ['Estimates', 'Invoices', 'Credit Memos', 'Purchase Orders', 'Items', 'Vendors'] },
  { label: 'Team', items: ['Tasks', 'Issues', 'Teams', 'Dispatch', 'Maps'] },
  { label: 'Communicate', items: ['Calls', 'Messages', 'Email'] },
  { label: 'Insight', items: ['Analytics', 'Reports', 'Audit Logs'] },
  { label: 'System', items: ['Settings', 'Help'] },
]
const SECTIONS_KEY = 'sidebar-sections-collapsed'

interface SidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

interface UnreadNavNotification {
  id: string
  title: string
  message: string | null
  linkType: string | null
  linkUrl: string | null
  createdAt: string
}

function NewBadge({ items }: { items: UnreadNavNotification[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const badgeRef = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  if (items.length === 0) return null

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 250)
  }

  const show = () => {
    cancelClose()
    const rect = badgeRef.current?.getBoundingClientRect()
    if (rect) {
      setPosition({ top: rect.bottom, left: Math.min(rect.left, window.innerWidth - 300) })
    }
    setOpen(true)
  }

  return (
    <>
      <span
        ref={badgeRef}
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        className="ml-2 inline-flex cursor-default rounded-full bg-danger px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-[0.04em] text-white"
      >
        New
      </span>
      {open && (
        <div
          className="fixed z-[100] w-72 rounded-[10px] border border-line bg-popover p-2 pt-3 text-left normal-case shadow-float"
          style={{ top: position.top, left: position.left }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <p className="mb-1 px-1 text-[10px] font-bold uppercase tracking-[0.08em] text-dim">
            What&apos;s new
          </p>
          {items.slice(0, 5).map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                if (n.linkUrl) router.push(n.linkUrl)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                if (n.linkUrl) router.push(n.linkUrl)
              }}
              className="cursor-pointer rounded-lg px-1.5 py-1.5 hover:bg-accent-soft"
            >
              <p className="truncate text-xs font-medium text-ink">{n.title}</p>
              {n.message && <p className="line-clamp-2 text-[11px] text-dim">{n.message}</p>}
              <p className="mt-0.5 text-[10px] text-faint">
                {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
              </p>
            </div>
          ))}
          {items.length > 5 && (
            <p className="px-1 pt-1 text-[10px] text-faint">+{items.length - 5} more</p>
          )}
        </div>
      )}
    </>
  )
}

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [unreadNavNotifications, setUnreadNavNotifications] = useState<UnreadNavNotification[]>([])
  const [closedSections, setClosedSections] = useState<Record<string, boolean>>({})
  const [user, setUser] = useState<StoredUser | null>(null)

  // Persist collapse state across sessions
  useEffect(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    if (saved === 'true') setCollapsed(true)
    try {
      const raw = localStorage.getItem(SECTIONS_KEY)
      if (raw) setClosedSections(JSON.parse(raw))
    } catch {}
    setUser(readStoredUser())
  }, [])

  // Poll unread notifications to drive the "New" nav badges and their hover
  // preview. Badges clear only when the underlying notification is marked
  // read/dismissed via the notification bell, not just by visiting the page.
  useEffect(() => {
    let cancelled = false
    const fetchUnreadNotifications = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        if (!token) return
        const res = await fetch('/api/notifications?status=UNREAD&limit=50', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setUnreadNavNotifications(data.notifications || [])
      } catch (error) {
        console.error('Failed to fetch unread notifications:', error)
      }
    }

    fetchUnreadNotifications()
    const interval = setInterval(fetchUnreadNotifications, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const unreadByNavItem = (itemName: string) =>
    unreadNavNotifications.filter((n) => n.linkType === NAV_ITEM_LINK_TYPES[itemName])

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      localStorage.setItem('sidebar-collapsed', String(!prev))
      return !prev
    })
  }

  const toggleSection = (label: string) => {
    setClosedSections((prev) => {
      const next = { ...prev, [label]: !prev[label] }
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }

  const isActivePath = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname === href || pathname?.startsWith(href + '/')

  // One nav link, guarded exactly as before (PermissionGuard + module sidebar permissions).
  const renderItem = (item: (typeof navigation)[number], rail: boolean) => {
    const isActive = isActivePath(item.href)
    const navItem = (
      <Link
        key={item.name}
        href={item.href}
        onClick={onMobileClose}
        title={rail ? item.name : undefined}
        className={cn('lw-nav-link group', rail && 'is-rail', isActive && 'is-active')}
      >
        <span className="lw-nav-icon">
          <item.icon className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={1.85} />
        </span>
        {!rail && (
          <span className="flex min-w-0 flex-1 items-center justify-between truncate">
            {item.name}
            <NewBadge items={unreadByNavItem(item.name)} />
          </span>
        )}
      </Link>
    )

    if (item.permission) {
      const moduleId = SIDEBAR_PAGE_MODULE_IDS[item.name]
      const module = moduleId ? getModuleById(moduleId) : undefined
      const sidebarPermissions = module ? getModuleSidebarPermissions(module) : [item.permission]

      return (
        <PermissionGuard key={item.name} permissions={sidebarPermissions}>
          {navItem}
        </PermissionGuard>
      )
    }

    return navItem
  }

  const renderSections = (rail: boolean) =>
    SECTIONS.map((section) => {
      const items = section.items
        .map((name) => navigation.find((n) => n.name === name))
        .filter((n): n is (typeof navigation)[number] => Boolean(n))
      const closed = !rail && closedSections[section.label]
      return (
        <div key={section.label} className="lw-section">
          {!rail && (
            <button
              type="button"
              className="lw-section-label"
              onClick={() => toggleSection(section.label)}
              aria-expanded={!closed}
            >
              {section.label}
              <ChevronDown className={cn('h-3 w-3 transition-transform', closed && '-rotate-90')} strokeWidth={2} />
            </button>
          )}
          {!closed && <div className="space-y-0.5">{items.map((item) => renderItem(item, rail))}</div>}
        </div>
      )
    })

  const profileBlock = (rail: boolean) => (
    <div className={cn('lw-drawer-profile', rail && 'is-rail')}>
      <div className="flex items-center gap-2.5">
        <div className="lw-avatar" title={displayNameOf(user)}>
          {initialsOf(user)}
        </div>
        {!rail && (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">{displayNameOf(user) || '—'}</div>
            <div className="truncate text-[11px] text-dim">{roleLabelOf(user) || ' '}</div>
          </div>
        )}
      </div>
      {!rail && user?.tenantName && (
        <div className="lw-tenant-row" title={user.tenantName}>
          <Building2 className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.85} />
          <span className="truncate">{user.tenantName}</span>
        </div>
      )}
    </div>
  )

  const sidebarContent = (
    <div className={cn('lw-sidebar flex h-full flex-col', collapsed ? 'w-[72px]' : 'w-[280px]')}>
      {profileBlock(collapsed)}

      {/* Nav */}
      <nav className={cn('flex-1 min-h-0 overflow-y-auto overflow-x-hidden', collapsed ? 'px-[10px] py-2' : 'px-[10px] pb-5 pt-2')}>
        {renderSections(collapsed)}
      </nav>

      {/* Footer: the rail toggle, as in the portal drawer */}
      <div className="lw-drawer-footer">
        <button
          onClick={toggleCollapsed}
          className="lw-icon-btn h-8 w-8"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" strokeWidth={1.85} /> : <PanelLeftClose className="h-4 w-4" strokeWidth={1.85} />}
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop sidebar — always in flow */}
      <div className="hidden lg:flex h-full">
        {sidebarContent}
      </div>

      {/* Mobile overlay drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-[rgba(2,7,14,0.55)]"
            onClick={onMobileClose}
            aria-hidden="true"
          />
          {/* Drawer — always full width on mobile */}
          <div className="lw-sidebar relative flex h-full w-[min(100vw,280px)] max-w-[85vw] flex-col shadow-float">
            <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-line px-3">
              <Link href="/dashboard" aria-label="Go to dashboard" className="inline-flex h-full min-w-0 flex-1 items-center justify-start overflow-hidden pr-1" onClick={onMobileClose}>
                <TrimProLogo variant="sidebar" size="md" />
              </Link>
              <button
                onClick={onMobileClose}
                className="lw-icon-btn flex min-h-[44px] min-w-[44px]"
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {profileBlock(false)}
            <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-[10px] pb-5 pt-2">
              {renderSections(false)}
            </nav>
          </div>
        </div>
      )}
    </>
  )
}
