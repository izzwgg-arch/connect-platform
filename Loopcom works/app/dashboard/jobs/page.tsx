'use client'
import { useListRestore } from '@/hooks/useListRestore'
import { usePersistedSort } from '@/hooks/useListPreferences'
import { openFromList, readListSession } from '@/lib/navigation/nav-stack'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ViewModeSelector } from '@/components/ui/ViewModeSelector'
import { useViewMode } from '@/hooks/useViewMode'
import { RowCompactItem } from '@/components/lists/RowCompactItem'
import { RowDetailedItem } from '@/components/lists/RowDetailedItem'
import { TableView } from '@/components/lists/TableView'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Plus, Search, Filter, Briefcase, Calendar, DollarSign, Trash2, Copy, MapPin } from 'lucide-react'
import { useDocumentListAccess } from '@/hooks/useDocumentListAccess'
import { CreateOnlyAccessCard } from '@/components/permissions/CreateOnlyAccessCard'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { JOB_STATUSES } from '@/lib/jobs/statuses'
import { JOB_TYPES } from '@/lib/jobs/types'
import { JobStatusSelect } from '@/components/jobs/JobStatusSelect'
import { JobTypeBadge } from '@/components/jobs/JobTypeSelect'
import { JobBillingStatusBadge } from '@/components/jobs/JobBillingStatusBadge'
import { formatJobBillingStatus } from '@/lib/jobs/billing-status'

interface Job {
  id: string
  jobNumber: string
  title: string
  description: string | null
  status: string
  billingStatus?: string | null
  jobType?: string | null
  priority: number
  scheduledStart: string | null
  scheduledEnd: string | null
  createdAt: string
  estimateAmount: string | null
  totalCost?: string | null
  openInvoiceBalance?: string
  openInvoiceCount?: number
  clientOpenInvoiceBalance?: string
  unreadMessages?: number
  client: {
    id: string
    name: string
    companyName: string | null
  }
  addresses?: Array<{
    id: string
    street: string
    city: string
    state: string
    zipCode: string
  }>
  assignments: Array<{
    id: string
    role: string | null
    user: {
      id: string
      firstName: string
      lastName: string
    }
  }>
  _count: {
    tasks: number
    issues: number
  }
}

const priorityLabels: Record<number, string> = {
  1: 'Low',
  2: 'Low-Medium',
  3: 'Medium',
  4: 'Medium-High',
  5: 'High',
}

function formatJobSiteAddress(job: Job): string | null {
  const address = job.addresses?.[0]
  if (!address) return null
  const line = [address.street, address.city, address.state, address.zipCode]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ')
  return line || null
}

function formatJobCreatedDate(job: Job): string {
  if (!job.createdAt) return 'No date'
  return formatDate(job.createdAt)
}

function formatJobAssignees(job: Job): string {
  if (!job.assignments?.length) return 'Unassigned'
  return job.assignments
    .map((a) => `${a.user.firstName || ''} ${a.user.lastName || ''}`.trim() || 'Unknown')
    .filter(Boolean)
    .join(', ')
}

function UnreadMessagesBadge({ count }: { count?: number }) {
  if (!count || count <= 0) return null
  return (
    <span
      title={`${count} unread message${count === 1 ? '' : 's'}`}
      className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-bold"
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function JobsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissionsLoading, canViewList, canCreate } = useDocumentListAccess('jobs.view', 'jobs.create')
  const [jobs, setJobs] = useState<Job[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [status, setStatus] = useState('all')
  const [jobType, setJobType] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [page, setPage] = useState(() => {
    if (typeof window === 'undefined') return 1
    return readListSession('jobs')?.page || 1
  })
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [viewMode, setViewMode] = useViewMode('jobs', 'grid')
  const { highlightedId } = useListRestore('jobs', {
    ready: !initialLoading && !isFetching && jobs.length > 0,
  })
  const { sortKey: persistedSortKey, sortDirection: persistedSortDirection, setSort: setPersistedSort } =
    usePersistedSort('jobs')
  const filtersReadyRef = useRef(false)

  const openJob = (jobId: string) => {
    openFromList(router, {
      entity: 'jobs',
      detailHref: `/dashboard/jobs/${jobId}`,
      itemId: jobId,
      page,
    })
  }

  useEffect(() => {
    const statusParam = searchParams.get('status')
    if (statusParam) {
      setStatus(statusParam)
    }
  }, [searchParams])

  useEffect(() => {
    // Don't wipe the restored page on the first mount.
    if (!filtersReadyRef.current) {
      filtersReadyRef.current = true
      return
    }
    setPage(1)
  }, [debouncedSearch, status, jobType, startDate, endDate])

  useEffect(() => {
    if (permissionsLoading) return
    fetchJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, status, jobType, startDate, endDate, page, permissionsLoading, canViewList])

  const fetchJobs = async () => {
    if (!canViewList) {
      setJobs([])
      setInitialLoading(false)
      setIsFetching(false)
      return
    }

    setIsFetching(true)
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search: debouncedSearch,
        status,
        jobType,
        page: String(page),
        limit: '50',
      })
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)

      const response = await fetch(`/api/jobs?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setJobs(data.jobs || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch jobs:', error)
    } finally {
      setInitialLoading(false)
      setIsFetching(false)
    }
  }

  const handleDelete = async (jobId: string, jobTitle: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete job "${jobTitle}"?\n\n` +
      'This action cannot be undone. If the job has invoices, it will be cancelled instead.'
    )

    if (!confirmed) return

    setDeletingId(jobId)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to delete job')
        setDeletingId(null)
        return
      }

      // Refresh the jobs list
      fetchJobs()
    } catch (error) {
      console.error('Error deleting job:', error)
      alert('Failed to delete job')
    } finally {
      setDeletingId(null)
    }
  }

  const handleDuplicateSelected = async () => {
    if (selectedIds.length === 0) return
    if (!confirm(`Duplicate ${selectedIds.length} selected job(s)?`)) return

    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      for (const jobId of selectedIds) {
        const response = await fetch(`/api/jobs/${jobId}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          alert(data.error || 'Failed to duplicate one or more jobs')
          break
        }
      }

      setSelectedIds([])
      fetchJobs()
    } catch (error) {
      console.error('Failed duplicating jobs:', error)
      alert('Failed to duplicate selected jobs')
    } finally {
      setDuplicating(false)
    }
  }

  const toggleSelected = (jobId: string, checked: boolean) => {
    setSelectedIds((prev) =>
      checked ? (prev.includes(jobId) ? prev : [...prev, jobId]) : prev.filter((id) => id !== jobId)
    )
  }

  if (initialLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading jobs...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Jobs</h1>
          <p className="mt-2 text-gray-600">Manage your jobs and projects</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          {canViewList && (
            <Button
              variant="outline"
              onClick={handleDuplicateSelected}
              disabled={selectedIds.length === 0 || duplicating}
            >
              <Copy className="mr-2 h-4 w-4" />
              {duplicating ? 'Duplicating...' : `Duplicate${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => router.push('/dashboard/jobs/new')}>
              <Plus className="mr-2 h-4 w-4" />
              New Job
            </Button>
          )}
        </div>
      </div>

      {!canViewList && (
        <CreateOnlyAccessCard
          icon={Briefcase}
          entityLabel="jobs"
          createButtonLabel="New Job"
          canCreate={canCreate}
          onCreate={() => router.push('/dashboard/jobs/new')}
        />
      )}

      {canViewList && (
        <>
      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search jobs by #, title, client, crew, or address..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[220px] text-sm">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  {JOB_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={jobType} onValueChange={setJobType}>
                <SelectTrigger className="w-[160px] text-sm">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {JOB_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span>Created</span>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">From</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-[160px]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">To</label>
              <Input
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-[160px]"
              />
            </div>
            {(startDate || endDate) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStartDate('')
                  setEndDate('')
                }}
              >
                Clear dates
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Jobs List */}
      {viewMode === 'grid' ? (
      <div className="space-y-4">
        {jobs.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Briefcase className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No jobs</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating a new job.
              </p>
              <div className="mt-6">
                <Button onClick={() => router.push('/dashboard/jobs/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Job
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          jobs.map((job) => (
            <Card
              key={job.id}
              data-row-id={job.id}
              className={`hover:shadow-lg transition-shadow cursor-pointer ${
                highlightedId === job.id ? 'ring-2 ring-amber-300 bg-amber-50' : ''
              }`}
              onClick={() => openJob(job.id)}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg hover:text-primary cursor-pointer">
                        {job.title}
                      </CardTitle>
                      <UnreadMessagesBadge count={job.unreadMessages} />
                    </div>
                    <CardDescription className="mt-1">
                      {job.jobNumber} - {job.client.name}
                    </CardDescription>
                  </div>
                  <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(job.id)}
                      onChange={(e) => toggleSelected(job.id, e.target.checked)}
                      className="h-4 w-4"
                      title="Select for duplicate"
                    />
                    <JobTypeBadge jobType={job.jobType} />
                    <JobBillingStatusBadge status={job.billingStatus} />
                    <JobStatusSelect
                      jobId={job.id}
                      status={job.status}
                      compact
                      onUpdated={(next) =>
                        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: next } : j)))
                      }
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {job.description && (
                    <p className="text-sm text-gray-600 line-clamp-2">{job.description}</p>
                  )}
                  
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div className="flex items-center text-gray-600">
                      <Calendar className="mr-2 h-4 w-4 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-500">Created</p>
                        <p className="font-medium">{formatJobCreatedDate(job)}</p>
                      </div>
                    </div>
                    {job.estimateAmount && (
                      <div className="flex items-center text-gray-600">
                        <DollarSign className="mr-2 h-4 w-4 text-gray-400" />
                        <div>
                          <p className="text-xs text-gray-500">Estimate</p>
                          <p className="font-medium">{formatCurrency(parseFloat(job.estimateAmount))}</p>
                        </div>
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-gray-500">Priority</p>
                      <p className="font-medium text-gray-700">{priorityLabels[job.priority] || 'Medium'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Billing</p>
                      <div className="mt-0.5">
                        <JobBillingStatusBadge status={job.billingStatus} />
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Assignees</p>
                      <p className="font-medium text-gray-700">{formatJobAssignees(job)}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2 text-sm text-gray-600">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                    <div>
                      <p className="text-xs text-gray-500">Site address</p>
                      <p className="font-medium">{formatJobSiteAddress(job) || 'No site address'}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-gray-500">Total Cost</p>
                      <p className="font-semibold text-gray-900">
                        {job.totalCost ? formatCurrency(parseFloat(job.totalCost)) : (job.estimateAmount ? formatCurrency(parseFloat(job.estimateAmount)) : '-')}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Job Open Invoices</p>
                      <p className="font-semibold text-amber-700">
                        {formatCurrency(parseFloat(job.openInvoiceBalance || '0'))}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Client Open Balance</p>
                      <p className="font-semibold text-amber-700">
                        {formatCurrency(parseFloat(job.clientOpenInvoiceBalance || '0'))}
                      </p>
                    </div>
                  </div>

                  {job.assignments.length > 0 && (
                    <div className="pt-2 border-t">
                      <p className="text-xs text-gray-500 mb-1">Assigned Team:</p>
                      <div className="flex flex-wrap gap-2">
                        {job.assignments.map((assignment) => (
                          <span key={assignment.id} className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs">
                            {assignment.user.firstName} {assignment.user.lastName}
                            {assignment.role && ` (${assignment.role})`}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="flex items-center space-x-4 text-xs text-gray-500">
                      {job._count.tasks > 0 && (
                        <span>{job._count.tasks} tasks</span>
                      )}
                      {job._count.issues > 0 && (
                        <span>{job._count.issues} issues</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          router.push(`/dashboard/estimates/new?jobId=${job.id}&clientId=${job.client.id}`)
                        }}
                        className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                        title="New Estimate"
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(job.id, job.title)
                        }}
                        disabled={deletingId === job.id}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div key={job.id} className="relative">
              <input
                type="checkbox"
                checked={selectedIds.includes(job.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleSelected(job.id, e.target.checked)}
                className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2"
                title="Select for duplicate"
              />
              <RowCompactItem
                rowId={job.id}
                highlighted={highlightedId === job.id}
                onClick={() => openJob(job.id)}
                primary={
                  <span className="inline-flex items-center gap-2">
                    {job.jobNumber} - {job.title}
                    <UnreadMessagesBadge count={job.unreadMessages} />
                  </span>
                }
                secondary={[
                  job.client.name,
                  formatJobSiteAddress(job),
                  `Assignees: ${formatJobAssignees(job)}`,
                  `Client Open: ${formatCurrency(parseFloat(job.clientOpenInvoiceBalance || '0'))}`,
                ]
                  .filter(Boolean)
                  .join(' | ')}
                status={
                  <div className="flex items-center gap-2">
                    <JobTypeBadge jobType={job.jobType} />
                    <JobBillingStatusBadge status={job.billingStatus} />
                    <JobStatusSelect
                      jobId={job.id}
                      status={job.status}
                      compact
                      onUpdated={(next) =>
                        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: next } : j)))
                      }
                    />
                  </div>
                }
                amount={job.totalCost ? formatCurrency(parseFloat(job.totalCost)) : (job.estimateAmount ? formatCurrency(parseFloat(job.estimateAmount)) : '-')}
                date={formatJobCreatedDate(job)}
                className="pl-10"
              />
            </div>
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div key={job.id} className="relative">
              <input
                type="checkbox"
                checked={selectedIds.includes(job.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleSelected(job.id, e.target.checked)}
                className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2"
                title="Select for duplicate"
              />
              <RowDetailedItem
                rowId={job.id}
                highlighted={highlightedId === job.id}
                onClick={() => openJob(job.id)}
                primary={
                  <span className="inline-flex items-center gap-2">
                    {job.jobNumber} - {job.title}
                    <UnreadMessagesBadge count={job.unreadMessages} />
                  </span>
                }
                status={
                  <div className="flex items-center gap-2">
                    <JobTypeBadge jobType={job.jobType} />
                    <JobBillingStatusBadge status={job.billingStatus} />
                    <JobStatusSelect
                      jobId={job.id}
                      status={job.status}
                      compact
                      onUpdated={(next) =>
                        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: next } : j)))
                      }
                    />
                  </div>
                }
                line2={[
                  job.client.name,
                  formatJobSiteAddress(job),
                  `Assignees: ${formatJobAssignees(job)}`,
                  `Billing: ${formatJobBillingStatus(job.billingStatus || 'UNBILLED')}`,
                  `Priority ${priorityLabels[job.priority] || 'Medium'}`,
                  `Client Open ${formatCurrency(parseFloat(job.clientOpenInvoiceBalance || '0'))}`,
                ]
                  .filter(Boolean)
                  .join(' | ')}
                rightTop={job.totalCost ? formatCurrency(parseFloat(job.totalCost)) : (job.estimateAmount ? formatCurrency(parseFloat(job.estimateAmount)) : '-')}
                rightBottom={`${formatJobCreatedDate(job)} · Job Open ${formatCurrency(parseFloat(job.openInvoiceBalance || '0'))}`}
                className="pl-10"
              />
            </div>
          ))}
        </div>
      ) : (
        <TableView
          highlightedRowId={highlightedId}
          sortKey={persistedSortKey}
          sortDirection={persistedSortDirection}
          onSortChange={setPersistedSort}
          data={jobs}
          rowKey={(job) => job.id}
          onRowClick={(job) => openJob(job.id)}
          columns={[
            {
              key: 'select',
              header: '',
              render: (job) => (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(job.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => toggleSelected(job.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              ),
              className: 'w-10',
              headerClassName: 'w-10',
            },
            {
              key: 'job',
              header: 'Job',
              sortValue: (job) => `${job.jobNumber} ${job.title}`,
              render: (job) => (
                <span className="inline-flex items-center gap-2 font-medium">
                  {job.jobNumber} - {job.title}
                  <UnreadMessagesBadge count={job.unreadMessages} />
                </span>
              ),
            },
            {
              key: 'client',
              header: 'Client',
              sortValue: (job) => job.client.name,
              render: (job) => job.client.name,
            },
            {
              key: 'site',
              header: 'Site',
              sortValue: (job) => formatJobSiteAddress(job) || '',
              render: (job) => formatJobSiteAddress(job) || '—',
            },
            {
              key: 'scheduled',
              header: 'Created',
              sortValue: (job) => job.createdAt || '',
              render: (job) => formatJobCreatedDate(job),
            },
            {
              key: 'jobType',
              header: 'Type',
              sortValue: (job) => job.jobType || '',
              render: (job) => <JobTypeBadge jobType={job.jobType} />,
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (job) => job.status,
              render: (job) => (
                <JobStatusSelect
                  jobId={job.id}
                  status={job.status}
                  compact
                  onUpdated={(next) =>
                    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: next } : j)))
                  }
                />
              ),
            },
            {
              key: 'billing',
              header: 'Billing',
              sortValue: (job) => parseInt(String(job.billingStatus || '0').match(/(\d+)/)?.[1] || '0', 10),
              render: (job) => <JobBillingStatusBadge status={job.billingStatus} />,
            },
            {
              key: 'assignees',
              header: 'Assignees',
              sortValue: (job) => formatJobAssignees(job),
              render: (job) => (
                <span className={job.assignments?.length ? 'text-gray-900' : 'italic text-gray-400'}>
                  {formatJobAssignees(job)}
                </span>
              ),
            },
            {
              key: 'estimate',
              header: 'Total Cost',
              sortValue: (job) => Number(job.totalCost || job.estimateAmount || 0),
              render: (job) => (job.totalCost ? formatCurrency(parseFloat(job.totalCost)) : (job.estimateAmount ? formatCurrency(parseFloat(job.estimateAmount)) : '-')),
            },
            {
              key: 'jobOpen',
              header: 'Job Open',
              sortValue: (job) => Number(job.openInvoiceBalance || 0),
              render: (job) => <span className="font-medium text-amber-700">{formatCurrency(parseFloat(job.openInvoiceBalance || '0'))}</span>,
            },
            {
              key: 'clientOpen',
              header: 'Client Open',
              sortValue: (job) => Number(job.clientOpenInvoiceBalance || 0),
              render: (job) => <span className="font-medium text-amber-700">{formatCurrency(parseFloat(job.clientOpenInvoiceBalance || '0'))}</span>,
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (job) => (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      router.push(`/dashboard/estimates/new?jobId=${job.id}&clientId=${job.client.id}`)
                    }}
                    className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                    title="New Estimate"
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(job.id, job.title)
                    }}
                    disabled={deletingId === job.id}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={isFetching}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
        </>
      )}
    </div>
  )
}
