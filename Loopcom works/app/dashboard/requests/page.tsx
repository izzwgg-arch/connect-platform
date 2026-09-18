'use client'

import { openFromList } from '@/lib/navigation/nav-stack'
import { useListRestore } from '@/hooks/useListRestore'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { Plus, Search, Filter, User, Phone, Mail, CheckCircle, Trash2, FileText, Briefcase, Copy, Calendar, UserPlus } from 'lucide-react'
import Link from 'next/link'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import { CreateOnlyAccessCard } from '@/components/permissions/CreateOnlyAccessCard'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { JOB_TYPES } from '@/lib/jobs/types'
import { JobTypeBadge } from '@/components/jobs/JobTypeSelect'

interface Request {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  company: string | null
  source: string
  status: string
  jobType?: string | null
  isUrgent?: boolean
  urgentAt?: string | null
  urgentByUserId?: string | null
  value: string | null
  probability: number
  convertedToClientId: string | null
  convertedAt: string | null
  createdAt: string
  assignedTo: {
    id: string
    firstName: string
    lastName: string
  } | null
  createdBy: {
    id: string
    firstName: string
    lastName: string
  } | null
  client: {
    id: string
    name: string
  } | null
  _count: {
    estimates: number
    calls: number
    smsMessages: number
    emails: number
  }
}

const statusColors: Record<string, string> = {
  NEW: 'bg-blue-100 text-blue-800',
  CONTACTED: 'bg-yellow-100 text-yellow-800',
  QUALIFIED: 'bg-green-100 text-green-800',
  ESTIMATE_CREATED: 'bg-teal-100 text-teal-800',
  ESTIMATE_SENT: 'bg-purple-100 text-purple-800',
  FOLLOW_UP: 'bg-orange-100 text-orange-800',
  CONVERTED: 'bg-indigo-100 text-indigo-800',
  LOST: 'bg-red-100 text-red-800',
}

const statusLabels: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  ESTIMATE_CREATED: 'Estimate Created',
  ESTIMATE_SENT: 'Estimate Sent',
  FOLLOW_UP: 'Follow Up',
  CONVERTED: 'Converted',
  LOST: 'Lost',
}

const sourceColors: Record<string, string> = {
  WEBSITE: 'bg-blue-100 text-blue-800',
  REFERRAL: 'bg-green-100 text-green-800',
  PHONE: 'bg-purple-100 text-purple-800',
  EMAIL: 'bg-yellow-100 text-yellow-800',
  SOCIAL_MEDIA: 'bg-pink-100 text-pink-800',
  OTHER: 'bg-gray-100 text-gray-800',
}

// ── persistent list state ─────────────────────────────────────────────────────
const REQUESTS_LIST_KEY = 'trimpro.requests.listState'

type RequestsListState = {
  status: string
  source: string
  jobType: string
  search: string
  sortKey: string | null
  sortDirection: 'asc' | 'desc'
}

const REQUESTS_DEFAULTS: RequestsListState = {
  status: 'all',
  source: 'all',
  jobType: 'all',
  search: '',
  sortKey: null,
  sortDirection: 'asc',
}

function loadRequestsListState(): RequestsListState {
  if (typeof window === 'undefined') return REQUESTS_DEFAULTS
  try {
    const raw = localStorage.getItem(REQUESTS_LIST_KEY)
    if (!raw) return REQUESTS_DEFAULTS
    const p = JSON.parse(raw) as Partial<RequestsListState>
    return {
      status: typeof p.status === 'string' ? p.status : REQUESTS_DEFAULTS.status,
      source: typeof p.source === 'string' ? p.source : REQUESTS_DEFAULTS.source,
      jobType: typeof p.jobType === 'string' ? p.jobType : REQUESTS_DEFAULTS.jobType,
      search: typeof p.search === 'string' ? p.search : REQUESTS_DEFAULTS.search,
      sortKey: typeof p.sortKey === 'string' ? p.sortKey : null,
      sortDirection: p.sortDirection === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return REQUESTS_DEFAULTS
  }
}

function saveRequestsListState(s: RequestsListState) {
  localStorage.setItem(REQUESTS_LIST_KEY, JSON.stringify(s))
}

export default function RequestsPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('requests')
  const [requests, setRequests] = useState<Request[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [listState, setListStateRaw] = useState<RequestsListState>(loadRequestsListState)
  const { status, source, jobType, search, sortKey, sortDirection } = listState
  const debouncedSearch = useDebouncedValue(search, 300)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [urgentBusyById, setUrgentBusyById] = useState<Record<string, boolean>>({})
  const [viewMode, setViewMode] = useViewMode('requests', 'grid')
  const { permissions: userPermissions, loading: permissionsLoading } = usePermissions()
  const canCreateRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.create')
  const canViewList = !permissionsLoading && hasPermission(userPermissions, 'leads.view')
  const canEditRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.edit')
  const canDeleteRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.delete')
  const canConvertRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.convert')

  const setListState = useCallback((updates: Partial<RequestsListState>) => {
    setListStateRaw((prev) => {
      const next = { ...prev, ...updates }
      saveRequestsListState(next)
      return next
    })
  }, [])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, status, source, jobType, sortKey, sortDirection])

  const fetchRequests = useCallback(async (silent = false) => {
    if (!canViewList) {
      setRequests([])
      setInitialLoading(false)
      if (!silent) setIsFetching(false)
      return
    }

    if (!silent) setIsFetching(true)
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search: debouncedSearch,
        status,
        source,
        jobType,
        page: String(page),
        limit: '50',
      })
      if (sortKey) {
        params.set('sortBy', sortKey)
        params.set('sortDirection', sortDirection)
      }

      const response = await fetch(`/api/leads?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setRequests(data.leads || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch requests:', error)
    } finally {
      setInitialLoading(false)
      if (!silent) setIsFetching(false)
    }
  }, [page, router, debouncedSearch, sortDirection, sortKey, source, status, jobType, canViewList])

  useEffect(() => {
    if (permissionsLoading) return
    fetchRequests()
  }, [fetchRequests, permissionsLoading])

  useEffect(() => {
    const interval = window.setInterval(() => {
      fetchRequests(true)
    }, 8000)
    const onFocus = () => {
      fetchRequests(true)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchRequests])

  const handleTableSortChange = (nextSortKey: string, nextSortDirection: 'asc' | 'desc') => {
    setListState({ sortKey: nextSortKey, sortDirection: nextSortDirection })
  }

  const handleDelete = async (requestId: string, requestName: string) => {
    if (!canDeleteRequest) {
      alert('You do not have permission to delete requests.')
      return
    }
    if (!confirm(`Are you sure you want to delete the request for ${requestName}? This action cannot be undone.`)) {
      return
    }

    setDeletingId(requestId)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/leads/${requestId}`, {
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
        const errorData = await response.json().catch(() => ({ error: 'Failed to delete request' }))
        alert(errorData.error || 'Failed to delete request')
        return
      }

      // Refresh the list
      fetchRequests()
    } catch (error) {
      console.error('Failed to delete request:', error)
      alert('Failed to delete request. Please try again.')
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleUrgent = async (requestId: string, nextUrgent: boolean) => {
    if (!canEditRequest) {
      alert('You do not have permission to edit requests.')
      return
    }
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }

    const previous = requests
    setUrgentBusyById((prev) => ({ ...prev, [requestId]: true }))
    setRequests((prev) => prev.map((request) => (request.id === requestId ? { ...request, isUrgent: nextUrgent } : request)))

    try {
      const response = await fetch(`/api/requests/${requestId}/urgent`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isUrgent: nextUrgent }),
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to update urgent flag' }))
        setRequests(previous)
        alert(errorData.error || 'Failed to update urgent flag')
        return
      }
      const payload = await response.json().catch(() => ({}))
      const updated = payload?.lead as Request | undefined
      if (updated?.id) {
        setRequests((prev) => prev.map((request) => (request.id === updated.id ? { ...request, ...updated } : request)))
      }
    } catch (error) {
      setRequests(previous)
      alert('Failed to update urgent flag')
    } finally {
      setUrgentBusyById((prev) => ({ ...prev, [requestId]: false }))
    }
  }

  const handleConvertToEstimate = async (request: Request) => {
    if (!canConvertRequest) {
      alert('You do not have permission to convert requests.')
      return
    }
    const requestName = `${request.firstName} ${request.lastName}`.trim()
    if (!confirm(`Open a new estimate draft for request "${requestName}"? (It will only convert after you Save.)`)) return

    // Important business rule: do NOT convert/create an Estimate just by clicking this button.
    // Instead, open the New Estimate page prefilled; conversion happens only on Save.
    const attachedClientId = request.convertedToClientId || request.client?.id || ''
    const query = new URLSearchParams({
      requestId: request.id,
      ...(attachedClientId ? { clientId: attachedClientId } : {}),
    })
    router.push(`/dashboard/estimates/new?${query.toString()}`)
  }

  const handleConvertToJob = async (request: Request) => {
    if (!canConvertRequest) {
      alert('You do not have permission to convert requests.')
      return
    }
    const requestName = `${request.firstName} ${request.lastName}`.trim()
    if (!confirm(`Convert request "${requestName}" into a job?`)) return

    setConvertingId(request.id)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/leads/${request.id}/convert-to-job`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to convert request to job')
        return
      }

      const jobId = data?.job?.id
      if (jobId) {
        router.push(`/dashboard/jobs/${jobId}`)
      } else {
        fetchRequests()
      }
    } catch (error) {
      console.error('Failed to convert request to job:', error)
      alert('Failed to convert request to job. Please try again.')
    } finally {
      setConvertingId(null)
    }
  }

  const handleDuplicateSelected = async () => {
    if (!canCreateRequest) {
      alert('You do not have permission to create requests.')
      return
    }
    if (selectedIds.length === 0) return
    if (!confirm(`Duplicate ${selectedIds.length} selected request(s)?`)) return

    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      for (const requestId of selectedIds) {
        const response = await fetch(`/api/leads/${requestId}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          alert(data.error || 'Failed to duplicate one or more requests')
          break
        }
      }

      setSelectedIds([])
      fetchRequests()
    } catch (error) {
      console.error('Failed duplicating requests:', error)
      alert('Failed to duplicate selected requests')
    } finally {
      setDuplicating(false)
    }
  }

  const toggleSelected = (requestId: string, checked: boolean) => {
    setSelectedIds((prev) =>
      checked ? (prev.includes(requestId) ? prev : [...prev, requestId]) : prev.filter((id) => id !== requestId)
    )
  }

  if (initialLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading requests...</p>
        </div>
      </div>
    )
  }

  const pipelineStats = {
    new: requests.filter((r) => r.status === 'NEW').length,
    contacted: requests.filter((r) => r.status === 'CONTACTED').length,
    qualified: requests.filter((r) => r.status === 'QUALIFIED').length,
    converted: requests.filter((r) => r.status === 'CONVERTED').length,
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Requests</h1>
          <p className="mt-2 text-gray-600">Manage your sales pipeline</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          {canViewList && (
            <Button
              variant="outline"
              onClick={handleDuplicateSelected}
              disabled={selectedIds.length === 0 || duplicating || !canCreateRequest}
            >
              <Copy className="mr-2 h-4 w-4" />
              {duplicating ? 'Duplicating...' : `Duplicate${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
            </Button>
          )}
          {canCreateRequest && (
            <Button onClick={() => router.push('/dashboard/requests/new')}>
              <Plus className="mr-2 h-4 w-4" />
              New Request
            </Button>
          )}
        </div>
      </div>

      {!canViewList && (
        <CreateOnlyAccessCard
          icon={User}
          entityLabel="requests"
          createButtonLabel="New Request"
          canCreate={canCreateRequest}
          onCreate={() => router.push('/dashboard/requests/new')}
        />
      )}

      {canViewList && (
        <>
      {/* Pipeline Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">New</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pipelineStats.new}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Contacted</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pipelineStats.contacted}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Qualified</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pipelineStats.qualified}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Converted</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{pipelineStats.converted}</div>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by request #, client name, or address..."
                value={search}
                onChange={(e) => setListState({ search: e.target.value })}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={status} onValueChange={(v) => setListState({ status: v })}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="NEW">New</SelectItem>
                  <SelectItem value="CONTACTED">Contacted</SelectItem>
                  <SelectItem value="QUALIFIED">Qualified</SelectItem>
                  <SelectItem value="ESTIMATE_CREATED">Estimate Created</SelectItem>
                  <SelectItem value="ESTIMATE_SENT">Estimate Sent</SelectItem>
                  <SelectItem value="FOLLOW_UP">Follow Up</SelectItem>
                  <SelectItem value="CONVERTED">Converted</SelectItem>
                  <SelectItem value="LOST">Lost</SelectItem>
                </SelectContent>
              </Select>
              <Select value={source} onValueChange={(v) => setListState({ source: v })}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="All Sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="WEBSITE">Website</SelectItem>
                  <SelectItem value="REFERRAL">Referral</SelectItem>
                  <SelectItem value="PHONE">Phone</SelectItem>
                  <SelectItem value="EMAIL">Email</SelectItem>
                  <SelectItem value="SOCIAL_MEDIA">Social Media</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
              <Select value={jobType} onValueChange={(v) => setListState({ jobType: v })}>
                <SelectTrigger className="w-[150px]">
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
        </CardContent>
      </Card>

      {/* Requests List */}
      {viewMode === 'grid' ? (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {requests.length === 0 ? (
          <div className="col-span-full text-center py-12">
            <User className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No requests</h3>
            <p className="mt-1 text-sm text-gray-500">
              Get started by creating a new request.
            </p>
            <div className="mt-6">
              <Button onClick={() => router.push('/dashboard/requests/new')} disabled={!canCreateRequest}>
                <Plus className="mr-2 h-4 w-4" />
                New Request
              </Button>
            </div>
          </div>
        ) : (
          requests.map((request) => {
            const expectedValue = request.value && request.probability
              ? parseFloat(request.value) * (request.probability / 100)
              : null

            return (
              <Card key={request.id} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <Link href={`/dashboard/requests/${request.id}`}>
                        <CardTitle className="text-lg hover:text-primary cursor-pointer">
                          {request.firstName} {request.lastName}
                        </CardTitle>
                      </Link>
                      {request.isUrgent ? (
                        <span className="mt-2 inline-flex rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                          URGENT
                        </span>
                      ) : null}
                      {request.company && (
                        <CardDescription className="mt-1">{request.company}</CardDescription>
                      )}
                    </div>
                    <div className="flex flex-col items-end space-y-1">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(request.id)}
                        onChange={(e) => toggleSelected(request.id, e.target.checked)}
                        className="h-4 w-4"
                        title="Select for duplicate"
                      />
                      <span className={`px-2 py-1 text-xs rounded-full ${statusColors[request.status] || 'bg-gray-100 text-gray-800'}`}>
                        {statusLabels[request.status] ?? request.status.replace(/_/g, ' ')}
                      </span>
                      <JobTypeBadge jobType={request.jobType} />
                      <span className={`px-2 py-1 text-xs rounded ${sourceColors[request.source] || 'bg-gray-100 text-gray-800'}`}>
                        {request.source}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="space-y-1">
                      {request.email && (
                        <div className="flex items-center text-sm text-gray-600">
                          <Mail className="mr-2 h-3 w-3" />
                          {request.email}
                        </div>
                      )}
                      {request.phone && (
                        <div className="flex items-center text-sm text-gray-600">
                          <Phone className="mr-2 h-3 w-3" />
                          {request.phone}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center text-sm text-gray-600">
                      <User className="mr-2 h-3 w-3 flex-shrink-0" />
                      {request.assignedTo ? (
                        <span>
                          {request.assignedTo.firstName} {request.assignedTo.lastName}
                        </span>
                      ) : (
                        <span className="text-gray-400 italic">Unassigned</span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatDate(request.createdAt)}
                      </span>
                      {request.createdBy && (
                        <span className="flex items-center gap-1">
                          <UserPlus className="h-3 w-3" />
                          {request.createdBy.firstName} {request.createdBy.lastName}
                        </span>
                      )}
                    </div>

                    {(request.value || request.probability) && (
                      <div className="pt-2 border-t">
                        {request.value && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-gray-500">Value</span>
                            <span className="font-semibold">{formatCurrency(parseFloat(request.value))}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-sm mt-1">
                          <span className="text-gray-500">Probability</span>
                          <span className="font-medium">{request.probability}%</span>
                        </div>
                        {expectedValue && (
                          <div className="flex items-center justify-between text-sm mt-1">
                            <span className="text-gray-500">Expected Value</span>
                            <span className="font-bold text-green-600">{formatCurrency(expectedValue)}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {request.convertedToClientId && (
                      <div className="pt-2 border-t">
                        <Link
                          href={`/dashboard/clients/${request.convertedToClientId}`}
                          className="flex items-center text-sm text-blue-600 hover:underline"
                        >
                          <CheckCircle className="mr-2 h-4 w-4" />
                          Converted to Client
                        </Link>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2 border-t">
                      <div className="flex items-center space-x-3 text-xs text-gray-500">
                        {request._count.estimates > 0 && <span>{request._count.estimates} estimates</span>}
                        {request._count.calls > 0 && <span>{request._count.calls} calls</span>}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleToggleUrgent(request.id, !request.isUrgent)
                          }}
                          disabled={Boolean(urgentBusyById[request.id]) || !canEditRequest}
                          className={`h-7 px-2 ${request.isUrgent ? 'text-red-600 hover:text-red-700 hover:bg-red-50' : 'text-slate-600 hover:text-slate-700 hover:bg-slate-50'}`}
                          title={request.isUrgent ? 'Unmark urgent' : 'Mark urgent'}
                        >
                          {request.isUrgent ? 'URGENT' : 'Mark Urgent'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleConvertToEstimate(request)
                          }}
                          disabled={convertingId === request.id || !canConvertRequest}
                          className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                          title="Convert to Estimate"
                        >
                          <FileText className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleConvertToJob(request)
                          }}
                          disabled={convertingId === request.id || !canConvertRequest}
                          className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                          title="Convert to Job"
                        >
                          <Briefcase className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(request.id, `${request.firstName} ${request.lastName}`)
                          }}
                          disabled={deletingId === request.id || !canDeleteRequest}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                          title="Delete Request"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {requests.map((request) => (
            <div key={request.id} className="relative">
              <input
                type="checkbox"
                checked={selectedIds.includes(request.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleSelected(request.id, e.target.checked)}
                className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2"
                title="Select for duplicate"
              />
              <RowCompactItem
                href={`/dashboard/requests/${request.id}`}
                primary={`${request.firstName} ${request.lastName}${request.isUrgent ? ' • URGENT' : ''}`.trim()}
                secondary={[
                  request.company || request.email || request.phone || 'No contact info',
                  request.assignedTo
                    ? `Assigned: ${request.assignedTo.firstName} ${request.assignedTo.lastName}`
                    : 'Assigned: Unassigned',
                  request.createdBy ? `by ${request.createdBy.firstName} ${request.createdBy.lastName}` : null,
                ].filter(Boolean).join(' · ')}
                status={
                  <div className="flex items-center gap-2">
                    <JobTypeBadge jobType={request.jobType} />
                    <span className={`px-2 py-1 text-xs rounded-full ${statusColors[request.status] || 'bg-gray-100 text-gray-800'}`}>
                      {statusLabels[request.status] ?? request.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                }
                amount={<span>{request.probability}%</span>}
                date={<span>{formatDate(request.createdAt)}</span>}
                className="pl-10"
              />
            </div>
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {requests.map((request) => (
            <div key={request.id} className="relative">
              <input
                type="checkbox"
                checked={selectedIds.includes(request.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleSelected(request.id, e.target.checked)}
                className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2"
                title="Select for duplicate"
              />
              <RowDetailedItem
                href={`/dashboard/requests/${request.id}`}
                primary={`${request.firstName} ${request.lastName}${request.isUrgent ? ' • URGENT' : ''}`.trim()}
                status={
                  <div className="flex items-center gap-2">
                    <JobTypeBadge jobType={request.jobType} />
                    <span className={`px-2 py-1 text-xs rounded-full ${statusColors[request.status] || 'bg-gray-100 text-gray-800'}`}>
                      {statusLabels[request.status] ?? request.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                }
                line2={[
                  request.company || request.email || request.phone || 'No contact info',
                  request.assignedTo
                    ? `Assigned: ${request.assignedTo.firstName} ${request.assignedTo.lastName}`
                    : 'Assigned: Unassigned',
                  formatDate(request.createdAt),
                  request.createdBy ? `Created by ${request.createdBy.firstName} ${request.createdBy.lastName}` : null,
                ].filter(Boolean).join(' · ')}
                rightTop={<span>{request.probability}%</span>}
                rightBottom={<span>{request._count.estimates} estimates</span>}
                className="pl-10"
              />
            </div>
          ))}
        </div>
      ) : (
        <TableView
          highlightedRowId={highlightedId}
          data={requests}
          rowKey={(request) => request.id}
          onRowClick={(request) => openFromList(router, { entity: 'requests', detailHref: `/dashboard/requests/${request.id}`, itemId: request.id })}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSortChange={handleTableSortChange}
          columns={[
            {
              key: 'select',
              header: '',
              render: (request) => (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(request.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => toggleSelected(request.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              ),
              className: 'w-10',
              headerClassName: 'w-10',
            },
            {
              key: 'name',
              header: 'Request',
              sortValue: (request) => `${request.firstName} ${request.lastName}`,
              render: (request) => (
                <span className="font-medium">
                  {request.firstName} {request.lastName}
                  {request.isUrgent ? (
                    <span className="ml-2 rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">URGENT</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (request) => request.status,
              render: (request) => <span className={`px-2 py-1 text-xs rounded-full ${statusColors[request.status] || 'bg-gray-100 text-gray-800'}`}>{statusLabels[request.status] ?? request.status.replace(/_/g, ' ')}</span>,
            },
            {
              key: 'jobType',
              header: 'Type',
              sortValue: (request) => request.jobType || '',
              render: (request) => <JobTypeBadge jobType={request.jobType} />,
            },
            {
              key: 'source',
              header: 'Source',
              sortValue: (request) => request.source,
              render: (request) => request.source,
            },
            {
              key: 'assigned',
              header: 'Assigned',
              sortValue: (request) =>
                request.assignedTo
                  ? `${request.assignedTo.firstName} ${request.assignedTo.lastName}`
                  : 'Unassigned',
              render: (request) =>
                request.assignedTo ? (
                  <span className="text-sm">
                    {request.assignedTo.firstName} {request.assignedTo.lastName}
                  </span>
                ) : (
                  <span className="text-sm text-gray-400 italic">Unassigned</span>
                ),
            },
            {
              key: 'probability',
              header: 'Probability',
              sortValue: (request) => request.probability,
              render: (request) => `${request.probability}%`,
            },
            {
              key: 'createdAt',
              header: 'Created',
              sortValue: (request) => request.createdAt,
              render: (request) => (
                <span className="text-xs text-gray-500">
                  {formatDate(request.createdAt)}
                  {request.createdBy ? (
                    <span className="block text-gray-400">{request.createdBy.firstName} {request.createdBy.lastName}</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (request) => (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleToggleUrgent(request.id, !request.isUrgent)
                    }}
                    disabled={Boolean(urgentBusyById[request.id]) || !canEditRequest}
                    className={request.isUrgent ? 'text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2' : 'h-7 px-2'}
                    title={request.isUrgent ? 'Unmark urgent' : 'Mark urgent'}
                  >
                    {request.isUrgent ? 'URGENT' : 'Mark Urgent'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleConvertToEstimate(request)
                    }}
                    disabled={convertingId === request.id || !canConvertRequest}
                    className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                    title="Convert to Estimate"
                  >
                    <FileText className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleConvertToJob(request)
                    }}
                    disabled={convertingId === request.id || !canConvertRequest}
                    className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                    title="Convert to Job"
                  >
                    <Briefcase className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(request.id, `${request.firstName} ${request.lastName}`)
                    }}
                    disabled={deletingId === request.id || !canDeleteRequest}
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
