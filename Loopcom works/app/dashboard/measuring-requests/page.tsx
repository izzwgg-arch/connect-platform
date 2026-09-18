'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { Filter, Ruler, Search } from 'lucide-react'

type MeasuringRequestRow = {
  id: string
  requestId: string
  status: 'pending' | 'opened' | 'completed'
  notes?: string | null
  createdAt: string
  openedAt?: string | null
  completedAt?: string | null
  notificationAttempts: number
  request: {
    id: string
    customerName: string
    address?: string | null
  }
  assignedUser: {
    id: string
    firstName: string
    lastName: string
    email: string | null
  }
  createdByUser: {
    id: string
    firstName: string
    lastName: string
  }
}

type AssignableUser = {
  id: string
  firstName: string
  lastName: string
  email: string | null
}

const statusBadgeClass: Record<MeasuringRequestRow['status'], string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200',
  opened: 'bg-blue-100 text-blue-800 border-blue-200',
  completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
}

export default function MeasuringRequestsAdminPage() {
  const router = useRouter()
  const [rows, setRows] = useState<MeasuringRequestRow[]>([])
  const [users, setUsers] = useState<AssignableUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('ALL')
  const [assignedUserId, setAssignedUserId] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [completingId, setCompletingId] = useState<string | null>(null)

  useEffect(() => {
    void fetchAssignableUsers()
  }, [])

  useEffect(() => {
    setPage(1)
  }, [search, status, assignedUserId])

  useEffect(() => {
    void fetchRows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, assignedUserId, page])

  const fetchAssignableUsers = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const response = await fetch('/api/measuring-requests/assignable-users', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return
      const payload = await response.json().catch(() => ({ users: [] }))
      setUsers(Array.isArray(payload?.users) ? payload.users : [])
    } catch (error) {
      console.error('Failed to fetch measuring assignees:', error)
    }
  }

  const fetchRows = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const params = new URLSearchParams({
        search,
        status,
        page: String(page),
        limit: '50',
      })
      if (assignedUserId !== 'all') params.set('assignedUserId', assignedUserId)
      const response = await fetch(`/api/measuring-requests?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (response.status === 403) {
        alert('You do not have permission to view measuring requests.')
        router.push('/dashboard')
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to load measuring requests' }))
        alert(payload.error || 'Failed to load measuring requests')
        return
      }
      const payload = await response.json()
      setRows(Array.isArray(payload?.measuringRequests) ? payload.measuringRequests : [])
      setTotalPages(Number(payload?.pagination?.totalPages || 1))
      setTotal(Number(payload?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch measuring requests:', error)
      alert('Failed to load measuring requests')
    } finally {
      setLoading(false)
    }
  }

  const handleMarkCompleted = async (id: string) => {
    setCompletingId(id)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const response = await fetch(`/api/measuring-requests/${id}/complete`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to complete measuring request' }))
        alert(payload.error || 'Failed to complete measuring request')
        return
      }
      await fetchRows()
    } catch (error) {
      console.error('Failed to complete measuring request:', error)
      alert('Failed to complete measuring request')
    } finally {
      setCompletingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Measuring Requests</h1>
          <p className="mt-2 text-gray-600">Track and manage field measuring assignments.</p>
        </div>
        <div className="inline-flex items-center rounded-md border bg-white px-3 py-2 text-sm text-gray-700">
          <Ruler className="mr-2 h-4 w-4" />
          {total} total
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Filter by status, assignee, or search text.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-10"
                placeholder="Search customer, address, notes..."
              />
            </div>
            <div className="inline-flex items-center gap-2">
              <Filter className="h-4 w-4 text-gray-500" />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Statuses</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="OPENED">Opened</SelectItem>
                  <SelectItem value="COMPLETED">Completed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={assignedUserId} onValueChange={setAssignedUserId}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Assignee" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Assignees</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.firstName} {u.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assignments</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-10 text-center text-sm text-gray-500">Loading measuring requests...</div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-500">No measuring requests found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead>
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2">Request</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Assigned To</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => (
                    <tr key={row.id} className="text-sm text-gray-700">
                      <td className="px-3 py-3 font-medium">{row.request.id}</td>
                      <td className="px-3 py-3">
                        <div>{row.request.customerName}</div>
                        {row.request.address ? (
                          <div className="max-w-[320px] truncate text-xs text-gray-500">{row.request.address}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        {row.assignedUser.firstName} {row.assignedUser.lastName}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${statusBadgeClass[row.status]}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">
                        <div>{new Date(row.createdAt).toLocaleString()}</div>
                        {row.completedAt ? <div>Done {new Date(row.completedAt).toLocaleString()}</div> : null}
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">
                        <div className="max-w-[260px] truncate">{row.notes || '-'}</div>
                        <div>Reminders: {row.notificationAttempts}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => router.push(`/dashboard/requests/${row.requestId}`)}>
                            Open Request
                          </Button>
                          {row.status !== 'completed' ? (
                            <Button
                              size="sm"
                              onClick={() => void handleMarkCompleted(row.id)}
                              disabled={completingId === row.id}
                            >
                              {completingId === row.id ? 'Saving...' : 'Mark Completed'}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={loading}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  )
}
