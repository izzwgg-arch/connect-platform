'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Edit, Phone, Mail, User, Building2, Calendar, DollarSign, TrendingUp, CheckCircle, CheckSquare, FileText, MessageSquare, AlertCircle, Plus, Trash2, Ruler } from 'lucide-react'
import Link from 'next/link'
import { parseAddressParts } from '@/lib/address/parse'
import { buildCreateContextQuery } from '@/src/lib/create-context'
import { DocumentAttachments } from '@/components/common/document-attachments'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import { JobTypeBadge } from '@/components/jobs/JobTypeSelect'

interface RequestDetail {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  company: string | null
  source: string
  status: string
  jobType?: string
  isUrgent?: boolean
  urgentAt?: string | null
  urgentByUserId?: string | null
  value: string | null
  probability: number
  notes: string | null
  jobSiteAddress: string | null
  jobSiteCity?: string | null
  jobSiteState?: string | null
  jobSiteZipCode?: string | null
  convertedToClientId: string | null
  convertedAt: string | null
  assignedTo: {
    id: string
    firstName: string
    lastName: string
    email: string | null
    phone: string | null
  } | null
  client: {
    id: string
    name: string
    companyName: string | null
  } | null
  estimates: Array<{
    id: string
    estimateNumber: string
    title: string
    total: string
    status: string
    createdAt: string
  }>
  tasks: Array<{
    id: string
    title: string
    status: string
    priority: string
    dueDate: string | null
  }>
  issues: Array<{
    id: string
    title: string
    status: string
    priority: string
  }>
  calls: Array<{
    id: string
    direction: string
    status: string
    fromNumber: string
    toNumber: string
    duration: number | null
    startedAt: string
  }>
  smsMessages: Array<{
    id: string
    direction: string
    status: string
    body: string
    sentAt: string | null
  }>
  emails: Array<{
    id: string
    direction: string
    status: string
    subject: string
    sentAt: string | null
  }>
  schedules: Array<{
    id: string
    startTime: string
    endTime: string
    user: {
      firstName: string
      lastName: string
    }
  }>
  activities: Array<{
    id: string
    type: string
    description: string
    createdAt: string
    user: {
      firstName: string
      lastName: string
    }
  }>
  _count: {
    estimates: number
    tasks: number
    issues: number
    calls: number
    smsMessages: number
    emails: number
  }
}

interface AssignableUser {
  id: string
  firstName: string
  lastName: string
  email: string | null
  role: string
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

export default function RequestDetailPage() {
  const params = useParams()
  const router = useRouter()
  const requestId = params.id as string
  const [request, setRequest] = useState<RequestDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [urgentBusy, setUrgentBusy] = useState(false)
  const [measuringDialogOpen, setMeasuringDialogOpen] = useState(false)
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [selectedMeasuringUserId, setSelectedMeasuringUserId] = useState('')
  const [measuringNotes, setMeasuringNotes] = useState('')
  const [measuringSearch, setMeasuringSearch] = useState('')
  const [sendingMeasuringRequest, setSendingMeasuringRequest] = useState(false)
  const { permissions: userPermissions, loading: permissionsLoading } = usePermissions()
  const canEditRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.edit')
  const canDeleteRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.delete')
  const canConvertRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.convert')
  const canCreateEstimate = !permissionsLoading && hasPermission(userPermissions, 'estimates.create')
  const canCreateJob = !permissionsLoading && hasPermission(userPermissions, 'jobs.create')
  const canCreateTask = !permissionsLoading && hasPermission(userPermissions, 'tasks.create')
  const canCreateIssue = !permissionsLoading && hasPermission(userPermissions, 'issues.create')

  // Admin-only: field worker assignment
  const [currentUserRole, setCurrentUserRole] = useState<string>('')
  const [fieldWorkers, setFieldWorkers] = useState<AssignableUser[]>([])
  const [assigningWorker, setAssigningWorker] = useState(false)
  const [selectedFieldWorkerId, setSelectedFieldWorkerId] = useState<string>('')

  useEffect(() => {
    if (!requestId) {
      setError('Invalid request ID')
      setLoading(false)
      return
    }
    fetchRequest()
  }, [requestId])

  // Decode role from JWT
  useEffect(() => {
    const token = localStorage.getItem('accessToken')
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]))
        setCurrentUserRole(payload.role || '')
      } catch {
        // ignore
      }
    }
  }, [])

  // Fetch field workers for admin assignment (only when admin)
  useEffect(() => {
    if (currentUserRole !== 'ADMIN') return
    const token = localStorage.getItem('accessToken')
    if (!token) return
    fetch('/api/schedules/team', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        setFieldWorkers(data.teamMembers || [])
      })
      .catch(() => {})
  }, [currentUserRole])

  // Sync selected field worker with loaded request
  useEffect(() => {
    if (request?.assignedTo?.id) {
      setSelectedFieldWorkerId(request.assignedTo.id)
    }
  }, [request?.assignedTo?.id])

  useEffect(() => {
    if (!requestId) return
    const interval = window.setInterval(() => {
      fetchRequest(true)
    }, 8000)
    const onFocus = () => {
      fetchRequest(true)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  const fetchRequest = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/leads/${requestId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (response.status === 404) {
        setError('Request not found')
        setLoading(false)
        return
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to load request' }))
        setError(errorData.error || 'Failed to load request')
        setLoading(false)
        return
      }

      const data = await response.json()
      setRequest(data.lead)
      setError(null)
    } catch (error) {
      console.error('Failed to fetch request:', error)
      setError('Failed to load request. Please try again.')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  const handleAssignFieldWorker = async () => {
    if (!canEditRequest) {
      alert('You do not have permission to edit requests.')
      return
    }
    if (!request || !selectedFieldWorkerId) return
    setAssigningWorker(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const res = await fetch(`/api/leads/${requestId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ assignedToId: selectedFieldWorkerId }),
      })
      if (res.ok) {
        await fetchRequest(true)
        setSelectedFieldWorkerId('')
      } else {
        const data = await res.json().catch(() => ({}))
        alert(data.error || 'Failed to assign worker.')
      }
    } catch {
      alert('Failed to assign worker.')
    } finally {
      setAssigningWorker(false)
    }
  }

  const handleDelete = async () => {
    if (!canDeleteRequest) {
      alert('You do not have permission to delete requests.')
      return
    }
    if (!request) return
    
    if (!confirm(`Are you sure you want to delete the request for ${request.firstName} ${request.lastName}? This action cannot be undone.`)) {
      return
    }

    setDeleting(true)
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

      // Redirect to requests list after successful deletion
      router.push('/dashboard/requests')
    } catch (error) {
      console.error('Failed to delete request:', error)
      alert('Failed to delete request. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleUrgent = async () => {
    if (!canEditRequest) {
      alert('You do not have permission to edit requests.')
      return
    }
    if (!request) return
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }
    const nextUrgent = !request.isUrgent
    const previous = request
    setUrgentBusy(true)
    setRequest((prev) => (prev ? { ...prev, isUrgent: nextUrgent } : prev))
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
        setRequest(previous)
        alert(errorData.error || 'Failed to update urgent flag')
        return
      }
      const payload = await response.json().catch(() => ({}))
      if (payload?.lead) {
        setRequest(payload.lead)
      } else {
        await fetchRequest()
      }
    } catch {
      setRequest(previous)
      alert('Failed to update urgent flag. Please try again.')
    } finally {
      setUrgentBusy(false)
    }
  }

  const loadAssignableUsers = async () => {
    setUsersLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const response = await fetch('/api/measuring-requests/assignable-users', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to load users' }))
        alert(payload.error || 'Failed to load assignable users')
        return
      }
      const data = await response.json()
      setAssignableUsers(Array.isArray(data.users) ? data.users : [])
    } catch (error) {
      console.error('Failed to load assignable users:', error)
      alert('Failed to load assignable users')
    } finally {
      setUsersLoading(false)
    }
  }

  const handleOpenMeasuringDialog = async () => {
    if (!canEditRequest) {
      alert('You do not have permission to edit requests.')
      return
    }
    setMeasuringDialogOpen(true)
    setSelectedMeasuringUserId('')
    setMeasuringNotes('')
    setMeasuringSearch('')
    await loadAssignableUsers()
  }

  const handleSendMeasuringRequest = async () => {
    if (!selectedMeasuringUserId) {
      alert('Please select a user')
      return
    }
    setSendingMeasuringRequest(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const response = await fetch('/api/measuring-requests', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId,
          assignedUserId: selectedMeasuringUserId,
          notes: measuringNotes || undefined,
        }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to send measuring request' }))
        alert(payload.error || 'Failed to send measuring request')
        return
      }
      setMeasuringDialogOpen(false)
      alert('Measuring request sent')
    } catch (error) {
      console.error('Failed to send measuring request:', error)
      alert('Failed to send measuring request')
    } finally {
      setSendingMeasuringRequest(false)
    }
  }

  const filteredAssignableUsers = assignableUsers.filter((u) => {
    const query = measuringSearch.trim().toLowerCase()
    if (!query) return true
    const fullName = `${u.firstName} ${u.lastName}`.toLowerCase()
    return (
      fullName.includes(query) ||
      (u.email || '').toLowerCase().includes(query) ||
      (u.role || '').toLowerCase().includes(query)
    )
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading request...</p>
        </div>
      </div>
    )
  }

  if (error || !request) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
          <h2 className="mt-4 text-xl font-semibold text-gray-900">Request Not Found</h2>
          <p className="mt-2 text-gray-600">{error || 'The request you are looking for does not exist.'}</p>
          <div className="mt-6">
            <Button onClick={() => router.push('/dashboard/requests')}>
              Back to Requests
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const expectedValue = request.value && request.probability
    ? parseFloat(request.value) * (request.probability / 100)
    : null
  const parsedJobSite = parseAddressParts(request.jobSiteAddress)
  const jobSiteCity = request.jobSiteCity || parsedJobSite?.city || ''
  const jobSiteState = request.jobSiteState || parsedJobSite?.state || ''
  const jobSiteZipCode = request.jobSiteZipCode || parsedJobSite?.zipCode || ''

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center space-x-3">
            <EntityBackButton fallbackHref="/dashboard/requests" />
          </div>
          <div className="flex items-center space-x-3 mt-2">
            <h1 className="text-3xl font-bold text-gray-900">
              {request.firstName} {request.lastName}
            </h1>
            {request.isUrgent ? (
              <span className="px-3 py-1 text-sm rounded-full border border-red-300 bg-red-100 text-red-700 font-bold">
                URGENT
              </span>
            ) : null}
            <span className={`px-3 py-1 text-sm rounded-full ${statusColors[request.status] || 'bg-gray-100 text-gray-800'}`}>
              {statusLabels[request.status] ?? request.status.replace(/_/g, ' ')}
            </span>
            <JobTypeBadge jobType={request.jobType} />
            <span className={`px-3 py-1 text-sm rounded ${sourceColors[request.source] || 'bg-gray-100 text-gray-800'}`}>
              {request.source}
            </span>
          </div>
          {request.company && (
            <p className="text-gray-600 mt-1">{request.company}</p>
          )}
        </div>
        <div className="flex items-center space-x-2">
          {canEditRequest && (
            <Button variant="outline" onClick={() => router.push(`/dashboard/requests/${requestId}/edit`)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          )}
          {canEditRequest && (
            <Button variant="outline" onClick={handleOpenMeasuringDialog}>
              <Ruler className="mr-2 h-4 w-4" />
              Measuring Request
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleToggleUrgent}
            disabled={urgentBusy || !canEditRequest}
            className={request.isUrgent ? 'text-red-600 hover:text-red-700 hover:bg-red-50' : ''}
          >
            {urgentBusy ? 'Saving...' : request.isUrgent ? 'Unmark Urgent' : 'Mark Urgent'}
          </Button>
          {canDeleteRequest && (
            <Button
              variant="outline"
              onClick={handleDelete}
              disabled={deleting}
              title="Delete request"
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={measuringDialogOpen} onOpenChange={setMeasuringDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Measuring Request</DialogTitle>
            <DialogDescription>
              Select a user to assign this measuring request. They will receive it in the mobile app and get a notification.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Search user</label>
              <Input
                value={measuringSearch}
                onChange={(e) => setMeasuringSearch(e.target.value)}
                placeholder="Search by name or email…"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Assign to user *{' '}
                {usersLoading && <span className="text-gray-400 font-normal">(loading…)</span>}
                {!usersLoading && assignableUsers.length > 0 && (
                  <span className="text-gray-400 font-normal">({filteredAssignableUsers.length} shown)</span>
                )}
              </label>
              <Select value={selectedMeasuringUserId || undefined} onValueChange={setSelectedMeasuringUserId}>
                <SelectTrigger>
                  <SelectValue placeholder={usersLoading ? 'Loading users...' : 'Select a user'} />
                </SelectTrigger>
                <SelectContent>
                  {filteredAssignableUsers.length === 0 && (
                    <div className="py-3 px-2 text-sm text-gray-500 text-center">
                      {usersLoading ? 'Loading…' : measuringSearch ? 'No users match your search' : 'No users found'}
                    </div>
                  )}
                  {filteredAssignableUsers.map((u) => {
                    const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id
                    return (
                      <SelectItem key={u.id} value={u.id}>
                        {displayName}{u.email && (u.firstName || u.lastName) ? ` (${u.email})` : ''}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Notes (optional)</label>
              <Textarea
                value={measuringNotes}
                onChange={(e) => setMeasuringNotes(e.target.value)}
                placeholder="Add notes for the assignee..."
                rows={4}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMeasuringDialogOpen(false)} disabled={sendingMeasuringRequest}>
                Cancel
              </Button>
              <Button onClick={handleSendMeasuringRequest} disabled={sendingMeasuringRequest || usersLoading}>
                {sendingMeasuringRequest ? 'Sending...' : 'Send Request'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => {
                const clientId = request?.convertedToClientId || request?.client?.id || null
                router.push(
                  `/dashboard/estimates/new${buildCreateContextQuery({
                    clientId,
                    sourceType: 'request',
                    sourceId: requestId,
                    requestId,
                  })}`
                )
              }}
              disabled={!canConvertRequest || !canCreateEstimate}
            >
              <FileText className="mr-2 h-4 w-4" />
              New Estimate
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => {
                const clientId = request?.convertedToClientId || request?.client?.id || null
                router.push(
                  `/dashboard/jobs/new${buildCreateContextQuery({
                    clientId,
                    sourceType: 'request',
                    sourceId: requestId,
                    requestId,
                  })}`
                )
              }}
              disabled={!canConvertRequest || !canCreateJob}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Job
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => {
                const clientId = request?.convertedToClientId || request?.client?.id || null
                router.push(
                  `/dashboard/tasks/new${buildCreateContextQuery({
                    clientId,
                    sourceType: 'request',
                    sourceId: requestId,
                    requestId,
                  })}`
                )
              }}
              disabled={!canCreateTask}
            >
              <CheckSquare className="mr-2 h-4 w-4" />
              New Task
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => {
                const clientId = request?.convertedToClientId || request?.client?.id || null
                router.push(
                  `/dashboard/issues/new${buildCreateContextQuery({
                    clientId,
                    sourceType: 'request',
                    sourceId: requestId,
                    requestId,
                  })}`
                )
              }}
              disabled={!canCreateIssue}
            >
              <AlertCircle className="mr-2 h-4 w-4" />
              New Issue
            </Button>
            {request.phone && (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => (window.location.href = `tel:${request.phone}`)}
              >
                <Phone className="mr-2 h-4 w-4" />
                Call
              </Button>
            )}
            {request.email && (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => (window.location.href = `mailto:${request.email}`)}
              >
                <Mail className="mr-2 h-4 w-4" />
                Email
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Content */}
        <div className="md:col-span-2 space-y-6">
          {/* Contact Information */}
          <Card>
            <CardHeader>
              <CardTitle>Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                {request.email && (
                  <div className="flex items-center text-sm">
                    <Mail className="mr-2 h-4 w-4 text-gray-400" />
                    <a href={`mailto:${request.email}`} className="text-blue-600 hover:underline">
                      {request.email}
                    </a>
                  </div>
                )}
                {request.phone && (
                  <div className="flex items-center text-sm">
                    <Phone className="mr-2 h-4 w-4 text-gray-400" />
                    <a href={`tel:${request.phone}`} className="text-blue-600 hover:underline">
                      {request.phone}
                    </a>
                  </div>
                )}
                {request.company && (
                  <div className="flex items-center text-sm">
                    <Building2 className="mr-2 h-4 w-4 text-gray-400" />
                    {request.company}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {request.jobSiteAddress && (
            <Card>
              <CardHeader>
                <CardTitle>Job Site</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700">{request.jobSiteAddress}</p>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <div className="rounded border p-2">
                    <p className="text-xs text-gray-500">City</p>
                    <p className="text-sm font-medium">{jobSiteCity || '-'}</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="text-xs text-gray-500">State</p>
                    <p className="text-sm font-medium">{jobSiteState || '-'}</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="text-xs text-gray-500">Zip Code</p>
                    <p className="text-sm font-medium">{jobSiteZipCode || '-'}</p>
                  </div>
                </div>
                <iframe
                  title="Job Site Map"
                  className="mt-3 h-56 w-full rounded-md border"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  src={`https://maps.google.com/maps?q=${encodeURIComponent(request.jobSiteAddress)}&output=embed`}
                />
              </CardContent>
            </Card>
          )}

          {/* Financial Information */}
          {(request.value || request.probability) && (
            <Card>
              <CardHeader>
                <CardTitle>Financial Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {request.value && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">Estimated Value</span>
                    <span className="text-lg font-semibold">{formatCurrency(parseFloat(request.value))}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">Probability</span>
                  <span className="text-lg font-medium">{request.probability}%</span>
                </div>
                {expectedValue && (
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="text-sm font-medium text-gray-700">Expected Value</span>
                    <span className="text-xl font-bold text-green-600">{formatCurrency(expectedValue)}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Notes */}
          {request.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{request.notes}</p>
              </CardContent>
            </Card>
          )}

          {/* Estimates */}
          {request.estimates.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Estimates ({request._count.estimates})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {request.estimates.map((estimate) => (
                    <Link
                      key={estimate.id}
                      href={`/dashboard/estimates/${estimate.id}`}
                      className="block p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">{estimate.estimateNumber}</p>
                          <p className="text-xs text-gray-600">{estimate.title}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold">{formatCurrency(parseFloat(estimate.total))}</p>
                          <span className={`text-xs px-2 py-1 rounded ${statusColors[estimate.status] || 'bg-gray-100 text-gray-800'}`}>
                            {estimate.status}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Communication Timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Communication Timeline</CardTitle>
              <CardDescription>Recent calls, messages, and emails</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Recent Calls */}
                {request.calls.slice(0, 5).map((call) => (
                  <div key={call.id} className="flex items-start space-x-3 border-b pb-3 last:border-0">
                    <Phone className="h-5 w-5 text-blue-500 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {call.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} Call
                      </p>
                      <p className="text-xs text-gray-500">
                        {call.fromNumber} → {call.toNumber}
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatDate(call.startedAt)}{' \u2022 '}{call.duration ? `${Math.floor(call.duration / 60)}:${(call.duration % 60).toString().padStart(2, '0')}` : 'N/A'}
                      </p>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded ${
                      call.status === 'ANSWERED' ? 'bg-green-100 text-green-800' :
                      call.status === 'MISSED' ? 'bg-red-100 text-red-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {call.status}
                    </span>
                  </div>
                ))}

                {/* Recent SMS */}
                {request.smsMessages.slice(0, 5).map((sms) => (
                  <div key={sms.id} className="flex items-start space-x-3 border-b pb-3 last:border-0">
                    <MessageSquare className="h-5 w-5 text-green-500 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {sms.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} SMS
                      </p>
                      <p className="text-sm text-gray-600">{sms.body ? (sms.body.substring(0, 100) + (sms.body.length > 100 ? '...' : '')) : 'No content'}</p>
                      <p className="text-xs text-gray-400">
                        {sms.sentAt ? formatDate(sms.sentAt) : 'Pending'}
                      </p>
                    </div>
                  </div>
                ))}

                {/* Recent Emails */}
                {request.emails.slice(0, 5).map((email) => (
                  <div key={email.id} className="flex items-start space-x-3 border-b pb-3 last:border-0">
                    <Mail className="h-5 w-5 text-purple-500 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{email.subject}</p>
                      <p className="text-xs text-gray-500">
                        {email.direction === 'INBOUND' ? 'Received' : 'Sent'}
                      </p>
                      <p className="text-xs text-gray-400">
                        {email.sentAt ? formatDate(email.sentAt) : 'Draft'}
                      </p>
                    </div>
                  </div>
                ))}

                {request.calls.length === 0 && request.smsMessages.length === 0 && request.emails.length === 0 && (
                  <p className="text-center text-gray-500 py-8">No communication history</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Activity Timeline */}
          {request.activities.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Activity Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {request.activities.map((activity) => (
                    <div key={activity.id} className="flex items-start space-x-3 border-l-4 border-blue-500 pl-4">
                      <div className="flex-1">
                        <p className="text-sm text-gray-700">{activity.description}</p>
                        <p className="text-xs text-gray-400 mt-1">
                          {activity.user ? `${activity.user.firstName} ${activity.user.lastName}` : 'System'}{' \u2022 '}{formatDate(activity.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentAttachments entityType="request" entityId={requestId} />
            </CardContent>
          </Card>

          {/* Stats */}
          <Card>
            <CardHeader>
              <CardTitle>Statistics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-gray-500">Estimates</p>
                <p className="text-2xl font-bold">{request._count.estimates}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Tasks</p>
                <p className="text-2xl font-bold">{request._count.tasks}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Calls</p>
                <p className="text-2xl font-bold">{request._count.calls}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Messages</p>
                <p className="text-2xl font-bold">{request._count.smsMessages}</p>
              </div>
            </CardContent>
          </Card>

          {/* Assigned To — read-only for non-admins, editable for admins */}
          {currentUserRole === 'ADMIN' ? (
            <Card>
              <CardHeader>
                <CardTitle>Assign Field Worker</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {request.assignedTo && (
                  <div className="flex items-center space-x-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm">
                    <User className="h-4 w-4 text-blue-500 shrink-0" />
                    <span className="font-medium text-blue-800">
                      {request.assignedTo.firstName} {request.assignedTo.lastName}
                    </span>
                    {request.assignedTo.email && (
                      <span className="text-blue-600 text-xs">({request.assignedTo.email})</span>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <Select
                    value={selectedFieldWorkerId}
                    onValueChange={setSelectedFieldWorkerId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a team member..." />
                    </SelectTrigger>
                    <SelectContent>
                      {fieldWorkers.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.firstName} {u.lastName}
                          {u.role ? ` (${u.role})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    disabled={assigningWorker || !selectedFieldWorkerId || selectedFieldWorkerId === request.assignedTo?.id}
                    onClick={handleAssignFieldWorker}
                  >
                    {assigningWorker ? 'Saving...' : 'Save Assignment'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : request.assignedTo ? (
            <Card>
              <CardHeader>
                <CardTitle>Assigned To</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center space-x-3">
                  <User className="h-5 w-5 text-gray-400" />
                  <div>
                    <p className="text-sm font-medium">
                      {request.assignedTo.firstName} {request.assignedTo.lastName}
                    </p>
                    {request.assignedTo.email && (
                      <p className="text-xs text-gray-500">{request.assignedTo.email}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Converted Client */}
          {request.convertedToClientId && request.client && (
            <Card>
              <CardHeader>
                <CardTitle>Converted Client</CardTitle>
              </CardHeader>
              <CardContent>
                <Link
                  href={`/dashboard/clients/${request.convertedToClientId}`}
                  className="flex items-center text-sm text-blue-600 hover:underline"
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {request.client.name}
                </Link>
                {request.convertedAt && (
                  <p className="text-xs text-gray-500 mt-1">
                    Converted {formatDate(request.convertedAt)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Recent Tasks */}
          {request.tasks.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent Tasks</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {request.tasks.map((task) => (
                    <Link
                      key={task.id}
                      href={`/dashboard/tasks/${task.id}`}
                      className="block p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                    >
                      <p className="text-sm font-medium">{task.title}</p>
                      <p className="text-xs text-gray-500">{task.status}</p>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent Issues */}
          {request.issues.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent Issues</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {request.issues.map((issue) => (
                    <Link
                      key={issue.id}
                      href={`/dashboard/issues/${issue.id}`}
                      className="block p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                    >
                      <p className="text-sm font-medium">{issue.title}</p>
                      <p className="text-xs text-gray-500">{issue.status}</p>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
