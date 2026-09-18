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
import { Plus, Search, Filter, FileText, Calendar, Trash2, Briefcase, Copy } from 'lucide-react'
import Link from 'next/link'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

interface Estimate {
  id: string
  estimateNumber: string
  title: string
  status: string
  convertedPercent?: number | null
  total: string
  validUntil: string | null
  sentAt: string | null
  acceptedAt: string | null
  client: {
    id: string
    name: string
    companyName: string | null
  } | null
  lead: {
    id: string
    firstName: string
    lastName: string
  } | null
  job: {
    id: string
    jobNumber: string
  } | null
  jobSiteAddress?: string | null
  _count: {
    lineItems: number
  }
}

function StatusBadge({ estimate }: { estimate: Estimate }) {
  const label = estimate.status === 'CONVERTED' && estimate.convertedPercent
    ? `CONVERTED (${estimate.convertedPercent}%)`
    : estimate.status
  return (
    <span className={`px-2 py-1 text-xs rounded-full ${statusColors[estimate.status] || 'bg-gray-100 text-gray-800'}`}>
      {label}
    </span>
  )
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  VIEWED: 'bg-purple-100 text-purple-800',
  ACCEPTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-orange-100 text-orange-800',
  CONVERTED: 'bg-indigo-100 text-indigo-800',
}

function renderJobSiteAddress(address?: string | null) {
  const value = String(address || '').trim()
  if (!value) return null
  return (
    <span className="block max-w-[260px] truncate" title={value}>
      {value}
    </span>
  )
}

// ── persistent list state (survives back-navigation within the same tab) ──────
const ESTIMATES_LIST_KEY = 'trimpro.estimates.listState'

type EstimatesListState = {
  status: string
  search: string
  sortKey: string | null
  sortDirection: 'asc' | 'desc'
}

const LIST_DEFAULTS: EstimatesListState = {
  status: 'all',
  search: '',
  sortKey: null,
  sortDirection: 'asc',
}

function loadEstimatesListState(): EstimatesListState {
  if (typeof window === 'undefined') return LIST_DEFAULTS
  try {
    const raw = localStorage.getItem(ESTIMATES_LIST_KEY)
    if (!raw) return LIST_DEFAULTS
    const p = JSON.parse(raw) as Partial<EstimatesListState>
    return {
      status: typeof p.status === 'string' ? p.status : LIST_DEFAULTS.status,
      search: typeof p.search === 'string' ? p.search : LIST_DEFAULTS.search,
      sortKey: typeof p.sortKey === 'string' ? p.sortKey : null,
      sortDirection: p.sortDirection === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return LIST_DEFAULTS
  }
}

function saveEstimatesListState(s: EstimatesListState) {
  localStorage.setItem(ESTIMATES_LIST_KEY, JSON.stringify(s))
}

export default function EstimatesPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('estimates')
  const { permissions, loading: permissionsLoading } = usePermissions()
  const canViewList = hasPermission(permissions, 'estimates.view')
  const canCreate = hasPermission(permissions, 'estimates.create')
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [listState, setListStateRaw] = useState<EstimatesListState>(loadEstimatesListState)
  const { status, search, sortKey, sortDirection } = listState
  const debouncedSearch = useDebouncedValue(search, 300)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [viewMode, setViewMode] = useViewMode('estimates', 'grid')

  // Update list state + immediately persist so back-navigation restores it
  const setListState = useCallback((updates: Partial<EstimatesListState>) => {
    setListStateRaw((prev) => {
      const next = { ...prev, ...updates }
      saveEstimatesListState(next)
      return next
    })
  }, [])

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
  }

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, status, sortKey, sortDirection])

  const fetchEstimates = useCallback(async () => {
    if (!canViewList) {
      setEstimates([])
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
        page: String(page),
        limit: '50',
      })
      if (sortKey) {
        params.set('sortBy', sortKey)
        params.set('sortDirection', sortDirection)
      }

      const response = await fetch(`/api/estimates?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setEstimates(data.estimates || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch estimates:', error)
    } finally {
      setInitialLoading(false)
      setIsFetching(false)
    }
  }, [page, router, debouncedSearch, sortDirection, sortKey, status, canViewList])

  useEffect(() => {
    if (permissionsLoading) return
    fetchEstimates()
  }, [fetchEstimates, permissionsLoading])

  const handleTableSortChange = (nextSortKey: string, nextSortDirection: 'asc' | 'desc') => {
    setListState({ sortKey: nextSortKey, sortDirection: nextSortDirection })
  }

  const handleDelete = async (estimate: Estimate) => {
    if (!confirm(`Delete estimate "${estimate.estimateNumber}"?`)) return

    setDeletingId(estimate.id)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/estimates/${estimate.id}`, {
        method: 'DELETE',
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
        alert(data.error || 'Failed to delete estimate')
        return
      }

      fetchEstimates()
    } catch (error) {
      console.error('Failed to delete estimate:', error)
      alert('Failed to delete estimate')
    } finally {
      setDeletingId(null)
    }
  }

  const handleConvertToJob = async (estimate: Estimate) => {
    if (estimate.job) {
      router.push(`/dashboard/jobs/${estimate.job.id}`)
      return
    }
    if (!confirm(`Convert estimate "${estimate.estimateNumber}" into a job?`)) return

    setConvertingId(estimate.id)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/estimates/${estimate.id}/convert-to-job`, {
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
        alert(data.error || 'Failed to convert estimate to job')
        return
      }

      const jobId = data?.job?.id
      if (jobId) {
        router.push(`/dashboard/jobs/${jobId}`)
      } else {
        fetchEstimates()
      }
    } catch (error) {
      console.error('Failed to convert estimate:', error)
      alert('Failed to convert estimate to job')
    } finally {
      setConvertingId(null)
    }
  }

  const handleDuplicateSelected = async () => {
    if (selectedIds.length === 0) return
    if (!confirm(`Duplicate ${selectedIds.length} selected estimate(s)?`)) return

    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      for (const estimateId of selectedIds) {
        const response = await fetch(`/api/estimates/${estimateId}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          alert(data.error || 'Failed to duplicate one or more estimates')
          break
        }
      }

      setSelectedIds([])
      fetchEstimates()
    } catch (error) {
      console.error('Failed duplicating estimates:', error)
      alert('Failed to duplicate selected estimates')
    } finally {
      setDuplicating(false)
    }
  }

  if (initialLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading estimates...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Estimates</h1>
          <p className="mt-2 text-gray-600">Create and manage estimates</p>
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
            <Button onClick={() => router.push('/dashboard/estimates/new')}>
              <Plus className="mr-2 h-4 w-4" />
              New Estimate
            </Button>
          )}
        </div>
      </div>

      {!canViewList && (
        <Card>
          <CardContent className="py-10 text-center">
            <FileText className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-3 text-sm font-medium text-gray-900">Create-only access</h3>
            <p className="mt-1 text-sm text-gray-500">
              You can create new estimates, but you do not have permission to browse existing ones.
            </p>
            {canCreate && (
              <div className="mt-6">
                <Button onClick={() => router.push('/dashboard/estimates/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Estimate
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canViewList && (
        <>
      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by #, title, client, job, or address..."
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
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="SENT">Sent</SelectItem>
                  <SelectItem value="VIEWED">Viewed</SelectItem>
                  <SelectItem value="ACCEPTED">Accepted</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                  <SelectItem value="EXPIRED">Expired</SelectItem>
                  <SelectItem value="CONVERTED">Converted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Estimates List */}
      {viewMode === 'grid' ? (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {estimates.length === 0 ? (
          <div className="col-span-full text-center py-12">
            <FileText className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No estimates</h3>
            <p className="mt-1 text-sm text-gray-500">
              Get started by creating a new estimate.
            </p>
            <div className="mt-6">
              <Button onClick={() => router.push('/dashboard/estimates/new')}>
                <Plus className="mr-2 h-4 w-4" />
                New Estimate
              </Button>
            </div>
          </div>
        ) : (
          estimates.map((estimate) => (
            <Card
              key={estimate.id}
              data-row-id={estimate.id}
              className={`hover:shadow-lg transition-shadow ${
                highlightedId === estimate.id ? 'ring-2 ring-amber-300 bg-amber-50' : ''
              }`}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <Link href={`/dashboard/estimates/${estimate.id}`}>
                      <CardTitle className="text-lg hover:text-primary cursor-pointer">
                        {estimate.title}
                      </CardTitle>
                    </Link>
                    <CardDescription className="mt-1">
                      {estimate.estimateNumber}
                      {estimate.client && ` \u2022 ${estimate.client.name}`}
                      {estimate.lead && ` \u2022 ${estimate.lead.firstName} ${estimate.lead.lastName}`}
                    </CardDescription>
                    {estimate.jobSiteAddress ? (
                      <p className="mt-1 text-xs text-gray-500" title={estimate.jobSiteAddress}>
                        <span className="inline-block max-w-[320px] truncate">{estimate.jobSiteAddress}</span>
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(estimate.id)}
                      onChange={(e) =>
                        setSelectedIds((prev) =>
                          e.target.checked
                            ? [...prev, estimate.id]
                            : prev.filter((id) => id !== estimate.id)
                        )
                      }
                      className="h-4 w-4"
                      title="Select for duplicate"
                    />
                    <StatusBadge estimate={estimate} />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">Total</span>
                    <span className="text-lg font-bold">{formatCurrency(parseFloat(estimate.total))}</span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    {estimate.validUntil && (
                      <div className="flex items-center text-gray-600">
                        <Calendar className="mr-2 h-4 w-4 text-gray-400" />
                        <div>
                          <p className="text-xs text-gray-500">Valid Until</p>
                          <p className="font-medium">{formatDate(estimate.validUntil)}</p>
                        </div>
                      </div>
                    )}
                    {estimate.sentAt && (
                      <div>
                        <p className="text-xs text-gray-500">Sent</p>
                        <p className="font-medium text-gray-700">{formatDate(estimate.sentAt)}</p>
                      </div>
                    )}
                  </div>

                  {estimate.job && (
                    <div className="pt-2 border-t">
                      <Link href={`/dashboard/jobs/${estimate.job.id}`} className="text-sm text-primary hover:underline">
                        Linked to Job {estimate.job.jobNumber}
                      </Link>
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-1 pt-2 border-t">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleConvertToJob(estimate)
                      }}
                      disabled={convertingId === estimate.id}
                      className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                      title={estimate.job ? 'Open Job' : 'Convert to Job'}
                    >
                      <Briefcase className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(estimate)
                      }}
                      disabled={deletingId === estimate.id}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                      title="Delete Estimate"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {estimates.map((estimate) => (
            <RowCompactItem
              key={estimate.id}
              rowId={estimate.id}
              highlighted={highlightedId === estimate.id}
              href={`/dashboard/estimates/${estimate.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(estimate.id)}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onChange={(e) => toggleSelected(estimate.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              }
              primary={`${estimate.estimateNumber} \u2022 ${estimate.title}`}
              secondary={[
                estimate.client?.name || (estimate.lead ? `${estimate.lead.firstName} ${estimate.lead.lastName}` : 'No client'),
                estimate.jobSiteAddress || null,
              ].filter(Boolean).join(' \u2022 ')}
              status={<StatusBadge estimate={estimate} />}
              amount={formatCurrency(parseFloat(estimate.total))}
              date={estimate.validUntil ? formatDate(estimate.validUntil) : '-'}
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {estimates.map((estimate) => (
            <RowDetailedItem
              key={estimate.id}
              href={`/dashboard/estimates/${estimate.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(estimate.id)}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onChange={(e) => toggleSelected(estimate.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              }
              primary={`${estimate.estimateNumber} \u2022 ${estimate.title}`}
              status={<StatusBadge estimate={estimate} />}
              line2={[
                estimate.client?.name || (estimate.lead ? `${estimate.lead.firstName} ${estimate.lead.lastName}` : 'No client'),
                estimate.jobSiteAddress || null,
                `${estimate._count.lineItems} line items`,
              ].filter(Boolean).join(' \u2022 ')}
              rightTop={formatCurrency(parseFloat(estimate.total))}
              rightBottom={estimate.validUntil ? formatDate(estimate.validUntil) : 'No expiry'}
            />
          ))}
        </div>
      ) : (
        <TableView
          data={estimates}
          rowKey={(estimate) => estimate.id}
          highlightedRowId={highlightedId}
          onRowClick={(estimate) =>
            openFromList(router, {
              entity: 'estimates',
              detailHref: `/dashboard/estimates/${estimate.id}`,
              itemId: estimate.id,
              page,
            })
          }
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSortChange={handleTableSortChange}
          columns={[
            {
              key: 'select',
              header: '',
              render: (estimate) => (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(estimate.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => toggleSelected(estimate.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              ),
              className: 'w-10',
              headerClassName: 'w-10',
            },
            {
              key: 'estimate',
              header: 'Estimate',
              sortValue: (estimate) => `${estimate.estimateNumber} ${estimate.title}`,
              render: (estimate) => <span className="font-medium">{estimate.estimateNumber}{' \u2022 '}{estimate.title}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (estimate) => estimate.status,
              render: (estimate) => <StatusBadge estimate={estimate} />,
            },
            {
              key: 'client',
              header: 'Client',
              sortValue: (estimate) => estimate.client?.name || '',
              render: (estimate) => estimate.client?.name || '-',
            },
            {
              key: 'jobSiteAddress',
              header: 'Job Site Address',
              sortValue: () => '',
              render: (estimate) => renderJobSiteAddress(estimate.jobSiteAddress),
            },
            {
              key: 'total',
              header: 'Total',
              sortValue: (estimate) => Number(estimate.total),
              render: (estimate) => formatCurrency(parseFloat(estimate.total)),
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (estimate) => (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleConvertToJob(estimate)
                    }}
                    disabled={convertingId === estimate.id}
                    className="h-7 px-2 bg-transparent hover:bg-transparent text-[#2E4A59] hover:text-[#2E4A59] border border-[#2E4A59]/30 hover:border-[#2E4A59]"
                  >
                    <Briefcase className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(estimate)
                    }}
                    disabled={deletingId === estimate.id}
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
