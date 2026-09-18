'use client'
import { useListRestore } from '@/hooks/useListRestore'
import { usePersistedSort } from '@/hooks/useListPreferences'
import { openFromList } from '@/lib/navigation/nav-stack'

import { useEffect, useState } from 'react'
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
import { formatDate } from '@/lib/utils'
import { Plus, Search, Filter, AlertCircle, User, Clock, CheckCircle } from 'lucide-react'
import Link from 'next/link'
import { useDocumentListAccess } from '@/hooks/useDocumentListAccess'
import { CreateOnlyAccessCard } from '@/components/permissions/CreateOnlyAccessCard'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

interface Issue {
  id: string
  title: string
  description: string | null
  type: string
  status: string
  priority: string
  firstResponseAt: string | null
  resolvedAt: string | null
  closedAt: string | null
  assignee: {
    id: string
    firstName: string
    lastName: string
    email: string
  } | null
  creator: {
    firstName: string
    lastName: string
  }
  client: {
    id: string
    name: string
  } | null
  job: {
    id: string
    jobNumber: string
    title: string
  } | null
  watchers: Array<{
    user: {
      id: string
      firstName: string
      lastName: string
    }
  }>
  _count: {
    notes: number
    tasks: number
  }
}

const statusColors: Record<string, string> = {
  OPEN: 'bg-red-100 text-red-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  RESOLVED: 'bg-green-100 text-green-800',
  CLOSED: 'bg-gray-100 text-gray-800',
  CANCELLED: 'bg-gray-100 text-gray-800',
}

const priorityColors: Record<string, string> = {
  LOW: 'text-gray-600',
  MEDIUM: 'text-blue-600',
  HIGH: 'text-orange-600',
  CRITICAL: 'text-red-600',
}

const typeColors: Record<string, string> = {
  BILLING: 'bg-purple-100 text-purple-800',
  SCHEDULING: 'bg-blue-100 text-blue-800',
  WARRANTY: 'bg-yellow-100 text-yellow-800',
  QUALITY: 'bg-orange-100 text-orange-800',
  SAFETY: 'bg-red-100 text-red-800',
  OTHER: 'bg-gray-100 text-gray-800',
}

export default function IssuesPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('issues')
  const { sortKey: persistedSortKey, sortDirection: persistedSortDirection, setSort: setPersistedSort } = usePersistedSort('issues')
  const searchParams = useSearchParams()
  const { permissionsLoading, canViewList, canCreate } = useDocumentListAccess('issues.view', 'issues.create')
  const [issues, setIssues] = useState<Issue[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [filter, setFilter] = useState('all') // all, my, assigned, watched
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [viewMode, setViewMode] = useViewMode('issues', 'grid')

  useEffect(() => {
    const statusParam = searchParams.get('status')
    if (statusParam) {
      setStatus(statusParam)
    }
  }, [searchParams])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, status, type, filter])

  useEffect(() => {
    if (permissionsLoading) return
    fetchIssues()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, status, type, filter, page, permissionsLoading, canViewList])

  const fetchIssues = async () => {
    if (!canViewList) {
      setIssues([])
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
        type,
        filter,
        page: String(page),
        limit: '50',
      })

      const response = await fetch(`/api/issues?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setIssues(data.issues || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch issues:', error)
    } finally {
      setInitialLoading(false)
      setIsFetching(false)
    }
  }

  if (initialLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading issues...</p>
        </div>
      </div>
    )
  }

  const openIssues = issues.filter((issue) => issue.status === 'OPEN' || issue.status === 'IN_PROGRESS')
  const criticalIssues = issues.filter((issue) => issue.priority === 'CRITICAL' && issue.status !== 'RESOLVED' && issue.status !== 'CLOSED')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Issues & Tickets</h1>
          <p className="mt-2 text-gray-600">Track and resolve issues</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          {canCreate && (
            <Button onClick={() => router.push('/dashboard/issues/new')}>
              <Plus className="mr-2 h-4 w-4" />
              New Issue
            </Button>
          )}
        </div>
      </div>

      {!canViewList && (
        <CreateOnlyAccessCard
          icon={AlertCircle}
          entityLabel="issues"
          createButtonLabel="New Issue"
          canCreate={canCreate}
          onCreate={() => router.push('/dashboard/issues/new')}
        />
      )}

      {canViewList && (
        <>
      {/* Summary Cards */}
      {(openIssues.length > 0 || criticalIssues.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {openIssues.length > 0 && (
            <Card className="border-orange-300 bg-orange-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-orange-900 flex items-center">
                  <AlertCircle className="mr-2 h-4 w-4" />
                  Open Issues
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-orange-600">{openIssues.length}</div>
                <p className="text-xs text-orange-700 mt-1">Requires attention</p>
              </CardContent>
            </Card>
          )}
          {criticalIssues.length > 0 && (
            <Card className="border-red-300 bg-red-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-red-900 flex items-center">
                  <AlertCircle className="mr-2 h-4 w-4" />
                  Critical Issues
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">{criticalIssues.length}</div>
                <p className="text-xs text-red-700 mt-1">Urgent priority</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search issues by title, client, job, or assignee..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder="All Issues" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Issues</SelectItem>
                  <SelectItem value="my">My Issues</SelectItem>
                  <SelectItem value="assigned">Assigned to Me</SelectItem>
                  <SelectItem value="watched">Watched</SelectItem>
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="OPEN">Open</SelectItem>
                  <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                  <SelectItem value="RESOLVED">Resolved</SelectItem>
                  <SelectItem value="CLOSED">Closed</SelectItem>
                  <SelectItem value="CANCELLED">Cancelled</SelectItem>
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="BILLING">Billing</SelectItem>
                  <SelectItem value="SCHEDULING">Scheduling</SelectItem>
                  <SelectItem value="WARRANTY">Warranty</SelectItem>
                  <SelectItem value="QUALITY">Quality</SelectItem>
                  <SelectItem value="SAFETY">Safety</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Issues List */}
      {viewMode === 'grid' ? (
      <div className="space-y-4">
        {issues.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <AlertCircle className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No issues</h3>
              <p className="mt-1 text-sm text-gray-500">
                All clear! Create an issue if something comes up.
              </p>
              <div className="mt-6">
                <Button onClick={() => router.push('/dashboard/issues/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Issue
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          issues.map((issue) => (
            <Card
              key={issue.id}
              className={`hover:shadow-lg transition-shadow ${
                issue.status === 'OPEN' ? 'border-l-4 border-l-red-500' : ''
              } ${issue.status === 'RESOLVED' || issue.status === 'CLOSED' ? 'opacity-75' : ''}`}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <Link href={`/dashboard/issues/${issue.id}`}>
                        <CardTitle className="text-lg hover:text-primary cursor-pointer">
                          {issue.title}
                        </CardTitle>
                      </Link>
                      <span className={`px-2 py-1 text-xs rounded ${typeColors[issue.type] || 'bg-gray-100 text-gray-800'}`}>
                        {issue.type}
                      </span>
                    </div>
                    <CardDescription className="mt-1">
                      Created by {issue.creator.firstName} {issue.creator.lastName}
                      {issue.client && ` \u2022 ${issue.client.name}`}
                      {issue.job && ` \u2022 Job ${issue.job.jobNumber}`}
                    </CardDescription>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className={`px-2 py-1 text-xs rounded-full ${statusColors[issue.status] || 'bg-gray-100 text-gray-800'}`}>
                      {issue.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {issue.description && (
                    <p className="text-sm text-gray-600 line-clamp-2">{issue.description}</p>
                  )}

                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center">
                        <User className="mr-1 h-3 w-3 text-gray-400" />
                        <span className="text-gray-600">
                          {issue.assignee
                            ? `${issue.assignee.firstName} ${issue.assignee.lastName}`
                            : 'Unassigned'}
                        </span>
                      </div>
                      <span className={`font-medium ${priorityColors[issue.priority] || 'text-gray-600'}`}>
                        {issue.priority}
                      </span>
                      {issue._count.notes > 0 && (
                        <span className="text-gray-500">{issue._count.notes} notes</span>
                      )}
                      {issue._count.tasks > 0 && (
                        <span className="text-gray-500">{issue._count.tasks} tasks</span>
                      )}
                      {issue.watchers.length > 0 && (
                        <span className="text-gray-500">{issue.watchers.length} watchers</span>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 text-xs text-gray-500">
                      {issue.firstResponseAt && (
                        <div className="flex items-center">
                          <Clock className="mr-1 h-3 w-3" />
                          <span>First response: {formatDate(issue.firstResponseAt)}</span>
                        </div>
                      )}
                      {issue.resolvedAt && (
                        <div className="flex items-center text-green-600">
                          <CheckCircle className="mr-1 h-3 w-3" />
                          <span>Resolved: {formatDate(issue.resolvedAt)}</span>
                        </div>
                      )}
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
          {issues.map((issue) => (
            <RowCompactItem
              key={issue.id}
              href={`/dashboard/issues/${issue.id}`}
              primary={issue.title}
              secondary={`${issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}` : 'Unassigned'}${issue.client?.name ? ` • ${issue.client.name}` : issue.job?.jobNumber ? ` • ${issue.job.jobNumber}` : ''}`}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[issue.status] || 'bg-gray-100 text-gray-800'}`}>{issue.status.replace('_', ' ')}</span>}
              amount={issue.priority}
              date={issue.resolvedAt ? formatDate(issue.resolvedAt) : '-'}
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {issues.map((issue) => (
            <RowDetailedItem
              key={issue.id}
              href={`/dashboard/issues/${issue.id}`}
              primary={issue.title}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[issue.status] || 'bg-gray-100 text-gray-800'}`}>{issue.status.replace('_', ' ')}</span>}
              line2={`${issue.type} \u2022 ${issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}` : 'Unassigned'} \u2022 ${issue._count.notes} notes`}
              rightTop={issue.priority}
              rightBottom={issue.firstResponseAt ? formatDate(issue.firstResponseAt) : 'No response'}
            />
          ))}
        </div>
      ) : (
        <TableView
          highlightedRowId={highlightedId}
          sortKey={persistedSortKey}
          sortDirection={persistedSortDirection}
          onSortChange={setPersistedSort}
          data={issues}
          rowKey={(issue) => issue.id}
          onRowClick={(issue) => openFromList(router, { entity: 'issues', detailHref: `/dashboard/issues/${issue.id}`, itemId: issue.id })}
          columns={[
            {
              key: 'title',
              header: 'Issue',
              sortValue: (issue) => issue.title,
              render: (issue) => <span className="font-medium">{issue.title}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (issue) => issue.status,
              render: (issue) => <span className={`px-2 py-1 text-xs rounded-full ${statusColors[issue.status] || 'bg-gray-100 text-gray-800'}`}>{issue.status.replace('_', ' ')}</span>,
            },
            {
              key: 'type',
              header: 'Type',
              sortValue: (issue) => issue.type,
              render: (issue) => issue.type,
            },
            {
              key: 'priority',
              header: 'Priority',
              sortValue: (issue) => issue.priority,
              render: (issue) => issue.priority,
            },
            {
              key: 'assignee',
              header: 'Assignee',
              sortValue: (issue) => issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}` : '',
              render: (issue) => issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}` : '-',
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
