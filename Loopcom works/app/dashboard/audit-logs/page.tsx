'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { formatDateTime } from '@/lib/utils'
import { History, ChevronDown, ChevronRight } from 'lucide-react'

interface AuditLogRow {
  id: string
  action: string
  entityType: string
  entityId: string | null
  changes: any
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  user: {
    id: string
    firstName: string | null
    lastName: string | null
    email: string
  } | null
}

function actorName(user: AuditLogRow['user']) {
  if (!user) return 'System'
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email
}

const ACTION_COLORS: Record<string, string> = {
  CREATE: 'bg-green-100 text-green-700',
  UPDATE: 'bg-blue-100 text-blue-700',
  DELETE: 'bg-red-100 text-red-700',
  REFUND: 'bg-amber-100 text-amber-700',
  LOGIN: 'bg-gray-100 text-gray-700',
  LOGOUT: 'bg-gray-100 text-gray-700',
  PASSWORD_RESET: 'bg-purple-100 text-purple-700',
  PERMISSION_CHANGE: 'bg-indigo-100 text-indigo-700',
}

export default function AuditLogsPage() {
  const router = useRouter()
  const [logs, setLogs] = useState<AuditLogRow[]>([])
  const [entityTypes, setEntityTypes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [entityType, setEntityType] = useState('all')
  const [entityId, setEntityId] = useState('')
  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    setPage(1)
  }, [entityType, entityId, userId, from, to])

  useEffect(() => {
    fetchLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId, userId, from, to, page])

  const fetchLogs = async () => {
    setIsFetching(true)
    setError(null)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const params = new URLSearchParams({ page: String(page), limit: '50' })
      if (entityType !== 'all') params.set('entityType', entityType)
      if (entityId.trim()) params.set('entityId', entityId.trim())
      if (userId.trim()) params.set('userId', userId.trim())
      if (from) params.set('from', from)
      if (to) params.set('to', to)

      const response = await fetch(`/api/audit-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (response.status === 403) {
        setError('You do not have permission to view audit logs.')
        setLogs([])
        return
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setError(data.error || 'Failed to load audit logs')
        return
      }

      const data = await response.json()
      setLogs(data.logs || [])
      setEntityTypes(data.entityTypes || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (err) {
      console.error('Failed to fetch audit logs:', err)
      setError('Failed to load audit logs')
    } finally {
      setLoading(false)
      setIsFetching(false)
    }
  }

  const clearFilters = () => {
    setEntityType('all')
    setEntityId('')
    setUserId('')
    setFrom('')
    setTo('')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading audit logs...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
          <History className="h-7 w-7" />
          Audit Logs
        </h1>
        <p className="mt-2 text-gray-600">Who did what, when — with a record of any tracked changes</p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="w-full lg:w-[200px]">
              <label className="mb-1 block text-xs text-muted-foreground">Entity Type</label>
              <Select value={entityType} onValueChange={setEntityType}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {entityTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-full lg:w-[220px]">
              <label className="mb-1 block text-xs text-muted-foreground">Entity ID</label>
              <Input
                placeholder="e.g. cln_abc123"
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
              />
            </div>
            <div className="w-full lg:w-[220px]">
              <label className="mb-1 block text-xs text-muted-foreground">User ID</label>
              <Input
                placeholder="Actor user id"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">From</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[160px]" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">To</label>
              <Input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="w-[160px]"
              />
            </div>
            {(entityType !== 'all' || entityId || userId || from || to) && (
              <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="py-8 text-center text-red-600">{error}</CardContent>
        </Card>
      )}

      {!error && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {total} log{total === 1 ? '' : 's'}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {logs.length === 0 ? (
              <div className="py-12 text-center text-gray-500">No audit log entries match these filters.</div>
            ) : (
              <div className="divide-y">
                {logs.map((log) => {
                  const expanded = expandedId === log.id
                  const hasChanges = log.changes && Object.keys(log.changes).length > 0
                  return (
                    <div key={log.id} className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => hasChanges && setExpandedId(expanded ? null : log.id)}
                        className={`w-full flex items-center gap-3 text-left ${hasChanges ? 'cursor-pointer' : 'cursor-default'}`}
                      >
                        {hasChanges ? (
                          expanded ? (
                            <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
                          )
                        ) : (
                          <span className="w-4 shrink-0" />
                        )}
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-semibold shrink-0 ${
                            ACTION_COLORS[log.action] || 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {log.action}
                        </span>
                        <span className="text-sm font-medium text-gray-900 shrink-0">{log.entityType}</span>
                        {log.entityId && (
                          <span className="text-xs text-gray-400 font-mono truncate">{log.entityId}</span>
                        )}
                        <span className="flex-1" />
                        <span className="text-sm text-gray-600 shrink-0">{actorName(log.user)}</span>
                        <span className="text-xs text-gray-400 shrink-0">{formatDateTime(log.createdAt)}</span>
                      </button>
                      {expanded && hasChanges && (
                        <pre className="mt-2 ml-7 max-h-72 overflow-auto rounded-md bg-gray-50 border p-3 text-xs text-gray-700 whitespace-pre-wrap">
                          {JSON.stringify(log.changes, null, 2)}
                        </pre>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={isFetching}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  )
}
