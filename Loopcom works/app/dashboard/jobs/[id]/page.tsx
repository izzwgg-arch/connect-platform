'use client'
import { navigateWithReturn } from '@/lib/navigation/nav-stack'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { Briefcase, Calendar, DollarSign, Users, MapPin, FileText, CheckSquare, AlertCircle, Phone, MessageSquare, Mail, Edit, Plus, Building2, Trash2, Copy, Clock, Link2, ShoppingCart } from 'lucide-react'
import { JobThreadDialog } from '@/components/messages/JobThreadDialog'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import { DocumentAttachments } from '@/components/common/document-attachments'
import { buildCreateContextQuery } from '@/src/lib/create-context'
import { UnifiedDocumentsSection } from '@/components/documents/unified-documents-section'
import { EditableNotesList } from '@/components/notes/editable-notes-list'
import type { UnifiedDocumentRow } from '@/lib/documents/unified-documents'
import { authFetch, readResponseJson } from '@/lib/auth/client'
import { JobTypeBadge } from '@/components/jobs/JobTypeSelect'
import { JobStatusSelect } from '@/components/jobs/JobStatusSelect'
import { JobBillingStatusBadge } from '@/components/jobs/JobBillingStatusBadge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const JobSiteMap = dynamic(() => import('@/components/maps/JobSiteMap').then(mod => ({ default: mod.JobSiteMap })), {
  ssr: false,
  loading: () => <div className="p-4 bg-gray-50 rounded-lg text-center text-gray-600">Loading map...</div>
})

interface JobDetail {
  id: string
  jobNumber: string
  title: string
  description: string | null
  status: string
  billingStatus?: string | null
  jobType?: string
  priority: number
  scheduledStart: string | null
  scheduledEnd: string | null
  actualStart: string | null
  actualEnd: string | null
  estimateAmount: string | null
  actualAmount: string | null
  laborCost: string | null
  materialCost: string | null
  chargeByHour: boolean
  hourlyRateCents: number | null
  billableMinutesTotal: number
  billableHours: number
  billableAmountCents: number
  totalCost?: string | null
  totalInvoicedAmount?: string
  openInvoiceBalance?: string
  openInvoiceCount?: number
  clientOpenInvoiceBalance?: string
  client: {
    id: string
    name: string
    companyName: string | null
    contacts: Array<{
      id: string
      firstName: string
      lastName: string
      phone: string | null
      email: string | null
    }>
  }
  jobSite: {
    id: string
    street: string
    city: string
    state: string
    zipCode: string
    country: string
  } | null
  assignments: Array<{
    id: string
    role: string | null
    notes: string | null
    user: {
      id: string
      firstName: string
      lastName: string
      email: string
      phone: string | null
    }
  }>
  tasks: Array<{
    id: string
    title: string
    status: string
    priority: string
    dueDate: string | null
    assignee: {
      firstName: string
      lastName: string
    }
  }>
  issues: Array<{
    id: string
    title: string
    status: string
    priority: string
  }>
  invoices: Array<{
    id: string
    invoiceNumber: string
    total: string
    balance: string
    status: string
  }>
  estimates: Array<{
    id: string
    estimateNumber: string
    title: string
    status: string
    total: string
    createdAt: string
  }>
  notes: Array<{
    id: string
    content: string
    createdAt: string
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
  activeTimers: Array<{
    id: string
    startedAt: string | null
    createdAt: string
    worker: {
      id: string
      firstName: string
      lastName: string
      email: string
    }
  }>
  _count: {
    tasks: number
    issues: number
    invoices: number
    estimates: number
  }
}

interface TimeEntryRow {
  id: string
  workerId: string
  startedAt: string | null
  endedAt: string | null
  durationMinutes: number
  source: 'TIMER' | 'MANUAL'
  status: 'ACTIVE' | 'STOPPED'
  note: string | null
  editedReason: string | null
  createdAt: string
  updatedAt: string
  worker: {
    id: string
    firstName: string
    lastName: string
    email: string
  }
  updatedBy: {
    id: string
    firstName: string
    lastName: string
    email: string
  }
}

interface AssignableUser {
  id: string
  firstName: string
  lastName: string
  email: string | null
  status?: string | null
}

export default function JobDetailPage() {
  const params = useParams()
  const router = useRouter()
  const jobId = params.id as string
  const [job, setJob] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [availableCrew, setAvailableCrew] = useState<AssignableUser[]>([])
  const [selectedCrewId, setSelectedCrewId] = useState('')
  const [loadingCrew, setLoadingCrew] = useState(false)
  const [assigningCrew, setAssigningCrew] = useState(false)
  const [timeEntries, setTimeEntries] = useState<TimeEntryRow[]>([])
  const [loadingTimeEntries, setLoadingTimeEntries] = useState(false)
  const [billingSaving, setBillingSaving] = useState(false)
  const [chargeByHour, setChargeByHour] = useState(false)
  const [hourlyRate, setHourlyRate] = useState('')
  const [currentUserRole, setCurrentUserRole] = useState<string>('')
  const [documents, setDocuments] = useState<UnifiedDocumentRow[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [documentsError, setDocumentsError] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [unreadMessages, setUnreadMessages] = useState(0)
  const [unreadNotes, setUnreadNotes] = useState(0)
  const [linkInvoiceOpen, setLinkInvoiceOpen] = useState(false)
  const [unattachedInvoices, setUnattachedInvoices] = useState<
    Array<{ id: string; invoiceNumber: string; title: string; total: string; status: string }>
  >([])
  const [loadingUnattachedInvoices, setLoadingUnattachedInvoices] = useState(false)
  const [selectedLinkInvoiceId, setSelectedLinkInvoiceId] = useState('')
  const [linkingInvoice, setLinkingInvoice] = useState(false)
  const documentsRequestIdRef = useRef(0)

  useEffect(() => {
    documentsRequestIdRef.current += 1
    setDocuments([])
    setDocumentsError(null)
    fetchJob()
    fetchDocuments()
    fetchUnread()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-fetch when jobId changes
  }, [jobId])

  useEffect(() => {
    const token = localStorage.getItem('accessToken')
    if (!token) return
    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      setCurrentUserRole(String(payload?.role || ''))
    } catch {
      setCurrentUserRole('')
    }
  }, [])

  useEffect(() => {
    if (job) {
      loadAvailableCrew()
      setChargeByHour(Boolean(job.chargeByHour))
      setHourlyRate(job.hourlyRateCents ? (job.hourlyRateCents / 100).toFixed(2) : '')
      fetchTimeEntries()
    }
  }, [job])

  const fetchDocuments = async (retryCount = 0) => {
    const requestId = ++documentsRequestIdRef.current
    setDocumentsLoading(true)
    if (retryCount === 0) setDocumentsError(null)

    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await authFetch(`/api/jobs/${jobId}/documents`)
      if (requestId !== documentsRequestIdRef.current) return

      const data = await readResponseJson<{ documents?: UnifiedDocumentRow[]; error?: string }>(response)
      if (requestId !== documentsRequestIdRef.current) return

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/auth/login')
          return
        }
        throw new Error(data.error || `Failed to load documents (${response.status})`)
      }

      setDocuments(Array.isArray(data.documents) ? data.documents : [])
      setDocumentsError(null)
    } catch (error) {
      if (requestId !== documentsRequestIdRef.current) return

      const message = error instanceof Error && error.message ? error.message : 'Failed to load documents'
      const isHtmlOrInvalid =
        /web page instead of data|Invalid server response|Unexpected token/i.test(message)

      if (retryCount < 1 && isHtmlOrInvalid) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (requestId !== documentsRequestIdRef.current) return
        return fetchDocuments(retryCount + 1)
      }

      console.error('Failed to fetch job documents:', error)
      setDocumentsError(message === 'Failed to fetch' ? 'Failed to load documents' : message)
    } finally {
      if (requestId === documentsRequestIdRef.current) {
        setDocumentsLoading(false)
      }
    }
  }

  const fetchUnread = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return

      const notesKey = `job-notes-last-viewed-${jobId}`
      const notesSince = localStorage.getItem(notesKey) || new Date().toISOString()

      const response = await fetch(
        `/api/jobs/${jobId}/unread?notesSince=${encodeURIComponent(notesSince)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      // Mark notes as viewed as of now regardless of fetch outcome, so the
      // badge reflects only notes added since this page load next time.
      localStorage.setItem(notesKey, new Date().toISOString())
      if (!response.ok) return
      const data = await response.json()
      setUnreadMessages(Number(data.messages || 0))
      setUnreadNotes(Number(data.notes || 0))
    } catch (error) {
      console.error('Failed to fetch unread counts:', error)
    }
  }

  const fetchJob = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/jobs/${jobId}`, {
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
        console.error('Failed to fetch job:', error)
        setJob(null)
        setLoading(false)
        return
      }

      const data = await response.json()
      if (data.job) {
        setJob(data.job)
      } else {
        setJob(null)
      }
    } catch (error) {
      console.error('Failed to fetch job:', error)
      setJob(null)
    } finally {
      setLoading(false)
    }
  }

  const fetchTimeEntries = async () => {
    setLoadingTimeEntries(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const response = await fetch(`/api/jobs/${jobId}/time`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return
      const data = await response.json()
      setTimeEntries(Array.isArray(data.entries) ? data.entries : [])
    } catch (error) {
      console.error('Failed to fetch time entries:', error)
    } finally {
      setLoadingTimeEntries(false)
    }
  }

  const saveBillingSettings = async () => {
    if (!job) return
    setBillingSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const cents = hourlyRate.trim() ? Math.round(Number(hourlyRate) * 100) : null
      const response = await fetch(`/api/jobs/${job.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chargeByHour,
          hourlyRateCents: chargeByHour ? cents : null,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to save billing settings')
        return
      }
      await fetchJob()
      await fetchTimeEntries()
    } catch (error) {
      console.error('Failed to save billing settings:', error)
      alert('Failed to save billing settings')
    } finally {
      setBillingSaving(false)
    }
  }

  const addManualTime = async () => {
    if (!job) return
    const durationInput = window.prompt('Enter duration in minutes (or hh:mm):')
    if (!durationInput) return
    const note = window.prompt('Enter note for manual time entry:')
    if (!note || !note.trim()) {
      alert('Note is required for manual entries')
      return
    }
    const parts = durationInput.trim().split(':')
    const minutes =
      parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(durationInput.trim())
    if (!Number.isFinite(minutes) || minutes <= 0) {
      alert('Invalid duration')
      return
    }
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const response = await fetch(`/api/jobs/${job.id}/time/manual`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          durationMinutes: Math.round(minutes),
          note: note.trim(),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to add time entry')
        return
      }
      await fetchJob()
      await fetchTimeEntries()
    } catch (error) {
      console.error('Failed to add manual entry:', error)
      alert('Failed to add manual entry')
    }
  }

  const editTimeEntry = async (entry: TimeEntryRow) => {
    const durationInput = window.prompt('Edit duration in minutes:', String(entry.durationMinutes))
    if (!durationInput) return
    const editedReason = window.prompt('Reason for edit (required):')
    if (!editedReason || !editedReason.trim()) {
      alert('Edit reason is required')
      return
    }
    const minutes = Number(durationInput)
    if (!Number.isFinite(minutes) || minutes < 0) {
      alert('Invalid duration')
      return
    }
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const response = await fetch(`/api/time-entries/${entry.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          durationMinutes: Math.round(minutes),
          editedReason: editedReason.trim(),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to edit time entry')
        return
      }
      await fetchJob()
      await fetchTimeEntries()
    } catch (error) {
      console.error('Failed to edit time entry:', error)
      alert('Failed to edit time entry')
    }
  }

  const removeTimeEntry = async (entry: TimeEntryRow) => {
    const editedReason = window.prompt('Reason for deleting this entry (required):')
    if (!editedReason || !editedReason.trim()) {
      alert('Delete reason is required')
      return
    }
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const response = await fetch(`/api/time-entries/${entry.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          editedReason: editedReason.trim(),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to delete time entry')
        return
      }
      await fetchJob()
      await fetchTimeEntries()
    } catch (error) {
      console.error('Failed to delete time entry:', error)
      alert('Failed to delete time entry')
    }
  }

  const handleDelete = async () => {
    if (!job) return

    const confirmed = window.confirm(
      `Are you sure you want to delete job "${job.title}"?\n\n` +
      (job._count.invoices > 0
        ? 'This job has invoices and cannot be deleted. It will be cancelled instead.'
        : 'This action cannot be undone.')
    )

    if (!confirmed) return

    setDeleting(true)
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
        setDeleting(false)
        return
      }

      // Redirect to jobs list after successful deletion
      router.push('/dashboard/jobs')
    } catch (error) {
      console.error('Error deleting job:', error)
      alert('Failed to delete job')
      setDeleting(false)
    }
  }

  const loadAvailableCrew = async () => {
    if (!job) return
    setLoadingCrew(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch('/api/users?limit=200', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to load crew list' }))
        alert(error.error || 'Failed to load crew list')
        return
      }

      const data = await response.json()
      const assignedIds = new Set(job.assignments.map((a) => a.user.id))
      const users: AssignableUser[] = (Array.isArray(data.users) ? data.users : [])
        .map((u: any) => ({
          id: u.id,
          firstName: u.firstName || '',
          lastName: u.lastName || '',
          email: u.email || null,
          status: u.status || null,
        }))
        .filter((u: AssignableUser) => !assignedIds.has(u.id) && !['INACTIVE', 'SUSPENDED'].includes(String(u.status || '').toUpperCase()))

      setAvailableCrew(users)
      setSelectedCrewId('')
    } catch (error) {
      console.error('Failed to load crew:', error)
      alert('Failed to load crew list')
    } finally {
      setLoadingCrew(false)
    }
  }

  const handleAssignCrew = async () => {
    if (!selectedCrewId || !job) return
    setAssigningCrew(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/jobs/${job.id}/assignments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId: selectedCrewId }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to assign crew' }))
        alert(error.error || 'Failed to assign crew')
        return
      }

      setSelectedCrewId('')
      await fetchJob()
      await loadAvailableCrew()
    } catch (error) {
      console.error('Failed to assign crew:', error)
      alert('Failed to assign crew')
    } finally {
      setAssigningCrew(false)
    }
  }

  const appendJobNote = async () => {
    if (!job || !noteText.trim()) return
    setAddingNote(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/jobs/${jobId}/notes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: noteText.trim() }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to add note' }))
        alert(payload.error || 'Failed to add note')
        return
      }

      setNoteText('')
      await fetchJob()
    } catch (error) {
      console.error('Failed to add job note:', error)
      alert('Failed to add note. Please try again.')
    } finally {
      setAddingNote(false)
    }
  }

  const openLinkInvoiceDialog = async () => {
    if (!job?.client?.id) return
    setLinkInvoiceOpen(true)
    setSelectedLinkInvoiceId('')
    setLoadingUnattachedInvoices(true)
    try {
      const response = await authFetch(
        `/api/invoices?clientId=${encodeURIComponent(job.client.id)}&limit=100&status=all`
      )
      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      const payload = await readResponseJson<{
        invoices?: Array<{
          id: string
          invoiceNumber: string
          title: string
          total: string | number
          status: string
          job?: { id: string } | null
          jobId?: string | null
        }>
      }>(response)
      const rows = Array.isArray(payload?.invoices) ? payload.invoices : []
      setUnattachedInvoices(
        rows
          .filter((inv) => !inv.job?.id && !inv.jobId)
          .filter((inv) => inv.status !== 'CANCELLED' && inv.status !== 'REFUNDED')
          .map((inv) => ({
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            title: inv.title,
            total: String(inv.total ?? '0'),
            status: inv.status,
          }))
      )
    } catch (err) {
      console.error('Failed to load unattached invoices:', err)
      setUnattachedInvoices([])
      alert('Failed to load saved invoices')
    } finally {
      setLoadingUnattachedInvoices(false)
    }
  }

  const linkInvoiceToJob = async () => {
    if (!selectedLinkInvoiceId) {
      alert('Select an invoice to attach')
      return
    }
    setLinkingInvoice(true)
    try {
      const response = await authFetch(`/api/jobs/${jobId}/link-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: selectedLinkInvoiceId }),
      })
      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      const payload = await readResponseJson<{ error?: string }>(response)
      if (!response.ok) {
        alert(payload?.error || 'Failed to attach invoice')
        return
      }
      setLinkInvoiceOpen(false)
      setSelectedLinkInvoiceId('')
      await fetchJob()
      await fetchDocuments()
    } catch (err) {
      console.error('Failed to link invoice:', err)
      alert('Failed to attach invoice')
    } finally {
      setLinkingInvoice(false)
    }
  }

  const updateJobNote = async (noteId: string, content: string) => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }

    const response = await fetch(`/api/notes/${noteId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    })

    if (response.status === 401) {
      router.push('/auth/login')
      return
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'Failed to update note' }))
      alert(payload.error || 'Failed to update note')
      return
    }

    await fetchJob()
  }

  const deleteJobNote = async (noteId: string) => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }

    const response = await fetch(`/api/notes/${noteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 401) {
      router.push('/auth/login')
      return
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'Failed to delete note' }))
      alert(payload.error || 'Failed to delete note')
      return
    }

    await fetchJob()
  }

  const handleDuplicate = async () => {
    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/jobs/${jobId}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to duplicate job')
        return
      }

      if (data?.id) {
        router.push(`/dashboard/jobs/${data.id}`)
      } else {
        router.push('/dashboard/jobs')
      }
    } catch (error) {
      console.error('Duplicate job error:', error)
      alert('Failed to duplicate job')
    } finally {
      setDuplicating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading job...</p>
        </div>
      </div>
    )
  }

  if (!job) {
    return (
      <div className="text-center py-12">
        <div className="text-red-600 text-xl font-semibold mb-2">Job not found</div>
        <p className="text-gray-600 mb-4">The job you&apos;re looking for doesn&apos;t exist or you don&apos;t have permission to view it.</p>
        <Button variant="outline" onClick={() => router.push('/dashboard/jobs')}>
          Back to Jobs
        </Button>
      </div>
    )
  }

  const primaryContact = job.client.contacts?.[0] || null
  const profit = job.actualAmount && job.actualAmount && job.laborCost && job.materialCost
    ? parseFloat(job.actualAmount) - parseFloat(job.laborCost) - parseFloat(job.materialCost)
    : null
  const canManageTimeEntries = ['ADMIN', 'MANAGER'].includes(currentUserRole)
  const formatMinutes = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center space-x-3">
            <EntityBackButton fallbackHref="/dashboard/jobs" />
          </div>
          <div className="flex items-center space-x-3 mt-2">
            <h1 className="text-3xl font-bold text-gray-900">{job.title}</h1>
            <JobStatusSelect
              jobId={job.id}
              status={job.status}
              onUpdated={(next) => setJob((prev) => (prev ? { ...prev, status: next } : prev))}
            />
            <JobBillingStatusBadge status={job.billingStatus} />
            <JobTypeBadge jobType={job.jobType} />
          </div>
          <p className="text-gray-600 mt-1">
            {job.jobNumber} - <Link href={`/dashboard/clients/${job.client.id}`} className="text-primary hover:underline">{job.client.name}</Link>
          </p>
          <p className="text-sm font-semibold text-amber-700 mt-2">
            Job Open Invoices: {formatCurrency(parseFloat(job.openInvoiceBalance || '0'))} ({job.openInvoiceCount || 0})
            {' '}| Client Open Balance: {formatCurrency(parseFloat(job.clientOpenInvoiceBalance || '0'))}
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            onClick={() => {
              setChatOpen(true)
              setUnreadMessages(0)
            }}
            className="relative"
          >
            <MessageSquare className="mr-2 h-4 w-4" />
            Send Message
            {unreadMessages > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold bg-red-600 text-white flex items-center justify-center">
                {unreadMessages > 99 ? '99+' : unreadMessages}
              </span>
            )}
          </Button>
          <Button variant="outline" onClick={handleDuplicate} disabled={duplicating}>
            <Copy className="mr-2 h-4 w-4" />
            {duplicating ? 'Duplicating...' : 'Duplicate'}
          </Button>
          <Button variant="outline" onClick={() => router.push(`/dashboard/jobs/${jobId}/edit`)}>
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button 
            variant="outline" 
            onClick={handleDelete}
            disabled={deleting}
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() =>
                navigateWithReturn(
                  router,
                  `/dashboard/tasks/new${buildCreateContextQuery({
                    clientId: job.client.id,
                    sourceType: 'job',
                    sourceId: jobId,
                    jobId,
                    extra: {
                      jobNumber: job.jobNumber,
                      clientName: job.client.name,
                      projectType: job.title,
                    },
                  })}`
                )
              }
            >
              <CheckSquare className="mr-1.5 h-3.5 w-3.5" />
              New Task
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() =>
                navigateWithReturn(
                  router,
                  `/dashboard/issues/new${buildCreateContextQuery({
                    clientId: job.client.id,
                    sourceType: 'job',
                    sourceId: jobId,
                    jobId,
                    extra: {
                      jobNumber: job.jobNumber,
                      clientName: job.client.name,
                      projectType: job.title,
                    },
                  })}`
                )
              }
            >
              <AlertCircle className="mr-1.5 h-3.5 w-3.5" />
              New Issue
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() =>
                navigateWithReturn(
                  router,
                  `/dashboard/estimates/new${buildCreateContextQuery({
                    clientId: job.client.id,
                    sourceType: 'job',
                    sourceId: jobId,
                    jobId,
                  })}`
                )
              }
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              New Estimate
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() => navigateWithReturn(router, `/dashboard/invoices/new?jobId=${jobId}`)}
            >
              <DollarSign className="mr-1.5 h-3.5 w-3.5" />
              New Invoice
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() => navigateWithReturn(router, `/dashboard/purchase-orders/new?jobId=${jobId}`)}
            >
              <ShoppingCart className="mr-1.5 h-3.5 w-3.5" />
              New PO
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() => void openLinkInvoiceDialog()}
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              Link Invoice
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() => navigateWithReturn(router, `/dashboard/schedule/new?jobId=${jobId}`)}
            >
              <Calendar className="mr-1.5 h-3.5 w-3.5" />
              Schedule
            </Button>
          </div>
        </CardContent>
      </Card>

      <UnifiedDocumentsSection
        documents={documents}
        loading={documentsLoading}
        error={documentsError}
        description={`${job._count.estimates ?? 0} estimates, ${job._count.invoices ?? 0} invoices, purchase orders, and related payments`}
        receiptClientId={job.client?.id}
        onDocumentsRefresh={fetchDocuments}
        preferencesKey={`documents-job-${jobId}`}
      />

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Content */}
        <div className="md:col-span-2 space-y-6">
          {/* Job Information */}
          <Card>
            <CardHeader>
              <CardTitle>Job Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {job.description && (
                <div>
                  <p className="text-sm font-medium text-gray-500 mb-1">Description</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{job.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {job.scheduledStart && (
                  <div>
                    <p className="text-sm font-medium text-gray-500">Scheduled Start</p>
                    <p className="text-sm font-semibold mt-1">{formatDateTime(job.scheduledStart)}</p>
                  </div>
                )}
                {job.scheduledEnd && (
                  <div>
                    <p className="text-sm font-medium text-gray-500">Scheduled End</p>
                    <p className="text-sm font-semibold mt-1">{formatDateTime(job.scheduledEnd)}</p>
                  </div>
                )}
                {job.actualStart && (
                  <div>
                    <p className="text-sm font-medium text-gray-500">Actual Start</p>
                    <p className="text-sm font-semibold mt-1">{formatDateTime(job.actualStart)}</p>
                  </div>
                )}
                {job.actualEnd && (
                  <div>
                    <p className="text-sm font-medium text-gray-500">Actual End</p>
                    <p className="text-sm font-semibold mt-1">{formatDateTime(job.actualEnd)}</p>
                  </div>
                )}
              </div>

              {/* Financials */}
              {(job.estimateAmount || job.actualAmount) && (
                <div className="pt-4 border-t">
                  <p className="text-sm font-medium text-gray-500 mb-3">Financials</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-500">Total Cost</p>
                      <p className="text-lg font-semibold">
                        {job.totalCost ? formatCurrency(parseFloat(job.totalCost)) : '-'}
                      </p>
                    </div>
                    {job.estimateAmount && (
                      <div>
                        <p className="text-xs text-gray-500">Estimate</p>
                        <p className="text-lg font-semibold">{formatCurrency(parseFloat(job.estimateAmount))}</p>
                      </div>
                    )}
                    {job.actualAmount && (
                      <div>
                        <p className="text-xs text-gray-500">Actual</p>
                        <p className="text-lg font-semibold">{formatCurrency(parseFloat(job.actualAmount))}</p>
                      </div>
                    )}
                    {job.laborCost && (
                      <div>
                        <p className="text-xs text-gray-500">Labor Cost</p>
                        <p className="text-sm font-medium">{formatCurrency(parseFloat(job.laborCost))}</p>
                      </div>
                    )}
                    {job.materialCost && (
                      <div>
                        <p className="text-xs text-gray-500">Material Cost</p>
                        <p className="text-sm font-medium">{formatCurrency(parseFloat(job.materialCost))}</p>
                      </div>
                    )}
                    {profit !== null && (
                      <div>
                        <p className="text-xs text-gray-500">Profit</p>
                        <p className={`text-sm font-semibold ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {formatCurrency(profit)}
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-gray-500">Total Invoiced</p>
                      <p className="text-sm font-semibold">{formatCurrency(parseFloat(job.totalInvoicedAmount || '0'))}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Open Invoices</p>
                      <p className="text-sm font-semibold text-amber-700">
                        {formatCurrency(parseFloat(job.openInvoiceBalance || '0'))}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Billing
              </CardTitle>
              <CardDescription>Configure hourly billing and review tracked time</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Charge by hour</p>
                  <p className="text-xs text-gray-500">Toggle hourly tracking for this job.</p>
                </div>
                <input
                  type="checkbox"
                  checked={chargeByHour}
                  onChange={(e) => setChargeByHour(e.target.checked)}
                  disabled={!canManageTimeEntries}
                />
              </div>
              {chargeByHour && (
                <div>
                  <label className="text-sm font-medium">Hourly rate (USD)</label>
                  <input
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    type="number"
                    step="0.01"
                    min="0"
                    value={hourlyRate}
                    onChange={(e) => setHourlyRate(e.target.value)}
                    disabled={!canManageTimeEntries}
                  />
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 rounded border p-3">
                <div>
                  <p className="text-xs text-gray-500">Total tracked time</p>
                  <p className="text-sm font-semibold">{formatMinutes(job.billableMinutesTotal || 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Billable hours</p>
                  <p className="text-sm font-semibold">{Number(job.billableHours || 0).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Billable amount</p>
                  <p className="text-sm font-semibold">{formatCurrency((job.billableAmountCents || 0) / 100)}</p>
                </div>
              </div>
              {canManageTimeEntries && (
                <div className="flex gap-2">
                  <Button onClick={saveBillingSettings} disabled={billingSaving}>
                    {billingSaving ? 'Saving...' : 'Save Billing'}
                  </Button>
                  <Button variant="outline" onClick={addManualTime}>
                    Add Manual Time
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Time Entries</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingTimeEntries ? (
                <p className="text-sm text-gray-500">Loading time entries...</p>
              ) : timeEntries.length === 0 ? (
                <p className="text-sm text-gray-500">No time entries yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="py-2 pr-3">Date</th>
                        <th className="py-2 pr-3">Worker</th>
                        <th className="py-2 pr-3">Start</th>
                        <th className="py-2 pr-3">End</th>
                        <th className="py-2 pr-3">Duration</th>
                        <th className="py-2 pr-3">Source</th>
                        <th className="py-2 pr-3">Notes</th>
                        <th className="py-2 pr-3">Edited By</th>
                        <th className="py-2 pr-3">Edited At</th>
                        {canManageTimeEntries && <th className="py-2 pr-3">Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {timeEntries.map((entry) => (
                        <tr key={entry.id} className="border-b align-top">
                          <td className="py-2 pr-3">{formatDate(entry.createdAt)}</td>
                          <td className="py-2 pr-3">{entry.worker.firstName} {entry.worker.lastName}</td>
                          <td className="py-2 pr-3">{entry.startedAt ? formatDateTime(entry.startedAt) : '-'}</td>
                          <td className="py-2 pr-3">{entry.endedAt ? formatDateTime(entry.endedAt) : 'Active'}</td>
                          <td className="py-2 pr-3">{formatMinutes(entry.durationMinutes)}</td>
                          <td className="py-2 pr-3">{entry.source}</td>
                          <td className="py-2 pr-3">{entry.note || '-'}</td>
                          <td className="py-2 pr-3">
                            {entry.updatedBy ? `${entry.updatedBy.firstName} ${entry.updatedBy.lastName}` : '-'}
                          </td>
                          <td className="py-2 pr-3">{formatDateTime(entry.updatedAt)}</td>
                          {canManageTimeEntries && (
                            <td className="py-2 pr-3">
                              <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => editTimeEntry(entry)}>
                                  Edit
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => removeTimeEntry(entry)}>
                                  Delete
                                </Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {job.activeTimers?.length > 0 && (
                <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  Active timer: {job.activeTimers.map((t) => `${t.worker.firstName} ${t.worker.lastName}`).join(', ')}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Job Site */}
          {job.jobSite && (
            <>
              <Card className="relative z-0">
                <CardHeader>
                  <CardTitle>Job Site</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-start space-x-3">
                    <MapPin className="h-5 w-5 text-gray-400 mt-0.5" />
                    <div>
                      <p className="text-sm">
                        {job.jobSite.street}<br />
                        {job.jobSite.city}, {job.jobSite.state} {job.jobSite.zipCode}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Map View</CardTitle>
                </CardHeader>
                <CardContent>
                  <GoogleMapsLoader>
                    <JobSiteMap
                      address={{
                        street: job.jobSite.street,
                        city: job.jobSite.city,
                        state: job.jobSite.state,
                        zipCode: job.jobSite.zipCode,
                        country: job.jobSite.country || 'USA',
                      }}
                      jobTitle={job.title}
                    />
                  </GoogleMapsLoader>
                </CardContent>
              </Card>
            </>
          )}

          {/* Crew Assignments */}
          <Card className="relative z-20">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Crew Assignments</CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => loadAvailableCrew()}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Refresh Crew
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4 rounded-lg border p-3 space-y-3 bg-slate-50">
                <p className="text-sm font-medium text-slate-700">Assign crew member</p>
                <select
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={selectedCrewId}
                  onChange={(e) => setSelectedCrewId(e.target.value)}
                  disabled={loadingCrew || assigningCrew}
                >
                  <option value="">{loadingCrew ? 'Loading crew...' : 'Select crew member'}</option>
                  {availableCrew.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.firstName} {member.lastName}
                      {member.email ? ` (${member.email})` : ''}
                    </option>
                  ))}
                </select>
                {!loadingCrew && availableCrew.length === 0 && (
                  <p className="text-sm text-gray-500">No available crew members to assign.</p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={handleAssignCrew}
                    disabled={!selectedCrewId || assigningCrew || loadingCrew}
                  >
                    {assigningCrew ? 'Assigning...' : 'Assign Crew'}
                  </Button>
                </div>
              </div>
              {job.assignments.length === 0 ? (
                <p className="text-center text-gray-500 py-4">No crew assigned</p>
              ) : (
                <div className="space-y-3">
                  {job.assignments.map((assignment) => (
                    <div key={assignment.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex-1">
                        <p className="font-medium">
                          {assignment.user.firstName} {assignment.user.lastName}
                        </p>
                        {assignment.role && (
                          <p className="text-sm text-gray-500">{assignment.role}</p>
                        )}
                        {assignment.notes && (
                          <p className="text-xs text-gray-600 mt-1">{assignment.notes}</p>
                        )}
                      </div>
                      <div className="flex items-center space-x-2">
                        {assignment.user.phone && (
                          <Button variant="ghost" size="sm">
                            <Phone className="h-4 w-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm">
                          <Mail className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Notes
                {unreadNotes > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-bold">
                    {unreadNotes > 99 ? '99+' : unreadNotes} new
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Add a note..."
                  rows={3}
                />
                <div>
                  <Button
                    onClick={() => void appendJobNote()}
                    disabled={addingNote || !noteText.trim()}
                    size="sm"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {addingNote ? 'Saving...' : 'Add Note'}
                  </Button>
                </div>
                <EditableNotesList
                  notes={job.notes}
                  emptyMessage="No notes"
                  onUpdate={updateJobNote}
                  onDelete={deleteJobNote}
                  variant="border-left"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Client Info */}
          <Card>
            <CardHeader>
              <CardTitle>Client</CardTitle>
            </CardHeader>
            <CardContent>
              <Link href={`/dashboard/clients/${job.client.id}`} className="hover:text-primary">
                <p className="font-semibold">{job.client.name}</p>
                {job.client.companyName && (
                  <p className="text-sm text-gray-600">{job.client.companyName}</p>
                )}
              </Link>
              {primaryContact ? (
                <div className="mt-3 space-y-2">
                  {primaryContact.phone && (
                    <Button variant="outline" size="sm" className="w-full justify-start">
                      <Phone className="mr-2 h-4 w-4" />
                      {primaryContact.phone}
                    </Button>
                  )}
                  {primaryContact.email && (
                    <Button variant="outline" size="sm" className="w-full justify-start">
                      <Mail className="mr-2 h-4 w-4" />
                      Email
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500 mt-3">No contact information available</p>
              )}
            </CardContent>
          </Card>

          {/* Tasks & Issues */}
          <Card>
            <CardHeader>
              <CardTitle>Tasks & Issues</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs text-gray-500 mb-2">Tasks ({job._count.tasks})</p>
                {job.tasks.length === 0 ? (
                  <p className="text-sm text-gray-500">No tasks</p>
                ) : (
                  job.tasks.slice(0, 5).map((task) => (
                    <Link
                      key={task.id}
                      href={`/dashboard/tasks/${task.id}`}
                      className="block p-2 rounded border hover:bg-gray-50 transition-colors mb-2"
                    >
                      <div className="flex items-center justify-between">
                        <CheckSquare className="h-4 w-4 text-blue-500 shrink-0" />
                        <p className="flex-1 ml-2 text-sm">{task.title}</p>
                        <div className="text-right text-xs text-gray-500 shrink-0">
                          <div>{task.status}</div>
                          {task.createdAt && <div>{formatDate(task.createdAt)}</div>}
                        </div>
                      </div>
                    </Link>
                  ))
                )}
              </div>
              <div className="pt-3 border-t">
                <p className="text-xs text-gray-500 mb-2">Issues ({job._count.issues})</p>
                {job.issues.length === 0 ? (
                  <p className="text-sm text-gray-500">No issues</p>
                ) : (
                  job.issues.slice(0, 5).map((issue) => (
                    <Link
                      key={issue.id}
                      href={`/dashboard/issues/${issue.id}`}
                      className="block p-2 rounded border hover:bg-gray-50 transition-colors mb-2"
                    >
                      <div className="flex items-center justify-between">
                        <AlertCircle className="h-4 w-4 text-red-500" />
                        <p className="flex-1 ml-2 text-sm">{issue.title}</p>
                        <span className="text-xs text-gray-500">{issue.status}</span>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Schedule */}
          {job.schedules.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Schedule</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {job.schedules.map((schedule) => (
                    <div key={schedule.id} className="p-3 rounded-lg border">
                      <p className="text-sm font-medium">
                        {formatDate(schedule.startTime)}
                      </p>
                      <p className="text-xs text-gray-600">
                        {schedule.user.firstName} {schedule.user.lastName}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentAttachments entityType="job" entityId={jobId} />
            </CardContent>
          </Card>
        </div>
      </div>

      <JobThreadDialog
        open={chatOpen}
        onOpenChange={(next) => {
          setChatOpen(next)
          if (!next) setUnreadMessages(0)
        }}
        jobId={jobId}
        jobNumber={job.jobNumber}
      />

      <Dialog open={linkInvoiceOpen} onOpenChange={setLinkInvoiceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link saved invoice</DialogTitle>
            <DialogDescription>
              Attach an existing invoice for {job.client.name} that is not already on a job. Job cost updates automatically.
            </DialogDescription>
          </DialogHeader>
          {loadingUnattachedInvoices ? (
            <p className="text-sm text-gray-500">Loading invoices…</p>
          ) : unattachedInvoices.length === 0 ? (
            <p className="text-sm text-gray-500">No unattached invoices found for this client.</p>
          ) : (
            <Select value={selectedLinkInvoiceId || undefined} onValueChange={setSelectedLinkInvoiceId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an invoice" />
              </SelectTrigger>
              <SelectContent>
                {unattachedInvoices.map((inv) => (
                  <SelectItem key={inv.id} value={inv.id}>
                    {inv.invoiceNumber} — {inv.title} ({formatCurrency(parseFloat(inv.total) || 0)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkInvoiceOpen(false)} disabled={linkingInvoice}>
              Cancel
            </Button>
            <Button
              onClick={() => void linkInvoiceToJob()}
              disabled={linkingInvoice || loadingUnattachedInvoices || !selectedLinkInvoiceId}
            >
              {linkingInvoice ? 'Attaching…' : 'Attach to job'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
