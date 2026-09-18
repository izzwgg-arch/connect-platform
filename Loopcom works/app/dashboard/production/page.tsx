'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ResponsivePage } from '@/components/layout/ResponsivePage'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import { formatCurrency } from '@/lib/utils'
import { JOB_STATUSES, jobStatusColors, formatJobStatus } from '@/lib/jobs/statuses'
import { PRODUCTION_BOARD_COLUMNS, type ProductionBoardColumn } from '@/lib/production/production-status'
import {
  Factory,
  Search,
  Filter,
  AlertTriangle,
  Archive,
  LayoutGrid,
  MapPin,
  Users,
  Calendar,
} from 'lucide-react'

interface TeamMember {
  id: string
  firstName: string
  lastName: string
}

interface ProductionJob {
  id: string
  jobNumber: string
  title: string
  status: string
  priority: number
  scheduledStart: string | null
  scheduledEnd: string | null
  estimateAmount: string | null
  actualAmount: string | null
  client: { id: string; name: string; companyName: string | null } | null
  assignments: Array<{ id: string; user: { id: string; firstName: string; lastName: string } }>
  addresses: Array<{ id: string; street: string | null; city: string | null; state: string | null; zipCode: string | null }>
  production: {
    stage: string
    nextAction: string
    board: ProductionBoardColumn
    boardLabel: string
    isActive: boolean
    isOnHold: boolean
    isArchived: boolean
  }
}

interface ProductionCounts {
  activeProduction: number
  needToOrder: number
  ordered: number
  inProgress: number
  needTouchUps: number
  onHold: number
  readyForInstallation: number
  completed: number
}

const SUMMARY_CARDS: Array<{ key: keyof ProductionCounts; label: string; hint: string }> = [
  { key: 'activeProduction', label: 'Active Production', hint: 'Jobs in production' },
  { key: 'needToOrder', label: 'Need to Order', hint: 'Materials needed' },
  { key: 'ordered', label: 'Ordered', hint: 'Waiting for materials' },
  { key: 'inProgress', label: 'In Progress', hint: 'Currently being worked' },
  { key: 'needTouchUps', label: 'Need Touch-Ups', hint: 'Punch list pending' },
  { key: 'onHold', label: 'On Hold', hint: 'Needs attention' },
  { key: 'readyForInstallation', label: 'Ready for Installation', hint: 'Scheduled to begin' },
  { key: 'completed', label: 'Completed', hint: 'Finished jobs' },
]

function formatDateShort(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export default function ProductionPage() {
  const router = useRouter()
  const { permissions, loading: permissionsLoading } = usePermissions()
  const canView = hasPermission(permissions, 'production.view')
  const [jobs, setJobs] = useState<ProductionJob[]>([])
  const [counts, setCounts] = useState<ProductionCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [assignedTo, setAssignedTo] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [dueFilter, setDueFilter] = useState('all')
  const [archiveView, setArchiveView] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    fetchTeamMembers()
  }, [])

  useEffect(() => {
    if (permissionsLoading || !canView) return
    fetchProduction()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, assignedTo, priorityFilter, archiveView, permissionsLoading, canView])

  const fetchTeamMembers = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/schedules/team', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setTeamMembers(data.teamMembers || [])
      }
    } catch (error) {
      console.error('Failed to fetch team members:', error)
    }
  }

  const fetchProduction = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (assignedTo !== 'all') params.set('assignedTo', assignedTo)
      if (priorityFilter !== 'all') params.set('priority', priorityFilter)
      if (archiveView) params.set('view', 'archive')

      const response = await fetch(`/api/production?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!response.ok) {
        console.error('Failed to fetch production data')
        return
      }
      const data = await response.json()
      setJobs(data.jobs || [])
      setCounts(data.counts || null)
    } catch (error) {
      console.error('Failed to fetch production data:', error)
    } finally {
      setLoading(false)
    }
  }

  const today = useMemo(() => new Date(), [])

  const visibleJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (statusFilter !== 'all' && job.status !== statusFilter) return false
      if (dueFilter !== 'all') {
        if (!job.scheduledEnd) return false
        const due = new Date(job.scheduledEnd)
        if (Number.isNaN(due.getTime())) return false
        if (dueFilter === 'overdue' && !(due < today && !isSameDay(due, today))) return false
        if (dueFilter === 'today' && !isSameDay(due, today)) return false
        if (dueFilter === 'week') {
          const weekOut = new Date(today)
          weekOut.setDate(weekOut.getDate() + 7)
          if (due < today || due > weekOut) return false
        }
      }
      return true
    })
  }, [jobs, statusFilter, dueFilter, today])

  const onHoldJobs = useMemo(() => visibleJobs.filter((j) => j.production.isOnHold), [visibleJobs])

  const columns = useMemo(() => {
    return PRODUCTION_BOARD_COLUMNS.map((col) => ({
      ...col,
      jobs: visibleJobs.filter((j) => j.production.board === col.id),
    }))
  }, [visibleJobs])

  if (!permissionsLoading && !canView) {
    return (
      <ResponsivePage>
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-500">
            You don&apos;t have permission to view Production.
          </CardContent>
        </Card>
      </ResponsivePage>
    )
  }

  return (
    <ResponsivePage>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-gray-900">
            <Factory className="h-7 w-7 text-[var(--brand-primary-color)]" />
            Production
          </h1>
          <p className="mt-2 text-gray-600">Production overview and workflow</p>
        </div>
        <Button variant="outline" onClick={() => setArchiveView((v) => !v)}>
          <Archive className="mr-2 h-4 w-4" />
          {archiveView ? 'Back to Board' : 'Archive'}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {SUMMARY_CARDS.map((card) => (
          <Card key={card.key}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-gray-900">
                {loading || !counts ? '—' : counts[card.key]}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-gray-400" />
              <Input
                placeholder="Search jobs by #, title, client, or address..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px] text-sm">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  {JOB_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger className="w-[170px] text-sm">
                  <SelectValue placeholder="Assigned To" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  {teamMembers.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.firstName} {member.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger className="w-[140px] text-sm">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any Priority</SelectItem>
                  {[5, 4, 3, 2, 1].map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      P{p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={dueFilter} onValueChange={setDueFilter}>
                <SelectTrigger className="w-[150px] text-sm">
                  <SelectValue placeholder="Due Date" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any Due Date</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                  <SelectItem value="today">Due Today</SelectItem>
                  <SelectItem value="week">Due This Week</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
            <p className="mt-4 text-gray-600">Loading production board...</p>
          </div>
        </div>
      ) : archiveView ? (
        <ArchiveList jobs={visibleJobs} onOpenJob={(id) => router.push(`/dashboard/jobs/${id}`)} />
      ) : (
        <>
          {onHoldJobs.length > 0 && (
            <Card className="border-amber-300 bg-amber-50/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base text-amber-800">
                  <AlertTriangle className="h-5 w-5" />
                  On Hold / Attention Needed
                  <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                    {onHoldJobs.length}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-3 pt-0 sm:grid-cols-2 lg:grid-cols-3">
                {onHoldJobs.map((job) => (
                  <ProductionJobCard key={job.id} job={job} onOpen={() => router.push(`/dashboard/jobs/${job.id}`)} />
                ))}
              </CardContent>
            </Card>
          )}

          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
              <LayoutGrid className="h-4 w-4" />
              Production Board
            </div>
            <div className="scrollbar-visible-x flex gap-4 overflow-x-auto pb-3">
              {columns.map((col) => (
                <div
                  key={col.id}
                  className="flex max-h-[65vh] w-72 flex-shrink-0 flex-col rounded-lg border bg-gray-50"
                >
                  <div className="flex items-center justify-between rounded-t-lg border-b bg-white px-3 py-2">
                    <span className="text-sm font-semibold text-gray-900">{col.label}</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {col.jobs.length}
                    </span>
                  </div>
                  <div className="scrollbar-visible-x flex-1 space-y-2 overflow-y-auto p-2">
                    {col.jobs.length === 0 ? (
                      <p className="px-2 py-4 text-center text-xs text-gray-400">No jobs</p>
                    ) : (
                      col.jobs.map((job) => (
                        <ProductionJobCard
                          key={job.id}
                          job={job}
                          onOpen={() => router.push(`/dashboard/jobs/${job.id}`)}
                        />
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </ResponsivePage>
  )
}

function ProductionJobCard({ job, onOpen }: { job: ProductionJob; onOpen: () => void }) {
  const address = job.addresses?.[0]
  const clientName = job.client?.companyName || job.client?.name
  const crewNames = job.assignments.map((a) => a.user.firstName).filter(Boolean)
  const dueLabel = formatDateShort(job.scheduledEnd)
  const isHighPriority = job.priority >= 4
  const amount = job.estimateAmount || job.actualAmount

  const overdue = (() => {
    if (!job.scheduledEnd || job.production.isArchived) return false
    const due = new Date(job.scheduledEnd)
    if (Number.isNaN(due.getTime())) return false
    const now = new Date()
    return due < now && !isSameDay(due, now)
  })()

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border bg-white p-3 text-left shadow-sm transition hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-bold text-[var(--brand-primary-color)]">{job.jobNumber}</span>
        {isHighPriority && (
          <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
            P{job.priority}
          </span>
        )}
      </div>

      {job.title && <p className="mt-0.5 line-clamp-1 text-xs font-medium text-gray-800">{job.title}</p>}

      {address?.street && (
        <p className="mt-1 flex items-start gap-1 text-xs text-gray-600">
          <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
          <span className="line-clamp-1">
            {address.street}
            {address.city ? `, ${address.city}` : ''}
          </span>
        </p>
      )}

      {clientName && <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{clientName}</p>}

      <div className="mt-2 border-t pt-2">
        <div className="flex items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${jobStatusColors[job.status] || 'bg-gray-100 text-gray-800'}`}>
            {formatJobStatus(job.status)}
          </span>
          {overdue && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">Overdue</span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          <span className="font-semibold text-gray-600">Stage:</span> {job.production.stage}
        </p>
        <p className="mt-1 text-xs font-medium text-gray-800">
          <span className="font-semibold text-gray-600">Next:</span> {job.production.nextAction}
        </p>
      </div>

      <div className="mt-2 flex items-center justify-between border-t pt-2 text-[11px] text-gray-500">
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          {crewNames.length ? crewNames.join(', ') : 'Unassigned'}
        </span>
        {dueLabel && (
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {dueLabel}
          </span>
        )}
      </div>

      {amount && (
        <p className="mt-1 text-[11px] font-medium text-gray-600">{formatCurrency(parseFloat(amount))}</p>
      )}
    </button>
  )
}

function ArchiveList({ jobs, onOpenJob }: { jobs: ProductionJob[]; onOpenJob: (id: string) => void }) {
  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-gray-500">
          No completed, cancelled, or invoiced jobs match these filters.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Archive — Completed / Cancelled / Invoiced</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 pt-0 sm:grid-cols-2 lg:grid-cols-3">
        {jobs.map((job) => (
          <ProductionJobCard key={job.id} job={job} onOpen={() => onOpenJob(job.id)} />
        ))}
      </CardContent>
    </Card>
  )
}
