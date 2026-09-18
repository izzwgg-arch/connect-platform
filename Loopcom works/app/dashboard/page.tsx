'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils'
import { formatDateTime } from '@/lib/utils'
import {
  DollarSign,
  FileText,
  Briefcase,
  Calendar,
  Phone,
  MessageSquare,
  CheckSquare,
  AlertCircle,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DashboardRevenueChart } from '@/components/dashboard/DashboardRevenueChart'
import { DashboardJobsPipelineChart } from '@/components/dashboard/DashboardJobsPipelineChart'
import { DashboardJobsChart } from '@/components/dashboard/DashboardJobsChart'
import { refreshAccessToken } from '@/lib/auth/client'
import { PermissionGuard } from '@/components/permissions/PermissionGuard'

interface DashboardStats {
  kpis: {
    totalRevenue: number
    todayRevenue: number
    weekRevenue: number
    monthRevenue: number
    revenueGrowth: string
    unpaidInvoicesTotal: number
    unpaidInvoicesCount: number
    activeJobs: number
    todaysJobs: number
    overdueInvoices: number
    missedCallsToday: number
    unreadSmsCount: number
    pendingTasks: number
    openIssues: number
  }
  recentPayments: Array<{
    id: string
    amount: number
    clientName: string
    invoiceNumber: string
    processedAt: string
  }>
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [dismissedPayments, setDismissedPayments] = useState<Set<string>>(new Set())
  const [qboHealth, setQboHealth] = useState<{ ok: boolean; error?: string | null } | null>(null)
  const DISMISSED_KEY = 'dashboard.dismissedPayments'

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISSED_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setDismissedPayments(new Set(parsed.filter((v) => typeof v === 'string')))
        }
      }
    } catch (error) {
      console.warn('Failed to restore dismissed payments:', error)
    }
    fetchStats()
    // Best-effort daily QuickBooks health check (server-side throttled + notification throttled).
    checkQuickBooksHealth()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(dismissedPayments)))
    } catch (error) {
      console.warn('Failed to persist dismissed payments:', error)
    }
  }, [dismissedPayments])

  const fetchStats = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/dashboard/stats', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        // Token expired, try to refresh
        await refreshToken()
        return
      }

      const data = await response.json()
      setStats(data)
    } catch (error) {
      console.error('Failed to fetch dashboard stats:', error)
    } finally {
      setLoading(false)
    }
  }

  const checkQuickBooksHealth = async () => {
    try {
      let token = localStorage.getItem('accessToken')
      if (!token) {
        const ok = await refreshAccessToken()
        if (!ok) return
        token = localStorage.getItem('accessToken')
      }

      let res = await fetch('/api/integrations/quickbooks/health', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (res.status === 401) {
        const ok = await refreshAccessToken()
        if (!ok) return
        token = localStorage.getItem('accessToken')
        res = await fetch('/api/integrations/quickbooks/health', {
          headers: { Authorization: `Bearer ${token}` },
        })
      }

      const data = await res.json().catch(() => null)
      if (!data) return

      if (data.connected && data.ok === false) {
        setQboHealth({
          ok: false,
          error: data.error || data.lastError || 'QuickBooks health check failed',
        })
      } else {
        setQboHealth({ ok: true, error: null })
      }
    } catch {
      // Non-critical; ignore.
    }
  }

  const refreshToken = async () => {
    const ok = await refreshAccessToken()
    if (!ok) {
      window.location.href = '/auth/login'
      return
    }
    fetchStats()
  }

  const dismissPayment = (paymentId: string) => {
    setDismissedPayments((prev) => new Set(prev).add(paymentId))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  if (!stats) {
    return <div className="text-center text-red-600">Failed to load dashboard data</div>
  }

  const revenueGrowth = parseFloat(stats.kpis.revenueGrowth)
  const visiblePayments = stats.recentPayments.filter((p) => !dismissedPayments.has(p.id))

  return (
    <div className="space-y-6">
      {qboHealth?.ok === false ? (
        <PermissionGuard permission="system.integrations">
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">QuickBooks needs attention</div>
                <div className="text-sm opacity-90 break-words">
                  {qboHealth.error || 'QuickBooks token refresh failed.'}{' '}
                  <a className="underline" href="/dashboard/settings/integrations/quickbooks">
                    Open QuickBooks settings
                  </a>
                </div>
              </div>
            </div>
          </div>
        </PermissionGuard>
      ) : null}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-2 text-gray-600">Welcome back! Here's what's happening today.</p>
      </div>

      {/* Payment Received Panel - Forced Dismissal */}
      <PermissionGuard permission="payments.view">
      {visiblePayments.length > 0 && (
        <Card className="border-green-500 bg-green-50">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center">
                <DollarSign className="mr-2 h-5 w-5 text-green-600" />
                Payment Received
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => visiblePayments.forEach((p) => dismissPayment(p.id))}
              >
                Dismiss All
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {visiblePayments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex items-center justify-between rounded-lg bg-white p-4 border border-green-200"
                >
                  <div>
                    <p className="font-semibold text-green-900">
                      {formatCurrency(payment.amount)}
                    </p>
                    <p className="text-sm text-gray-600">
                      {payment.clientName} • Invoice {payment.invoiceNumber}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatDateTime(payment.processedAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => dismissPayment(payment.id)}
                  >
                    Dismiss
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      </PermissionGuard>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <PermissionGuard permission="analytics.view">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(stats.kpis.totalRevenue)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              All time
            </p>
          </CardContent>
        </Card>
        </PermissionGuard>

        <PermissionGuard permission="analytics.view">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Month Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(stats.kpis.monthRevenue)}</div>
            <div className="flex items-center text-xs mt-1">
              {revenueGrowth >= 0 ? (
                <TrendingUp className="mr-1 h-3 w-3 text-green-600" />
              ) : (
                <TrendingDown className="mr-1 h-3 w-3 text-red-600" />
              )}
              <span className={revenueGrowth >= 0 ? 'text-green-600' : 'text-red-600'}>
                {Math.abs(revenueGrowth)}% vs last month
              </span>
            </div>
          </CardContent>
        </Card>
        </PermissionGuard>

        <PermissionGuard permission="invoices.view">
        <Link href="/dashboard/invoices?status=UNPAID_OVERDUE" className="block">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Unpaid Invoices</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(stats.kpis.unpaidInvoicesTotal)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.kpis.unpaidInvoicesCount} invoices
                {stats.kpis.overdueInvoices > 0 && (
                  <span className="text-red-600 ml-1">
                    ({stats.kpis.overdueInvoices} overdue)
                  </span>
                )}
              </p>
            </CardContent>
          </Card>
        </Link>
        </PermissionGuard>

        <PermissionGuard permission="jobs.view">
        <Link href="/dashboard/jobs?status=ACTIVE" className="block">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Jobs</CardTitle>
              <Briefcase className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.kpis.activeJobs}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.kpis.todaysJobs} scheduled today
              </p>
            </CardContent>
          </Card>
        </Link>
        </PermissionGuard>
      </div>

      {/* Secondary KPIs */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <PermissionGuard permission="calls.view">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Missed Calls</CardTitle>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.kpis.missedCallsToday}</div>
            <p className="text-xs text-muted-foreground mt-1">Today</p>
          </CardContent>
        </Card>
        </PermissionGuard>

        <PermissionGuard permission="messages.view">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unread Messages</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.kpis.unreadSmsCount}</div>
            <p className="text-xs text-muted-foreground mt-1">SMS/MMS</p>
          </CardContent>
        </Card>
        </PermissionGuard>

        <PermissionGuard permission="tasks.view">
        <Link href="/dashboard/tasks?status=PLANNING_PENDING" className="block">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Planning Tasks</CardTitle>
              <CheckSquare className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.kpis.pendingTasks}</div>
              <p className="text-xs text-muted-foreground mt-1">Planning / Pending</p>
            </CardContent>
          </Card>
        </Link>
        </PermissionGuard>

        <PermissionGuard permission="issues.view">
        <Link href="/dashboard/issues?status=OPEN" className="block">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Open Issues</CardTitle>
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.kpis.openIssues}</div>
              <p className="text-xs text-muted-foreground mt-1">Requires attention</p>
            </CardContent>
          </Card>
        </Link>
        </PermissionGuard>
      </div>

      {/* Charts Section */}
      <PermissionGuard permission="analytics.view">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Revenue (Last 30 Days)</CardTitle>
            <CardDescription>Daily revenue from paid invoices</CardDescription>
          </CardHeader>
          <CardContent>
            <DashboardRevenueChart />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Jobs Pipeline</CardTitle>
            <CardDescription>Active jobs by status</CardDescription>
          </CardHeader>
          <CardContent>
            <DashboardJobsPipelineChart />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Jobs Created vs Completed (Last 30 Days)</CardTitle>
          <CardDescription>Daily job activity</CardDescription>
        </CardHeader>
        <CardContent>
          <DashboardJobsChart />
        </CardContent>
      </Card>
      </PermissionGuard>

      <PermissionGuard permission="analytics.view">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => window.location.href = '/dashboard/analytics'}>
          View Full Analytics →
        </Button>
      </div>
      </PermissionGuard>

    </div>
  )
}
