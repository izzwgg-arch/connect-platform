'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency, formatDate } from '@/lib/utils'
import { DollarSign, FileText, Search, ChevronDown, ChevronRight, Download, Mail, X, ArrowDown, ArrowUp } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { ContactRecipientPicker } from '@/components/email/contact-recipient-picker'
import type { UnifiedDocumentKind, UnifiedDocumentRow } from '@/lib/documents/unified-documents'
import { smartMatch, scoreHaystack } from '@/lib/search/scoring'
import {
  ACTIVE_JOB_STATUSES,
  JOB_STATUSES,
  formatJobStatus,
  jobStatusColors,
} from '@/lib/jobs/statuses'
import { ColumnResizeHandle, useResizableColumns } from '@/hooks/useResizableColumns'

type TypeFilter = 'all' | UnifiedDocumentKind
type InvoiceFilter = 'all' | 'paid' | 'unpaid'
type EstimateFilter = 'all' | 'open' | 'converted'
type RequestFilter =
  | 'all'
  | 'open'
  | 'NEW'
  | 'CONTACTED'
  | 'QUALIFIED'
  | 'ESTIMATE_CREATED'
  | 'ESTIMATE_SENT'
  | 'FOLLOW_UP'
  | 'CONVERTED'
  | 'LOST'
type JobFilter = 'all' | 'active' | 'completed' | 'cancelled' | (typeof JOB_STATUSES)[number]['value']
type SortOption = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'status-asc' | 'status-desc'

type DocumentPreferences = {
  sort: SortOption
  typeFilter: TypeFilter
  invoiceFilter: InvoiceFilter
  estimateFilter: EstimateFilter
  requestFilter: RequestFilter
  jobFilter: JobFilter
  search: string
}

const REQUEST_STATUS_OPTIONS: Array<{ value: RequestFilter; label: string }> = [
  { value: 'all', label: 'All requests' },
  { value: 'open', label: 'Open' },
  { value: 'NEW', label: 'New' },
  { value: 'CONTACTED', label: 'Contacted' },
  { value: 'QUALIFIED', label: 'Qualified' },
  { value: 'ESTIMATE_CREATED', label: 'Estimate created' },
  { value: 'ESTIMATE_SENT', label: 'Estimate sent' },
  { value: 'FOLLOW_UP', label: 'Follow up' },
  { value: 'CONVERTED', label: 'Converted' },
  { value: 'LOST', label: 'Lost' },
]

function formatDocumentStatus(kind: UnifiedDocumentKind, status: string) {
  if (kind === 'job') return formatJobStatus(status)
  return status.replaceAll('_', ' ')
}

function readDocumentPreferences(key?: string): Partial<DocumentPreferences> | null {
  if (!key || typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Partial<DocumentPreferences>) : null
  } catch {
    return null
  }
}

function writeDocumentPreferences(key: string | undefined, prefs: DocumentPreferences) {
  if (!key || typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(prefs))
  } catch {
    // ignore storage failures
  }
}

function compareDocuments(a: UnifiedDocumentRow, b: UnifiedDocumentRow, sort: SortOption) {
  let primary = 0
  switch (sort) {
    case 'date-asc':
      primary = new Date(a.date).getTime() - new Date(b.date).getTime()
      break
    case 'amount-desc':
      primary = b.amount - a.amount
      break
    case 'amount-asc':
      primary = a.amount - b.amount
      break
    case 'status-asc':
      primary = formatDocumentStatus(a.kind, a.status).localeCompare(
        formatDocumentStatus(b.kind, b.status)
      )
      break
    case 'status-desc':
      primary = formatDocumentStatus(b.kind, b.status).localeCompare(
        formatDocumentStatus(a.kind, a.status)
      )
      break
    default:
      primary = new Date(b.date).getTime() - new Date(a.date).getTime()
  }
  if (primary !== 0) return primary

  const kindOrder: Record<UnifiedDocumentKind, number> = {
    job: 0,
    request: 1,
    estimate: 2,
    invoice: 3,
    credit_memo: 4,
    payment: 5,
    purchase_order: 6,
  }
  const kindDiff = kindOrder[a.kind] - kindOrder[b.kind]
  if (kindDiff !== 0) return kindDiff

  const numberDiff = a.number.localeCompare(b.number)
  if (numberDiff !== 0) return numberDiff

  return a.id.localeCompare(b.id)
}

function matchesEstimateFilter(status: string, filter: EstimateFilter) {
  if (filter === 'all') return true
  if (filter === 'converted') return status === 'CONVERTED'
  return !['CONVERTED', 'REJECTED', 'EXPIRED'].includes(status)
}

function matchesRequestFilter(status: string, filter: RequestFilter) {
  if (filter === 'all') return true
  if (filter === 'open') return !['CONVERTED', 'LOST'].includes(status)
  return status === filter
}

function matchesJobFilter(status: string, filter: JobFilter) {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_JOB_STATUSES.includes(status as (typeof ACTIVE_JOB_STATUSES)[number])
  if (filter === 'completed') return status === 'COMPLETED' || status === 'INVOICED'
  if (filter === 'cancelled') return status === 'CANCELLED'
  return status === filter
}

const kindLabels: Record<UnifiedDocumentKind, string> = {
  estimate: 'Estimate',
  invoice: 'Invoice',
  credit_memo: 'Credit Memo',
  payment: 'Payment',
  purchase_order: 'Purchase Order',
  request: 'Request',
  job: 'Job',
}

const kindBadgeClass: Record<UnifiedDocumentKind, string> = {
  estimate: 'bg-indigo-100 text-indigo-800',
  invoice: 'bg-slate-100 text-slate-800',
  credit_memo: 'bg-teal-100 text-teal-900',
  payment: 'bg-emerald-100 text-emerald-800',
  purchase_order: 'bg-amber-100 text-amber-900',
  request: 'bg-violet-100 text-violet-800',
  job: 'bg-sky-100 text-sky-800',
}

function statusClass(kind: UnifiedDocumentKind, status: string) {
  if (kind === 'job') {
    return jobStatusColors[status] || 'bg-gray-100 text-gray-800'
  }
  if (kind === 'estimate') {
    if (status === 'ACCEPTED' || status === 'CONVERTED') return 'bg-green-100 text-green-800'
    if (status === 'SENT') return 'bg-blue-100 text-blue-800'
    if (status === 'REJECTED') return 'bg-red-100 text-red-800'
    return 'bg-gray-100 text-gray-700'
  }
  if (kind === 'invoice') {
    if (status === 'PAID') return 'bg-green-100 text-green-800'
    if (status === 'OVERDUE') return 'bg-red-100 text-red-800'
    if (status === 'PARTIAL') return 'bg-amber-100 text-amber-800'
    return 'bg-gray-100 text-gray-800'
  }
  if (kind === 'credit_memo') {
    if (status === 'APPLIED') return 'bg-green-100 text-green-800'
    if (status === 'PARTIALLY_APPLIED') return 'bg-amber-100 text-amber-800'
    if (status === 'SENT') return 'bg-blue-100 text-blue-800'
    if (status === 'VOID') return 'bg-red-100 text-red-800'
    return 'bg-gray-100 text-gray-800'
  }
  if (kind === 'purchase_order') {
    if (status === 'RECEIVED') return 'bg-green-100 text-green-800'
    if (status === 'ORDERED' || status === 'APPROVED') return 'bg-blue-100 text-blue-800'
    if (status === 'CANCELLED') return 'bg-red-100 text-red-800'
    return 'bg-gray-100 text-gray-800'
  }
  if (kind === 'request') {
    if (status === 'CONVERTED') return 'bg-green-100 text-green-800'
    if (status === 'QUALIFIED' || status === 'CONTACTED' || status === 'FOLLOW_UP') return 'bg-blue-100 text-blue-800'
    if (status === 'ESTIMATE_CREATED' || status === 'ESTIMATE_SENT') return 'bg-indigo-100 text-indigo-800'
    if (status === 'LOST') return 'bg-red-100 text-red-800'
    return 'bg-gray-100 text-gray-800'
  }
  if (status === 'COMPLETED') return 'bg-green-100 text-green-800'
  if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') return 'bg-orange-100 text-orange-800'
  return 'bg-gray-100 text-gray-800'
}

interface UnifiedDocumentsSectionProps {
  documents: UnifiedDocumentRow[]
  loading?: boolean
  error?: string | null
  description?: string
  enableInvoiceSelection?: boolean
  selectedInvoiceIds?: string[]
  onToggleInvoice?: (invoiceId: string, checked: boolean) => void
  onAddPayment?: () => void
  defaultOpen?: boolean
  /** Fallback client for payment receipt recipient picker when a row has no clientId. */
  receiptClientId?: string | null
  onDocumentsRefresh?: () => void | Promise<void>
  preferencesKey?: string
}

export function UnifiedDocumentsSection({
  documents,
  loading = false,
  error = null,
  description = 'Estimates, invoices, credit memos, payments, purchase orders, requests, and jobs',
  enableInvoiceSelection = false,
  selectedInvoiceIds = [],
  onToggleInvoice,
  onAddPayment,
  defaultOpen = true,
  receiptClientId = null,
  onDocumentsRefresh,
  preferencesKey,
}: UnifiedDocumentsSectionProps) {
  const storedPrefs = readDocumentPreferences(preferencesKey)
  const [search, setSearch] = useState(storedPrefs?.search ?? '')
  const [open, setOpen] = useState(defaultOpen)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(storedPrefs?.typeFilter ?? 'all')
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>(storedPrefs?.invoiceFilter ?? 'all')
  const [estimateFilter, setEstimateFilter] = useState<EstimateFilter>(storedPrefs?.estimateFilter ?? 'all')
  const [requestFilter, setRequestFilter] = useState<RequestFilter>(storedPrefs?.requestFilter ?? 'all')
  const [jobFilter, setJobFilter] = useState<JobFilter>(storedPrefs?.jobFilter ?? 'all')
  const [sort, setSort] = useState<SortOption>(storedPrefs?.sort ?? 'date-desc')
  const { widths: colWidths, onResizeStart } = useResizableColumns(
    preferencesKey ? `docs-${preferencesKey}` : 'unified-documents',
    { type: 96, number: 140, title: 220, date: 120, amount: 110, status: 120, actions: 140 }
  )
  const toggleColumnSort = (column: 'date' | 'amount' | 'status') => {
    if (column === 'date') {
      setSort((prev) => (prev === 'date-desc' ? 'date-asc' : 'date-desc'))
      return
    }
    if (column === 'amount') {
      setSort((prev) => (prev === 'amount-desc' ? 'amount-asc' : 'amount-desc'))
      return
    }
    setSort((prev) => (prev === 'status-asc' ? 'status-desc' : 'status-asc'))
  }
  const sortIcon = (column: 'date' | 'amount' | 'status') => {
    const active =
      (column === 'date' && (sort === 'date-asc' || sort === 'date-desc')) ||
      (column === 'amount' && (sort === 'amount-asc' || sort === 'amount-desc')) ||
      (column === 'status' && (sort === 'status-asc' || sort === 'status-desc'))
    if (!active) return null
    const desc = sort.endsWith('desc')
    return desc ? <ArrowDown className="inline h-3 w-3 ml-0.5" /> : <ArrowUp className="inline h-3 w-3 ml-0.5" />
  }
  const [downloadingReceiptId, setDownloadingReceiptId] = useState<string | null>(null)
  const [showReceiptEmailDialog, setShowReceiptEmailDialog] = useState(false)
  const [receiptEmailPayment, setReceiptEmailPayment] = useState<UnifiedDocumentRow | null>(null)
  const [selectedRecipientEmails, setSelectedRecipientEmails] = useState<string[]>([])
  const [customEmails, setCustomEmails] = useState('')
  const [receiptEmailSending, setReceiptEmailSending] = useState(false)
  const [receiptEmailResult, setReceiptEmailResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    writeDocumentPreferences(preferencesKey, {
      sort,
      typeFilter,
      invoiceFilter,
      estimateFilter,
      requestFilter,
      jobFilter,
      search,
    })
  }, [preferencesKey, sort, typeFilter, invoiceFilter, estimateFilter, requestFilter, jobFilter, search])

  const filtered = useMemo(() => {
    const query = search.trim()

    let rows = documents.filter((row) => {
      if (typeFilter !== 'all' && row.kind !== typeFilter) return false
      if (row.kind === 'invoice' && typeFilter === 'invoice') {
        if (invoiceFilter === 'paid' && !row.isPaid) return false
        if (invoiceFilter === 'unpaid' && row.isPaid) return false
      }
      if (row.kind === 'estimate' && typeFilter === 'estimate') {
        if (!matchesEstimateFilter(row.status, estimateFilter)) return false
      }
      if (row.kind === 'request' && typeFilter === 'request') {
        if (!matchesRequestFilter(row.status, requestFilter)) return false
      }
      if (row.kind === 'job' && typeFilter === 'job') {
        if (!matchesJobFilter(row.status, jobFilter)) return false
      }
      if (!query) return true
      return smartMatch(query, [
        row.number,
        row.title,
        row.status,
        formatDocumentStatus(row.kind, row.status),
        row.meta,
        row.clientName,
        kindLabels[row.kind],
        String(row.amount),
      ])
    })

    if (query) {
      rows = [...rows].sort((a, b) => {
        const scoreDiff =
          scoreHaystack(query, [b.number, b.title, b.clientName], [b.meta, b.status]) -
          scoreHaystack(query, [a.number, a.title, a.clientName], [a.meta, a.status])
        if (scoreDiff !== 0) return scoreDiff
        return compareDocuments(a, b, sort)
      })
    } else {
      rows = [...rows].sort((a, b) => compareDocuments(a, b, sort))
    }

    return rows
  }, [documents, search, typeFilter, invoiceFilter, estimateFilter, requestFilter, jobFilter, sort])

  const visibleTotal = filtered.reduce((sum, row) => sum + row.amount, 0)
  const isInitialLoad = loading && documents.length === 0
  const isRefreshing = loading && documents.length > 0

  const showInvoiceFilter = typeFilter === 'invoice'
  const showEstimateFilter = typeFilter === 'estimate'
  const showRequestFilter = typeFilter === 'request'
  const showJobFilter = typeFilter === 'job'
  const filterCount =
    1 +
    (showEstimateFilter ? 1 : 0) +
    (showInvoiceFilter ? 1 : 0) +
    (showRequestFilter ? 1 : 0) +
    (showJobFilter ? 1 : 0) +
    1
  const showReceiptActions = documents.some((row) => row.kind === 'payment' && row.canReceipt)
  const leadingColumns = (enableInvoiceSelection ? 1 : 0) + 6
  const totalColumns = leadingColumns + (showReceiptActions ? 1 : 0)

  const downloadPaymentReceipt = async (row: UnifiedDocumentRow) => {
    setDownloadingReceiptId(row.id)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/payments/${row.id}/receipt`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        const data = contentType.includes('application/json')
          ? await response.json().catch(() => ({}))
          : {}
        alert(
          data.error ||
            (response.status === 403
              ? 'You do not have permission to download receipts.'
              : `Failed to download receipt (${response.status})`)
        )
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `receipt-${row.number || row.id}.pdf`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Receipt download error:', error)
      alert('Failed to download receipt')
    } finally {
      setDownloadingReceiptId(null)
    }
  }

  const openReceiptEmailDialog = (row: UnifiedDocumentRow) => {
    setReceiptEmailPayment(row)
    setSelectedRecipientEmails([])
    setCustomEmails('')
    setReceiptEmailResult(null)
    setShowReceiptEmailDialog(true)
  }

  const closeReceiptEmailDialog = () => {
    setShowReceiptEmailDialog(false)
    setReceiptEmailPayment(null)
    setSelectedRecipientEmails([])
    setCustomEmails('')
    setReceiptEmailResult(null)
  }

  const receiptPickerClientId =
    receiptEmailPayment?.clientId || receiptClientId || null

  const sendReceiptEmail = async () => {
    if (!receiptEmailPayment) return
    const customEmailList = customEmails
      .split(/[,\s;]+/g)
      .map((v) => v.trim())
      .filter(Boolean)
    const emails = Array.from(new Set([...selectedRecipientEmails, ...customEmailList]))
    if (emails.length === 0) return

    setReceiptEmailSending(true)
    setReceiptEmailResult(null)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/payments/${receiptEmailPayment.id}/receipt`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails }),
      })
      const data = await response.json()
      if (!response.ok) {
        setReceiptEmailResult({ ok: false, message: data.error || 'Failed to send receipt' })
        return
      }
      setReceiptEmailResult({ ok: true, message: `Receipt sent to ${data.sentTo}` })
      await onDocumentsRefresh?.()
      setTimeout(() => {
        closeReceiptEmailDialog()
      }, 2000)
    } catch {
      setReceiptEmailResult({ ok: false, message: 'Network error — please try again' })
    } finally {
      setReceiptEmailSending(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Documents
            </CardTitle>
            <CardDescription>
              {description}
              {isRefreshing ? ' • Updating…' : ''}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {open && enableInvoiceSelection && onAddPayment && (
              <Button variant="outline" onClick={onAddPayment} disabled={selectedInvoiceIds.length === 0}>
                <DollarSign className="mr-2 h-4 w-4" />
                Add Payment{selectedInvoiceIds.length > 0 ? ` (${selectedInvoiceIds.length})` : ''}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => setOpen((prev) => !prev)}
              aria-label={open ? 'Hide documents' : 'Show documents'}
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown className="h-5 w-5 text-gray-500" />
              ) : (
                <ChevronRight className="h-5 w-5 text-gray-500" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && (
      <CardContent className="space-y-4 pt-0">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search number, title, status..."
              className="pl-9"
            />
          </div>
          <div
            className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${
              filterCount >= 4 ? 'lg:grid-cols-4' : filterCount === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-2'
            } lg:flex-1 lg:max-w-3xl`}
          >
            <Select value={typeFilter} onValueChange={(v) => {
              const next = v as TypeFilter
              setTypeFilter(next)
              if (next !== 'invoice') setInvoiceFilter('all')
              if (next !== 'estimate') setEstimateFilter('all')
              if (next !== 'request') setRequestFilter('all')
              if (next !== 'job') setJobFilter('all')
            }}>
              <SelectTrigger>
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="job">Jobs</SelectItem>
                <SelectItem value="request">Requests</SelectItem>
                <SelectItem value="estimate">Estimates</SelectItem>
                <SelectItem value="invoice">Invoices</SelectItem>
                <SelectItem value="credit_memo">Credit Memos</SelectItem>
                <SelectItem value="payment">Payments</SelectItem>
                <SelectItem value="purchase_order">Purchase Orders</SelectItem>
              </SelectContent>
            </Select>
            {showEstimateFilter && (
              <Select value={estimateFilter} onValueChange={(v) => setEstimateFilter(v as EstimateFilter)}>
                <SelectTrigger>
                  <SelectValue placeholder="Estimate status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All estimates</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="converted">Converted</SelectItem>
                </SelectContent>
              </Select>
            )}
            {showInvoiceFilter && (
              <Select value={invoiceFilter} onValueChange={(v) => setInvoiceFilter(v as InvoiceFilter)}>
                <SelectTrigger>
                  <SelectValue placeholder="Invoice status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All invoices</SelectItem>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                </SelectContent>
              </Select>
            )}
            {showRequestFilter && (
              <Select value={requestFilter} onValueChange={(v) => setRequestFilter(v as RequestFilter)}>
                <SelectTrigger>
                  <SelectValue placeholder="Request status" />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {showJobFilter && (
              <Select value={jobFilter} onValueChange={(v) => setJobFilter(v as JobFilter)}>
                <SelectTrigger>
                  <SelectValue placeholder="Job status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All jobs</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  {JOB_STATUSES.map((status) => (
                    <SelectItem key={status.value} value={status.value}>
                      {status.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
              <SelectTrigger>
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest first</SelectItem>
                <SelectItem value="date-asc">Oldest first</SelectItem>
                <SelectItem value="amount-desc">Amount high → low</SelectItem>
                <SelectItem value="amount-asc">Amount low → high</SelectItem>
                <SelectItem value="status-asc">Status A → Z</SelectItem>
                <SelectItem value="status-desc">Status Z → A</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error && documents.length === 0 ? (
          <div className="mb-3 flex flex-col items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <p className="text-sm text-red-700">{error}</p>
            {onDocumentsRefresh ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void onDocumentsRefresh()}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}

        {isInitialLoad ? (
          <p className="py-8 text-center text-sm text-gray-500">Loading documents...</p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">No documents match your filters</p>
        ) : (
          <div className={`overflow-x-auto overflow-y-auto max-h-[min(32rem,65vh)] rounded-lg border ${isRefreshing ? 'opacity-70' : ''}`}>
            <table className="min-w-full table-fixed text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 shadow-[0_1px_0_0_rgb(229_231_235)]">
                <tr>
                  {enableInvoiceSelection && <th className="px-3 py-2 w-8" />}
                  <th className="relative px-3 py-2" style={{ width: colWidths.type, minWidth: 64 }}>
                    Type
                    <ColumnResizeHandle onResizeStart={(x) => onResizeStart('type', x)} />
                  </th>
                  <th className="relative px-3 py-2" style={{ width: colWidths.number, minWidth: 80 }}>
                    Number
                    <ColumnResizeHandle onResizeStart={(x) => onResizeStart('number', x)} />
                  </th>
                  <th className="relative px-3 py-2" style={{ width: colWidths.title, minWidth: 100 }}>
                    Title
                    <ColumnResizeHandle onResizeStart={(x) => onResizeStart('title', x)} />
                  </th>
                  <th className="relative px-3 py-2" style={{ width: colWidths.date, minWidth: 80 }}>
                    <button type="button" className="inline-flex items-center" onClick={() => toggleColumnSort('date')}>
                      Date{sortIcon('date')}
                    </button>
                    <ColumnResizeHandle onResizeStart={(x) => onResizeStart('date', x)} />
                  </th>
                  <th className="relative px-3 py-2 text-right" style={{ width: colWidths.amount, minWidth: 80 }}>
                    <button type="button" className="inline-flex items-center ml-auto" onClick={() => toggleColumnSort('amount')}>
                      Amount{sortIcon('amount')}
                    </button>
                    <ColumnResizeHandle onResizeStart={(x) => onResizeStart('amount', x)} />
                  </th>
                  <th className="relative px-3 py-2" style={{ width: colWidths.status, minWidth: 80 }}>
                    <button type="button" className="inline-flex items-center" onClick={() => toggleColumnSort('status')}>
                      Status{sortIcon('status')}
                    </button>
                    <ColumnResizeHandle onResizeStart={(x) => onResizeStart('status', x)} />
                  </th>
                  {showReceiptActions && (
                    <th className="relative px-3 py-2" style={{ width: colWidths.actions, minWidth: 80 }}>
                      Actions
                      <ColumnResizeHandle onResizeStart={(x) => onResizeStart('actions', x)} />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const selectable =
                    enableInvoiceSelection &&
                    row.kind === 'invoice' &&
                    row.isPaid === false &&
                    (row.balance ?? 0) > 0

                  return (
                    <tr key={`${row.kind}-${row.id}`} className="border-t hover:bg-gray-50">
                      {enableInvoiceSelection && (
                        <td className="px-3 py-2 align-top">
                          {selectable ? (
                            <input
                              type="checkbox"
                              checked={selectedInvoiceIds.includes(row.id)}
                              onChange={(e) => onToggleInvoice?.(row.id, e.target.checked)}
                              className="mt-1"
                            />
                          ) : null}
                        </td>
                      )}
                      <td className="px-3 py-2 align-top">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${kindBadgeClass[row.kind]}`}>
                          {kindLabels[row.kind]}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {row.href !== '#' ? (
                          <Link href={row.href} className="font-medium text-primary hover:underline">
                            {row.number}
                          </Link>
                        ) : (
                          <span className="font-medium">{row.number}</span>
                        )}
                        {row.meta && (
                          <p className="text-xs text-gray-500 mt-0.5">{row.meta}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top max-w-[16rem] text-gray-600">
                        <p className="truncate">{row.title || '—'}</p>
                        {row.clientName && (
                          <p className="text-xs text-gray-500 truncate mt-0.5">Sub-client: {row.clientName}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap text-gray-600">
                        {formatDate(row.date)}
                      </td>
                      <td className="px-3 py-2 align-top text-right font-medium whitespace-nowrap">
                        {formatCurrency(row.amount)}
                        {row.kind === 'invoice' && row.balance != null && row.balance > 0 && (
                          <p className="text-xs font-normal text-amber-700">
                            Bal {formatCurrency(row.balance)}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs ${statusClass(row.kind, row.status)}`}>
                          {formatDocumentStatus(row.kind, row.status)}
                        </span>
                      </td>
                      {showReceiptActions && (
                        <td className="px-3 py-2 align-top">
                          {row.kind === 'payment' && row.canReceipt ? (
                            <div className="flex flex-col items-start gap-1">
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  disabled={downloadingReceiptId === row.id}
                                  onClick={() => downloadPaymentReceipt(row)}
                                >
                                  <Download className="mr-1 h-3 w-3" />
                                  {downloadingReceiptId === row.id ? '...' : 'PDF'}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => openReceiptEmailDialog(row)}
                                >
                                  <Mail className="mr-1 h-3 w-3" />
                                  Email
                                </Button>
                              </div>
                              {row.receiptEmailSentAt && (
                                <span className="text-[10px] text-gray-400">Receipt emailed</span>
                              )}
                            </div>
                          ) : null}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="sticky bottom-0 z-10 border-t bg-slate-50 shadow-[0_-1px_0_0_rgb(229_231_235)]">
                <tr>
                  <td
                    colSpan={totalColumns - 2}
                    className="px-3 py-3 text-sm text-gray-600"
                  >
                    Showing {filtered.length} of {documents.length} document{documents.length !== 1 ? 's' : ''}
                  </td>
                  <td className="px-3 py-3 text-right text-sm font-semibold text-gray-900">
                    {formatCurrency(visibleTotal)}
                  </td>
                  <td className="px-3 py-3 text-xs text-gray-500">Total shown</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
      )}

      {showReceiptEmailDialog && receiptEmailPayment && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-5 border-b">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Email Payment Receipt</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {formatCurrency(receiptEmailPayment.amount)} — Invoice {receiptEmailPayment.number}
                </p>
              </div>
              <button
                type="button"
                onClick={closeReceiptEmailDialog}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="space-y-2">
                <Label>Recipients</Label>
                <ContactRecipientPicker
                  key={receiptEmailPayment.id}
                  clientId={receiptPickerClientId}
                  onSelectionChange={(emails) => setSelectedRecipientEmails(emails)}
                  manageContactsHref={
                    receiptPickerClientId
                      ? `/dashboard/clients/${receiptPickerClientId}/edit`
                      : undefined
                  }
                  disabled={receiptEmailSending}
                />
                <p className="text-xs text-muted-foreground">
                  Choose which contacts should receive this receipt, or add a custom email below.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Additional email(s) (optional)</Label>
                <Input
                  value={customEmails}
                  onChange={(e) => setCustomEmails(e.target.value)}
                  placeholder="someone-else@email.com"
                  disabled={receiptEmailSending}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') sendReceiptEmail()
                  }}
                />
                <p className="text-xs text-muted-foreground">Multiple emails: separate with commas.</p>
              </div>

              {receiptEmailResult && (
                <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
                  receiptEmailResult.ok
                    ? 'bg-green-50 text-green-800 border border-green-200'
                    : 'bg-red-50 text-red-800 border border-red-200'
                }`}>
                  {receiptEmailResult.message}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-5 pt-0">
              <Button
                variant="outline"
                size="sm"
                onClick={closeReceiptEmailDialog}
                disabled={receiptEmailSending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-[#1e4d6e] hover:bg-[#163a54] text-white"
                onClick={sendReceiptEmail}
                disabled={
                  receiptEmailSending ||
                  (selectedRecipientEmails.length === 0 && !customEmails.trim())
                }
              >
                <Mail className="h-4 w-4 mr-1" />
                {receiptEmailSending ? 'Sending...' : 'Send Receipt'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
