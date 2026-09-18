'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'
import { navigateWithReturn } from '@/lib/navigation/nav-stack'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatCurrency, formatDate, formatPhoneNumber } from '@/lib/utils'
import { Phone, Mail, MapPin, Building2, Calendar, FileText, DollarSign, Briefcase, MessageSquare, AlertCircle, CheckSquare, UserPlus, Edit, Plus, Trash2, Download, Printer, X, ChevronDown, ChevronRight, ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { AddressMapSection } from './map-section'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import { authFetch, readResponseJson } from '@/lib/auth/client'
import { UnifiedDocumentsSection } from '@/components/documents/unified-documents-section'
import { EditableNotesList } from '@/components/notes/editable-notes-list'
import type { UnifiedDocumentRow } from '@/lib/documents/unified-documents'

function buildDocumentsFromClient(clientData: {
  invoices?: Array<{
    id: string
    invoiceNumber: string
    title?: string | null
    total: string | number
    balance: string | number
    status: string
    dueDate?: string | null
    createdAt?: string | null
  }>
  jobs?: Array<{
    id: string
    jobNumber: string
    title: string
    status: string
    scheduledStart?: string | null
    createdAt?: string | null
  }>
  estimates?: Array<{
    id: string
    estimateNumber: string
    title?: string | null
    status: string
    total: string | number | null
    createdAt: string
  }>
}): UnifiedDocumentRow[] {
  const rows: UnifiedDocumentRow[] = []

  for (const invoice of clientData.invoices || []) {
    const balance = Number(invoice.balance)
    const total = Number(invoice.total)
    rows.push({
      id: invoice.id,
      kind: 'invoice',
      number: invoice.invoiceNumber,
      title: invoice.title || null,
      status: invoice.status,
      amount: total,
      balance,
      isPaid: invoice.status === 'PAID' || invoice.status === 'CANCELLED' || invoice.status === 'REFUNDED' || balance <= 0,
      date: invoice.dueDate || invoice.createdAt || new Date().toISOString(),
      href: `/dashboard/invoices/${invoice.id}`,
      meta: balance > 0 ? `Balance ${balance.toFixed(2)}` : null,
    })
  }

  for (const estimate of clientData.estimates || []) {
    rows.push({
      id: estimate.id,
      kind: 'estimate',
      number: estimate.estimateNumber,
      title: estimate.title || null,
      status: estimate.status,
      amount: Number(estimate.total || 0),
      balance: null,
      isPaid: null,
      date: estimate.createdAt,
      href: `/dashboard/estimates/${estimate.id}`,
    })
  }

  for (const job of clientData.jobs || []) {
    rows.push({
      id: job.id,
      kind: 'job',
      number: job.jobNumber,
      title: job.title,
      status: job.status,
      amount: 0,
      balance: null,
      isPaid: null,
      date: job.scheduledStart || job.createdAt || new Date().toISOString(),
      href: `/dashboard/jobs/${job.id}`,
      meta: String(job.status || '').replace(/_/g, ' '),
    })
  }

  rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return rows
}

interface ClientDetail {
  id: string
  parentId?: string | null
  name: string
  companyName: string | null
  email: string | null
  phone: string | null
  website: string | null
  tags: string[]
  isActive: boolean
  contacts: Array<{
    id: string
    firstName: string
    lastName: string
    email: string | null
    phone: string | null
    mobile: string | null
    title: string | null
    isPrimary: boolean
  }>
  addresses: Array<{
    id: string
    type: string
    street: string
    city: string
    state: string
    zipCode: string
    country: string
  }>
  jobs: Array<{
    id: string
    jobNumber: string
    title: string
    status: string
    scheduledStart: string | null
  }>
  invoices: Array<{
    id: string
    invoiceNumber: string
    title?: string | null
    total: string
    balance: string
    status: string
    dueDate: string | null
  }>
  estimates: Array<{
    id: string
    estimateNumber: string
    title?: string | null
    status: string
    total: string | number | null
    createdAt: string
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
  notes: Array<{
    id: string
    content: string
    createdAt: string
  }>
  notesHistory?: Array<{
    id: string
    content: string
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
  _count: {
    jobs: number
    invoices: number
    estimates: number
    calls: number
    smsMessages: number
    emails: number
  }
  openInvoiceBalance?: string
  subClientsOpenInvoiceBalance?: string
  parent?: {
    id: string
    name: string
    email: string | null
    phone: string | null
  } | null
  subClients?: Array<{
    id: string
    name: string
    companyName: string | null
    email: string | null
    phone: string | null
    isActive: boolean
    createdAt: string
    openInvoiceBalance?: string
  }>
  subClientEstimates?: Array<{
    id: string
    estimateNumber: string
    title: string
    status: string
    total: string
    createdAt: string
    clientId: string | null
    client: {
      id: string
      name: string
    } | null
  }>
  subClientInvoices?: Array<{
    id: string
    invoiceNumber: string
    title: string
    status: string
    total: string
    balance: string
    dueDate: string | null
    createdAt: string
    clientId: string
    client: {
      id: string
      name: string
    } | null
  }>
}

function CollapsibleClientCard({
  title,
  description,
  count,
  open,
  onToggle,
  headerAction,
  scrollable = false,
  scrollMaxClass = 'max-h-72',
  children,
}: {
  title: string
  description?: string
  count?: number
  open: boolean
  onToggle: () => void
  headerAction?: ReactNode
  scrollable?: boolean
  scrollMaxClass?: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onToggle}
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
          >
            {open ? (
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            ) : (
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            )}
            <div className="min-w-0">
              <CardTitle className="text-base">
                {title}
                {count != null ? ` (${count})` : ''}
              </CardTitle>
              {description && <CardDescription className="mt-1">{description}</CardDescription>}
            </div>
          </button>
          {headerAction}
        </div>
      </CardHeader>
      {open && (
        <CardContent className={scrollable ? 'pt-0' : undefined}>
          {scrollable ? (
            <div className={`${scrollMaxClass} overflow-y-auto overscroll-contain pr-1`}>
              {children}
            </div>
          ) : (
            children
          )}
        </CardContent>
      )}
    </Card>
  )
}

function estimateStatusClass(status: string) {
  switch (status) {
    case 'ACCEPTED':
    case 'APPROVED':
      return 'bg-green-100 text-green-800'
    case 'SENT':
    case 'VIEWED':
      return 'bg-blue-100 text-blue-800'
    case 'DRAFT':
      return 'bg-gray-100 text-gray-700'
    case 'REJECTED':
    case 'DECLINED':
      return 'bg-red-100 text-red-800'
    case 'CONVERTED':
      return 'bg-purple-100 text-purple-800'
    case 'EXPIRED':
      return 'bg-orange-100 text-orange-800'
    default:
      return 'bg-gray-100 text-gray-800'
  }
}

function invoiceStatusClass(status: string) {
  switch (status) {
    case 'PAID':
      return 'bg-green-100 text-green-800'
    case 'OVERDUE':
      return 'bg-red-100 text-red-800'
    case 'SENT':
    case 'VIEWED':
      return 'bg-blue-100 text-blue-800'
    case 'DRAFT':
      return 'bg-gray-100 text-gray-700'
    case 'CANCELLED':
    case 'REFUNDED':
      return 'bg-orange-100 text-orange-800'
    default:
      return 'bg-gray-100 text-gray-800'
  }
}

export default function ClientDetailPage() {
  const params = useParams()
  const router = useRouter()
  const [client, setClient] = useState<ClientDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showStatement, setShowStatement] = useState(false)
  const [statementHtml, setStatementHtml] = useState<string | null>(null)
  const [statementLoading, setStatementLoading] = useState(false)
  const [showEmailDialog, setShowEmailDialog] = useState(false)
  const [emailTo, setEmailTo] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailResult, setEmailResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([])
  const [showBulkPayment, setShowBulkPayment] = useState(false)
  const [bulkPaymentAmounts, setBulkPaymentAmounts] = useState<Record<string, string>>({})
  const [subClientsOpen, setSubClientsOpen] = useState(true)
  const [subClientEstimatesOpen, setSubClientEstimatesOpen] = useState(false)
  const [subClientInvoicesOpen, setSubClientInvoicesOpen] = useState(false)
  const [bulkPaymentMethod, setBulkPaymentMethod] = useState<'CHECK' | 'QUICK_PAY' | 'OTHER'>('CHECK')
  const [bulkPaymentOtherLabel, setBulkPaymentOtherLabel] = useState('')
  const [bulkPaymentDate, setBulkPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [bulkPaymentReference, setBulkPaymentReference] = useState('')
  const [bulkPaymentSaving, setBulkPaymentSaving] = useState(false)
  const [bulkPaymentError, setBulkPaymentError] = useState('')
  const [documents, setDocuments] = useState<UnifiedDocumentRow[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [documentsError, setDocumentsError] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const { permissions: userPermissions, loading: permissionsLoading } = usePermissions()
  const documentsRequestIdRef = useRef(0)

  // Defensive: Validate params before using
  const clientId = params?.id as string | undefined

  const fetchDocuments = async (retryCount = 0) => {
    if (!clientId) return

    const requestId = ++documentsRequestIdRef.current
    setDocumentsLoading(true)
    if (retryCount === 0) setDocumentsError(null)

    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await authFetch(`/api/clients/${clientId}/documents`)
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
    } catch (err) {
      if (requestId !== documentsRequestIdRef.current) return

      const message = err instanceof Error && err.message ? err.message : 'Failed to load documents'
      const isHtmlOrInvalid =
        /web page instead of data|Invalid server response|Unexpected token/i.test(message)

      // One automatic retry — covers aborted/racy first attempts during page mount.
      if (retryCount < 1 && isHtmlOrInvalid) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (requestId !== documentsRequestIdRef.current) return
        return fetchDocuments(retryCount + 1)
      }

      console.error('Failed to load client documents:', err)
      setDocumentsError(message === 'Failed to fetch' ? 'Failed to load documents' : message)
    } finally {
      if (requestId === documentsRequestIdRef.current) {
        setDocumentsLoading(false)
      }
    }
  }

  useEffect(() => {
    // Validate clientId exists
    if (!clientId || typeof clientId !== 'string') {
      setError('Invalid client ID')
      setLoading(false)
      return
    }

    documentsRequestIdRef.current += 1
    setDocuments([])
    setDocumentsError(null)
    setSelectedInvoiceIds([])
    fetchClient()
    fetchDocuments()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-fetch when clientId changes
  }, [clientId])

  const fetchClient = async () => {
    if (!clientId) return

    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await authFetch(`/api/clients/${clientId}`)

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (response.status === 404) {
        setError('Client not found')
        setLoading(false)
        return
      }

      if (!response.ok) {
        const errorData = await readResponseJson<{ error?: string }>(response).catch(() => ({
          error: 'Failed to load client',
        }))
        setError(errorData.error || 'Failed to load client')
        setLoading(false)
        return
      }

      const data = await readResponseJson<{ client?: ClientDetail } & ClientDetail>(response)
      // API returns client wrapped in { client: ... }
      const clientData = data.client || data
      if (!clientData || !clientData.id) {
        console.error('Invalid client data:', data)
        setError('Client not found')
        setLoading(false)
        return
      }

      // Normalize client data - ensure all arrays exist
      const normalizedClient = {
        ...clientData,
        contacts: Array.isArray(clientData.contacts) ? clientData.contacts : [],
        addresses: Array.isArray(clientData.addresses) ? clientData.addresses : [],
        jobs: Array.isArray(clientData.jobs) ? clientData.jobs : [],
        invoices: Array.isArray(clientData.invoices) ? clientData.invoices : [],
        estimates: Array.isArray(clientData.estimates) ? clientData.estimates : [],
        calls: Array.isArray(clientData.calls) ? clientData.calls : [],
        smsMessages: Array.isArray(clientData.smsMessages) ? clientData.smsMessages : [],
        emails: Array.isArray(clientData.emails) ? clientData.emails : [],
        notes: Array.isArray(clientData.notesHistory)
          ? clientData.notesHistory
          : Array.isArray(clientData.notes_history)
            ? clientData.notes_history
            : [],
        tasks: Array.isArray(clientData.tasks) ? clientData.tasks : [],
        issues: Array.isArray(clientData.issues) ? clientData.issues : [],
        tags: Array.isArray(clientData.tags) ? clientData.tags : [],
        subClients: Array.isArray(clientData.subClients) ? clientData.subClients : [],
        subClientEstimates: Array.isArray(clientData.subClientEstimates) ? clientData.subClientEstimates : [],
        subClientInvoices: Array.isArray(clientData.subClientInvoices) ? clientData.subClientInvoices : [],
        _count: clientData._count || {
          jobs: 0,
          invoices: 0,
          estimates: 0,
          calls: 0,
          smsMessages: 0,
          emails: 0,
        },
      }
      setClient(normalizedClient)
      // If the dedicated documents request failed/raced, still show invoices/jobs/estimates
      // already returned with the client payload.
      setDocuments((prev) => {
        if (prev.length > 0) return prev
        const fallback = buildDocumentsFromClient(normalizedClient)
        if (fallback.length > 0) setDocumentsError(null)
        return fallback
      })
      setError(null)
      setLoading(false)
    } catch (error) {
      console.error('Failed to fetch client:', error)
      setError('Failed to load client. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const generateStatement = async () => {
    if (!clientId) return
    setStatementLoading(true)
    setShowStatement(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/clients/${clientId}/statement?format=html`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setStatementHtml('<p style="padding:20px;color:red">Failed to generate statement.</p>')
        return
      }
      const html = await res.text()
      setStatementHtml(html)
    } catch {
      setStatementHtml('<p style="padding:20px;color:red">Error generating statement.</p>')
    } finally {
      setStatementLoading(false)
    }
  }

  const downloadStatementPdf = () => {
    if (!clientId) return
    const token = localStorage.getItem('accessToken')
    const url = `/api/clients/${clientId}/statement?format=pdf&download=1`
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    // Pass token via header isn't possible for direct download links; open in new tab
    window.open(url + `&t=${encodeURIComponent(token || '')}`, '_blank')
  }

  const printStatement = () => {
    if (!statementHtml) return
    const win = window.open('', '_blank')
    if (win) {
      win.document.write(statementHtml)
      win.document.close()
      win.onload = () => win.print()
    }
  }

  const openEmailDialog = () => {
    // Pre-fill with the client's email on file
    setEmailTo(client?.email || '')
    setEmailResult(null)
    setShowEmailDialog(true)
  }

  const sendStatementEmail = async () => {
    if (!clientId || !emailTo.trim()) return
    setEmailSending(true)
    setEmailResult(null)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/clients/${clientId}/statement`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: emailTo.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setEmailResult({ ok: false, message: data.error || 'Failed to send email' })
      } else {
        setEmailResult({ ok: true, message: `Statement sent to ${data.sentTo}` })
        // Auto-close dialog after 2 seconds on success
        setTimeout(() => setShowEmailDialog(false), 2000)
      }
    } catch {
      setEmailResult({ ok: false, message: 'Network error — please try again' })
    } finally {
      setEmailSending(false)
    }
  }

  const handleDelete = async () => {
    if (!client) return

    if (!confirm(`Are you sure you want to delete the client "${client.name}"? This will mark the client as inactive. This action cannot be undone.`)) {
      return
    }

    setDeleting(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/clients/${clientId}`, {
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
        const errorData = await response.json().catch(() => ({ error: 'Failed to delete client' }))
        alert(errorData.error || 'Failed to delete client')
        return
      }

      // Redirect to clients list after successful deletion
      router.push('/dashboard/clients')
    } catch (error) {
      console.error('Failed to delete client:', error)
      alert('Failed to delete client. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  const toggleSelectedInvoice = (invoiceId: string, checked: boolean) => {
    setSelectedInvoiceIds((prev) =>
      checked ? (prev.includes(invoiceId) ? prev : [...prev, invoiceId]) : prev.filter((id) => id !== invoiceId)
    )
  }

  const openPaymentModal = () => {
    const payableInvoices = documents.filter(
      (doc) => doc.kind === 'invoice' && selectedInvoiceIds.includes(doc.id)
    )
    if (payableInvoices.length === 0) {
      alert('Select at least one invoice to apply a payment.')
      return
    }

    const defaults: Record<string, string> = {}
    payableInvoices.forEach((invoice) => {
      defaults[invoice.id] = Number(invoice.balance || 0).toFixed(2)
    })
    setBulkPaymentAmounts(defaults)
    setBulkPaymentMethod('CHECK')
    setBulkPaymentOtherLabel('')
    setBulkPaymentDate(new Date().toISOString().split('T')[0])
    setBulkPaymentReference('')
    setBulkPaymentError('')
    setShowBulkPayment(true)
  }

  const handleBulkPaymentSubmit = async () => {
    if (!bulkPaymentDate) {
      setBulkPaymentError('Payment date is required.')
      return
    }
    const parsedPaymentDate = new Date(bulkPaymentDate)
    if (Number.isNaN(parsedPaymentDate.getTime())) {
      setBulkPaymentError('Enter a valid payment date.')
      return
    }

    const items = documents
      .filter((doc) => doc.kind === 'invoice' && selectedInvoiceIds.includes(doc.id))
      .map((invoice) => ({
        invoiceId: invoice.id,
        amount: parseFloat(bulkPaymentAmounts[invoice.id] || '0'),
      }))
      .filter((item) => Number.isFinite(item.amount) && item.amount > 0)

    if (items.length === 0) {
      setBulkPaymentError('Enter at least one payment amount greater than zero.')
      return
    }

    setBulkPaymentSaving(true)
    setBulkPaymentError('')
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/invoices/bulk-manual-payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          items,
          method: bulkPaymentMethod,
          methodLabel: bulkPaymentMethod === 'OTHER' ? bulkPaymentOtherLabel.trim() : undefined,
          paidAt: bulkPaymentDate,
          reference: bulkPaymentReference.trim() || undefined,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setBulkPaymentError(data.error || 'Failed to apply payment.')
        return
      }

      setShowBulkPayment(false)
      setSelectedInvoiceIds([])
      await fetchClient()
      await fetchDocuments()
    } catch (error) {
      console.error('Bulk client payment error:', error)
      setBulkPaymentError('Failed to apply payment.')
    } finally {
      setBulkPaymentSaving(false)
    }
  }

  const appendClientNote = async () => {
    if (!client || !clientId || !noteText.trim()) return
    setAddingNote(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/clients/${clientId}/notes`, {
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
      await fetchClient()
    } catch (error) {
      console.error('Failed to add client note:', error)
      alert('Failed to add note. Please try again.')
    } finally {
      setAddingNote(false)
    }
  }

  const updateClientNote = async (noteId: string, content: string) => {
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

    await fetchClient()
  }

  const deleteClientNote = async (noteId: string) => {
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

    await fetchClient()
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading client...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error || !client) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
          <h2 className="mt-4 text-xl font-semibold text-gray-900">Client Not Found</h2>
          <p className="mt-2 text-gray-600">{error || 'The client you are looking for does not exist.'}</p>
          <div className="mt-6">
            <Button onClick={() => router.push('/dashboard/clients')}>
              Back to Clients
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Defensive: Ensure arrays exist before using (handle null/undefined)
  const primaryContact = (client.contacts && Array.isArray(client.contacts) && client.contacts.length > 0)
    ? (client.contacts.find((c) => c.isPrimary) || client.contacts[0])
    : null
  const addresses = (client.addresses && Array.isArray(client.addresses)) ? client.addresses : []
  const jobs = (client.jobs && Array.isArray(client.jobs)) ? client.jobs : []
  const invoices = (client.invoices && Array.isArray(client.invoices)) ? client.invoices : []
  const estimates = (client.estimates && Array.isArray(client.estimates)) ? client.estimates : []
  const calls = (client.calls && Array.isArray(client.calls)) ? client.calls : []
  const smsMessages = (client.smsMessages && Array.isArray(client.smsMessages)) ? client.smsMessages : []
  const emails = (client.emails && Array.isArray(client.emails)) ? client.emails : []
  const notes = Array.isArray(client.notes)
    ? client.notes
    : Array.isArray(client.notesHistory)
      ? client.notesHistory
      : []
  const tasks = (client.tasks && Array.isArray(client.tasks)) ? client.tasks : []
  const issues = (client.issues && Array.isArray(client.issues)) ? client.issues : []
  const subClients = (client.subClients && Array.isArray(client.subClients)) ? client.subClients : []
  const subClientEstimates = (client.subClientEstimates && Array.isArray(client.subClientEstimates))
    ? client.subClientEstimates
    : []
  const subClientInvoices = (client.subClientInvoices && Array.isArray(client.subClientInvoices))
    ? client.subClientInvoices
    : []
  const hasSubClients = subClients.length > 0
  const canCreateRequest = !permissionsLoading && hasPermission(userPermissions, 'leads.create')
  const canEditNotes = !permissionsLoading && hasPermission(userPermissions, 'clients.edit')
  const selectedInvoices = documents.filter(
    (doc) => doc.kind === 'invoice' && selectedInvoiceIds.includes(doc.id)
  )
  const bulkPaymentTotal = selectedInvoices.reduce((sum, invoice) => {
    const amount = parseFloat(bulkPaymentAmounts[invoice.id] || '0')
    return sum + (Number.isFinite(amount) ? amount : 0)
  }, 0)

  return (
    <>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center space-x-3">
            <EntityBackButton fallbackHref="/dashboard/clients" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mt-2">{client.name}</h1>
          {client.parent && (
            <p className="text-sm text-gray-500 mt-1">
              Sub-client of{' '}
              <Link href={`/dashboard/clients/${client.parent.id}`} className="text-primary hover:underline">
                {client.parent.name}
              </Link>
            </p>
          )}
          {client.companyName && (
            <p className="text-gray-600 mt-1">{client.companyName}</p>
          )}
          <p className="text-sm font-semibold text-amber-700 mt-2">
            Open Balance: {formatCurrency(parseFloat(client.openInvoiceBalance || '0'))}
          </p>
        </div>
        <div className="flex items-center space-x-2">
          {client.phone && (
            <Button variant="outline" onClick={() => window.location.href = `tel:${client.phone}`}>
              <Phone className="mr-2 h-4 w-4" />
              Call
            </Button>
          )}
          <Link href={`/dashboard/clients/${clientId}/edit`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </Link>
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Button variant="outline" onClick={() => navigateWithReturn(router, `/dashboard/jobs/new?clientId=${clientId}`)}>
              <Briefcase className="mr-2 h-4 w-4" />
              New Job
            </Button>
            <Button variant="outline" onClick={() => navigateWithReturn(router, `/dashboard/invoices/new?clientId=${clientId}`)}>
              <DollarSign className="mr-2 h-4 w-4" />
              New Invoice
            </Button>
            <Button variant="outline" onClick={() => navigateWithReturn(router, `/dashboard/estimates/new?clientId=${clientId}`)}>
              <FileText className="mr-2 h-4 w-4" />
              New Estimate
            </Button>
            <Button variant="outline" onClick={() => navigateWithReturn(router, `/dashboard/purchase-orders/new`)}>
              <ShoppingCart className="mr-2 h-4 w-4" />
              New PO
            </Button>
            {canCreateRequest && (
              <Button variant="outline" onClick={() => navigateWithReturn(router, `/dashboard/requests/new?clientId=${clientId}`)}>
                <UserPlus className="mr-2 h-4 w-4" />
                New Request
              </Button>
            )}
            <Button variant="outline" onClick={() => navigateWithReturn(router, `/dashboard/tasks/new?clientId=${clientId}`)}>
              <CheckSquare className="mr-2 h-4 w-4" />
              New Task
            </Button>
            <Button variant="outline" onClick={generateStatement} disabled={statementLoading}>
              <FileText className="mr-2 h-4 w-4" />
              {statementLoading ? 'Generating...' : 'Generate Statement'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <UnifiedDocumentsSection
        documents={documents}
        loading={documentsLoading}
        error={documentsError}
        description="All estimates, invoices, payments, purchase orders, requests, and jobs for this client"
        enableInvoiceSelection
        selectedInvoiceIds={selectedInvoiceIds}
        onToggleInvoice={toggleSelectedInvoice}
        onAddPayment={openPaymentModal}
        receiptClientId={clientId}
        onDocumentsRefresh={fetchDocuments}
        preferencesKey={clientId ? `documents-client-${clientId}` : undefined}
      />

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Content */}
        <div className="md:col-span-2 space-y-6">
          {/* Contact Information */}
          <Card>
            <CardHeader>
              <CardTitle>Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {primaryContact && (
                <div>
                  <p className="text-sm font-medium text-gray-500">Primary Contact</p>
                  <p className="mt-1 text-lg font-semibold">
                    {primaryContact.firstName} {primaryContact.lastName}
                  </p>
                  {primaryContact.title && (
                    <p className="text-sm text-gray-600">{primaryContact.title}</p>
                  )}
                </div>
              )}
              <div className="space-y-2">
                {client.email && (
                  <div className="flex items-center text-sm">
                    <Mail className="mr-2 h-4 w-4 text-gray-400" />
                    <a href={`mailto:${client.email}`} className="text-blue-600 hover:underline">
                      {client.email}
                    </a>
                  </div>
                )}
                {client.phone && (
                  <div className="flex items-center text-sm">
                    <Phone className="mr-2 h-4 w-4 text-gray-400" />
                    <a href={`tel:${client.phone}`} className="text-blue-600 hover:underline">
                      {formatPhoneNumber(client.phone)}
                    </a>
                  </div>
                )}
                {client.website && (
                  <div className="flex items-center text-sm">
                    <Building2 className="mr-2 h-4 w-4 text-gray-400" />
                    <a href={client.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                      {client.website}
                    </a>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {hasSubClients ? (
              <CollapsibleClientCard
                title="Sub-Clients"
                description="Child clients attached to this parent client"
                count={subClients.length}
                open={subClientsOpen}
                onToggle={() => setSubClientsOpen((prev) => !prev)}
                headerAction={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      router.push(`/dashboard/clients/new?parentId=${clientId}`)
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Sub-Client
                  </Button>
                }
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                    <span className="font-medium text-slate-700">Combined child open balance</span>
                    <span className="font-semibold text-amber-700">
                      {formatCurrency(parseFloat(client.subClientsOpenInvoiceBalance || '0'))}
                    </span>
                  </div>
                  {subClients.map((subClient) => (
                    <Link
                      key={subClient.id}
                      href={`/dashboard/clients/${subClient.id}`}
                      className="block rounded-md border p-3 hover:bg-gray-50"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{subClient.name}</p>
                          <div className="text-xs text-gray-600">
                            {subClient.companyName || 'No company'}
                            {subClient.email ? ` | ${subClient.email}` : ''}
                            {subClient.phone ? ` | ${formatPhoneNumber(subClient.phone)}` : ''}
                          </div>
                          <div className="mt-1 text-xs font-medium text-amber-700">
                            Open Balance: {formatCurrency(parseFloat(subClient.openInvoiceBalance || '0'))}
                          </div>
                        </div>
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          subClient.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                        }`}>
                          {subClient.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </CollapsibleClientCard>
          ) : (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Sub-Clients</CardTitle>
                    <CardDescription>Child clients attached to this parent client</CardDescription>
                  </div>
                  <Button variant="outline" onClick={() => router.push(`/dashboard/clients/new?parentId=${clientId}`)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Sub-Client
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500">No sub-clients yet.</p>
              </CardContent>
            </Card>
          )}

          {/* Addresses */}
          {addresses.length > 0 && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Addresses</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {addresses.map((address) => (
                      <div key={address.id} className="border-l-4 border-blue-500 pl-4">
                        <p className="text-sm font-medium text-gray-500 capitalize">{address.type}</p>
                        <p className="mt-1 text-sm">
                          {address.street}<br />
                          {address.city}, {address.state} {address.zipCode}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Map View</CardTitle>
                </CardHeader>
                <CardContent>
                  <AddressMapSection addresses={addresses} />
                </CardContent>
              </Card>
            </>
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
                {calls.slice(0, 5).map((call) => (
                  <div key={call.id} className="flex items-start space-x-3 border-b pb-3 last:border-0">
                    <Phone className="h-5 w-5 text-blue-500 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {call.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} Call
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatPhoneNumber(call.fromNumber)} {'->'} {formatPhoneNumber(call.toNumber)}
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatDate(call.startedAt)} | {call.duration ? `${Math.floor(call.duration / 60)}:${(call.duration % 60).toString().padStart(2, '0')}` : 'N/A'}
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
                {smsMessages.slice(0, 5).map((sms) => (
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
                {emails.slice(0, 5).map((email) => {
                  // Try to match an estimate number in the subject (e.g. "EST-030045" or "QB-EST-8714")
                  const estMatch = email.subject?.match(/(?:QB-)?EST-[\w\d]+/i)
                  const linkedEstimate = estMatch
                    ? estimates.find((e) => e.estimateNumber === estMatch[0])
                    : null
                  const emailContent = (
                    <>
                      <Mail className="h-5 w-5 text-purple-500 mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium">{email.subject}</p>
                        <p className="text-xs text-gray-500">
                          {email.direction === 'INBOUND' ? 'Received' : 'Sent'}
                        </p>
                        <p className="text-xs text-gray-400">
                          {email.sentAt ? formatDate(email.sentAt) : 'Draft'}
                        </p>
                      </div>
                    </>
                  )
                  return linkedEstimate ? (
                    <Link
                      key={email.id}
                      href={`/dashboard/estimates/${linkedEstimate.id}`}
                      className="flex items-start space-x-3 border-b pb-3 last:border-0 hover:bg-gray-50 rounded-md -mx-1 px-1 transition-colors"
                    >
                      {emailContent}
                    </Link>
                  ) : (
                    <div key={email.id} className="flex items-start space-x-3 border-b pb-3 last:border-0">
                      {emailContent}
                    </div>
                  )
                })}

                {calls.length === 0 && smsMessages.length === 0 && emails.length === 0 && (
                  <p className="text-center text-gray-500 py-8">No communication history</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
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
                    onClick={() => void appendClientNote()}
                    disabled={addingNote || !noteText.trim()}
                    size="sm"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {addingNote ? 'Saving...' : 'Add Note'}
                  </Button>
                </div>
                <EditableNotesList
                  notes={notes}
                  emptyMessage="No notes"
                  onUpdate={updateClientNote}
                  onDelete={deleteClientNote}
                  canEdit={canEditNotes}
                  variant="border-left"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Stats */}
          <Card>
            <CardHeader>
              <CardTitle>Statistics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-gray-500">Jobs</p>
                <p className="text-2xl font-bold">{client._count?.jobs || 0}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Invoices</p>
                <p className="text-2xl font-bold">{client._count?.invoices || 0}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Open Balance</p>
                <p className="text-2xl font-bold text-amber-700">
                  {formatCurrency(parseFloat(client.openInvoiceBalance || '0'))}
                </p>
              </div>
              {subClients.length > 0 && (
                <div>
                  <p className="text-sm text-gray-500">Total Sub-Client Balance</p>
                  <p className="text-2xl font-bold text-amber-600">
                    {formatCurrency(parseFloat(client.subClientsOpenInvoiceBalance || '0'))}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">Combined across {subClients.length} sub-client{subClients.length !== 1 ? 's' : ''}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-gray-500">Calls</p>
                <p className="text-2xl font-bold">{client._count?.calls || 0}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Messages</p>
                <p className="text-2xl font-bold">{client._count?.smsMessages || 0}</p>
              </div>
            </CardContent>
          </Card>

          {hasSubClients && (
            <>
              <CollapsibleClientCard
                title="Sub-Client Estimates"
                description="Estimates across all sub-clients"
                count={subClientEstimates.length}
                open={subClientEstimatesOpen}
                onToggle={() => setSubClientEstimatesOpen((prev) => !prev)}
                scrollable
                scrollMaxClass="max-h-72"
              >
                {subClientEstimates.length === 0 ? (
                  <p className="text-sm text-gray-500">No estimates on sub-clients yet.</p>
                ) : (
                  <div className="space-y-3">
                    {subClientEstimates.map((estimate) => (
                      <div
                        key={estimate.id}
                        className="rounded-lg border p-3 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Link
                              href={`/dashboard/estimates/${estimate.id}`}
                              className="text-sm font-medium text-primary hover:underline"
                            >
                              {estimate.estimateNumber}
                            </Link>
                            {estimate.title && (
                              <p className="text-xs text-gray-600 truncate">{estimate.title}</p>
                            )}
                            {estimate.client && (
                              <Link
                                href={`/dashboard/clients/${estimate.client.id}`}
                                className="mt-1 inline-block text-xs font-medium text-slate-700 hover:text-primary hover:underline"
                              >
                                Sub-client: {estimate.client.name}
                              </Link>
                            )}
                            <p className="text-xs text-gray-600 mt-1">
                              {formatCurrency(parseFloat(String(estimate.total)))}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">{formatDate(estimate.createdAt)}</p>
                          </div>
                          <span className={`shrink-0 px-2 py-1 text-xs rounded ${estimateStatusClass(estimate.status)}`}>
                            {estimate.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CollapsibleClientCard>

              <CollapsibleClientCard
                title="Sub-Client Invoices"
                description="Invoices across all sub-clients"
                count={subClientInvoices.length}
                open={subClientInvoicesOpen}
                onToggle={() => setSubClientInvoicesOpen((prev) => !prev)}
                scrollable
                scrollMaxClass="max-h-72"
              >
                {subClientInvoices.length === 0 ? (
                  <p className="text-sm text-gray-500">No invoices on sub-clients yet.</p>
                ) : (
                  <div className="space-y-3">
                    {subClientInvoices.map((invoice) => (
                      <div
                        key={invoice.id}
                        className="rounded-lg border p-3 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Link
                              href={`/dashboard/invoices/${invoice.id}`}
                              className="text-sm font-medium text-primary hover:underline"
                            >
                              {invoice.invoiceNumber}
                            </Link>
                            {invoice.title && (
                              <p className="text-xs text-gray-600 truncate">{invoice.title}</p>
                            )}
                            {invoice.client && (
                              <Link
                                href={`/dashboard/clients/${invoice.client.id}`}
                                className="mt-1 inline-block text-xs font-medium text-slate-700 hover:text-primary hover:underline"
                              >
                                Sub-client: {invoice.client.name}
                              </Link>
                            )}
                            <p className="text-xs text-gray-600 mt-1">
                              Total {formatCurrency(parseFloat(invoice.total))} • Balance {formatCurrency(parseFloat(invoice.balance))}
                            </p>
                            {invoice.dueDate && (
                              <p className="text-xs text-gray-500">Due {formatDate(invoice.dueDate)}</p>
                            )}
                          </div>
                          <span className={`shrink-0 px-2 py-1 text-xs rounded ${invoiceStatusClass(invoice.status)}`}>
                            {invoice.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CollapsibleClientCard>
            </>
          )}

          {/* Recent Jobs */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Jobs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {jobs.length === 0 ? (
                  <p className="text-sm text-gray-500">No jobs yet</p>
                ) : (
                  jobs.map((job) => (
                    <Link
                      key={job.id}
                      href={`/dashboard/jobs/${job.id}`}
                      className="block p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                    >
                      <p className="text-sm font-medium">{job.jobNumber}</p>
                      <p className="text-xs text-gray-600">{job.title}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {job.status} | {job.scheduledStart ? formatDate(job.scheduledStart) : 'Not scheduled'}
                      </p>
                    </Link>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {(tasks.length > 0 || issues.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Tasks & Issues</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {tasks.slice(0, 3).map((task) => (
                  <Link
                    key={task.id}
                    href={`/dashboard/tasks/${task.id}`}
                    className="block p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <CheckSquare className="h-4 w-4 text-blue-500" />
                      <p className="flex-1 ml-2 text-sm">{task.title}</p>
                      <span className="text-xs text-gray-500">{task.status}</span>
                    </div>
                  </Link>
                ))}
                {issues.slice(0, 3).map((issue) => (
                  <Link
                    key={issue.id}
                    href={`/dashboard/issues/${issue.id}`}
                    className="block p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <AlertCircle className="h-4 w-4 text-red-500" />
                      <p className="flex-1 ml-2 text-sm">{issue.title}</p>
                      <span className="text-xs text-gray-500">{issue.status}</span>
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>

    {showBulkPayment && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-2xl rounded-xl bg-white shadow-2xl">
          <div className="border-b p-4">
            <h2 className="text-lg font-semibold text-gray-900">Add Payment</h2>
            <p className="text-sm text-gray-600">Apply one manual payment entry across selected invoices.</p>
          </div>
          <div className="space-y-4 p-4">
            {bulkPaymentError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {bulkPaymentError}
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label>Payment Method</Label>
                <select
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                  value={bulkPaymentMethod}
                  onChange={(e) => setBulkPaymentMethod(e.target.value as 'CHECK' | 'QUICK_PAY' | 'OTHER')}
                >
                  <option value="CHECK">Check</option>
                  <option value="QUICK_PAY">Quick Pay</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              {bulkPaymentMethod === 'OTHER' && (
                <div>
                  <Label>Payment Label</Label>
                  <Input
                    value={bulkPaymentOtherLabel}
                    onChange={(e) => setBulkPaymentOtherLabel(e.target.value)}
                    placeholder="Cash, Zelle, Venmo..."
                  />
                </div>
              )}
              <div>
                <Label htmlFor="bulk-payment-date">Payment Date</Label>
                <Input
                  id="bulk-payment-date"
                  type="date"
                  className="mt-1"
                  value={bulkPaymentDate}
                  onChange={(e) => setBulkPaymentDate(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="bulk-payment-reference">Reference Number</Label>
                <Input
                  id="bulk-payment-reference"
                  className="mt-1"
                  value={bulkPaymentReference}
                  onChange={(e) => setBulkPaymentReference(e.target.value)}
                  placeholder="Check #, confirmation #..."
                />
              </div>
            </div>
            <div className="space-y-3 max-h-[50vh] overflow-auto pr-1">
              {selectedInvoices.map((invoice) => (
                <div key={invoice.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{invoice.number}</p>
                      <p className="text-xs text-gray-500">
                        Remaining {formatCurrency(invoice.balance || 0)}
                      </p>
                    </div>
                    <div className="w-36">
                      <Label>Amount</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={bulkPaymentAmounts[invoice.id] || ''}
                        onChange={(e) =>
                          setBulkPaymentAmounts((prev) => ({
                            ...prev,
                            [invoice.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t pt-3">
              <p className="text-sm text-gray-600">Total payment</p>
              <p className="text-lg font-semibold">{formatCurrency(bulkPaymentTotal)}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t p-4">
            <Button variant="outline" onClick={() => setShowBulkPayment(false)} disabled={bulkPaymentSaving}>
              Cancel
            </Button>
            <Button onClick={handleBulkPaymentSubmit} disabled={bulkPaymentSaving}>
              {bulkPaymentSaving ? 'Saving...' : 'Apply Payment'}
            </Button>
          </div>
        </div>
      </div>
    )}

    {/* Statement Modal */}
    {showStatement && (

      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 overflow-auto p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl">
          <div className="flex items-center justify-between p-4 border-b">
            <h2 className="text-lg font-semibold text-gray-900">Account Statement</h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={printStatement}
                disabled={!statementHtml}
              >
                <Printer className="h-4 w-4 mr-1" />
                Print
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const token = localStorage.getItem('accessToken') || ''
                  window.open(
                    `/api/clients/${clientId}/statement?format=pdf&download=1&t=${encodeURIComponent(token)}`,
                    '_blank'
                  )
                }}
              >
                <Download className="h-4 w-4 mr-1" />
                Download PDF
              </Button>
              <Button
                size="sm"
                className="bg-[#1e4d6e] hover:bg-[#163a54] text-white"
                onClick={openEmailDialog}
                disabled={!statementHtml}
              >
                <Mail className="h-4 w-4 mr-1" />
                Email Statement
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setShowStatement(false); setStatementHtml(null) }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="p-4">
            {statementLoading ? (
              <div className="flex items-center justify-center py-16">
                <div className="text-gray-500">Generating statement...</div>
              </div>
            ) : statementHtml ? (
              <iframe
                srcDoc={statementHtml}
                className="w-full rounded border"
                style={{ height: '70vh' }}
                title="Account Statement"
              />
            ) : null}
          </div>
        </div>
      </div>
    )}
    {/* Email Statement Dialog */}
    {showEmailDialog && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
          <div className="flex items-center justify-between p-5 border-b">
            <div>
              <h3 className="text-base font-semibold text-gray-900">Email Account Statement</h3>
              <p className="text-xs text-gray-500 mt-0.5">The statement PDF will be attached to the email.</p>
            </div>
            <button
              type="button"
              onClick={() => { setShowEmailDialog(false); setEmailResult(null) }}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Send To
              </label>
              <input
                type="email"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="client@example.com"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1e4d6e] focus:border-transparent"
                onKeyDown={(e) => { if (e.key === 'Enter') sendStatementEmail() }}
                autoFocus
              />
              {client?.email && emailTo !== client.email && (
                <button
                  type="button"
                  className="mt-1 text-xs text-blue-600 hover:underline"
                  onClick={() => setEmailTo(client.email || '')}
                >
                  Use {client.email}
                </button>
              )}
            </div>

            {emailResult && (
              <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
                emailResult.ok
                  ? 'bg-green-50 text-green-800 border border-green-200'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}>
                {emailResult.message}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 p-5 pt-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setShowEmailDialog(false); setEmailResult(null) }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-[#1e4d6e] hover:bg-[#163a54] text-white"
              onClick={sendStatementEmail}
              disabled={emailSending || !emailTo.trim()}
            >
              <Mail className="h-4 w-4 mr-1" />
              {emailSending ? 'Sending...' : 'Send Statement'}
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
