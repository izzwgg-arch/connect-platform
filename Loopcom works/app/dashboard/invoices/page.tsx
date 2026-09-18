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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ViewModeSelector } from '@/components/ui/ViewModeSelector'
import { useViewMode } from '@/hooks/useViewMode'
import { RowCompactItem } from '@/components/lists/RowCompactItem'
import { RowDetailedItem } from '@/components/lists/RowDetailedItem'
import { TableView } from '@/components/lists/TableView'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Plus, Search, Filter, DollarSign, AlertCircle, Trash2, Copy, Download } from 'lucide-react'
import Link from 'next/link'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

interface Invoice {
  id: string
  invoiceNumber: string
  title: string
  status: string
  progressBillingMode?: string | null
  progressBillingPercent?: string | number | null
  total: string
  balance: string
  paidAmount: string
  invoiceDate: string
  dueDate: string | null
  sentAt: string | null
  paidAt: string | null
  client: {
    id: string
    name: string
    companyName: string | null
  }
  job: {
    id: string
    jobNumber: string
  } | null
  estimate?: {
    id: string
    estimateNumber: string
  } | null
  jobSiteAddress?: string
  _count: {
    lineItems: number
    payments: number
  }
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  VIEWED: 'bg-purple-100 text-purple-800',
  PARTIAL: 'bg-yellow-100 text-yellow-800',
  PAID: 'bg-green-100 text-green-800',
  OVERDUE: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-100 text-gray-800',
  REFUNDED: 'bg-orange-100 text-orange-800',
}

function progressBillingLabel(invoice: Invoice): string | null {
  if (!invoice.estimate || invoice.progressBillingMode !== 'PERCENTAGE') return null
  const pct = Number(invoice.progressBillingPercent || 0)
  if (!Number.isFinite(pct) || pct <= 0) return null
  return `${pct}% of ${invoice.estimate.estimateNumber}`
}

function renderJobSiteAddress(address?: string) {
  const value = String(address || '').trim()
  if (!value) return null
  return (
    <span className="block max-w-[260px] truncate" title={value}>
      {value}
    </span>
  )
}

export default function InvoicesPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('invoices')
  const { sortKey: persistedSortKey, sortDirection: persistedSortDirection, setSort: setPersistedSort } = usePersistedSort('invoices')
  const searchParams = useSearchParams()
  const { permissions, loading: permissionsLoading } = usePermissions()
  const canViewList = hasPermission(permissions, 'invoices.view')
  const canCreate = hasPermission(permissions, 'invoices.create')
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [showBulkPayment, setShowBulkPayment] = useState(false)
  const [bulkPaymentAmounts, setBulkPaymentAmounts] = useState<Record<string, string>>({})
  const [bulkPaymentMethod, setBulkPaymentMethod] = useState<'CHECK' | 'QUICK_PAY' | 'OTHER'>('CHECK')
  const [bulkPaymentOtherLabel, setBulkPaymentOtherLabel] = useState('')
  const [bulkPaymentDate, setBulkPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [bulkPaymentReference, setBulkPaymentReference] = useState('')
  const [bulkPaymentSaving, setBulkPaymentSaving] = useState(false)
  const [bulkPaymentError, setBulkPaymentError] = useState('')
  const [viewMode, setViewMode] = useViewMode('invoices', 'grid')
  const [summary, setSummary] = useState<{
    totalInvoicesAllTime: number
    overdueCountAllTime: number
    unpaidCountAllTime: number
    totalUnpaidAllTime: number
  } | null>(null)

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
  }

  const selectedVisibleInvoices = invoices.filter((invoice) => selectedIds.includes(invoice.id))
  const payableSelectedInvoices = selectedVisibleInvoices.filter((invoice) => {
    const balance = parseFloat(invoice.balance || '0')
    return balance > 0 && invoice.status !== 'CANCELLED' && invoice.status !== 'REFUNDED'
  })
  const skippedSelectedInvoices = selectedVisibleInvoices.filter((invoice) => !payableSelectedInvoices.some((item) => item.id === invoice.id))
  const bulkPaymentTotal = payableSelectedInvoices.reduce((sum, invoice) => {
    const amount = parseFloat(bulkPaymentAmounts[invoice.id] || '0')
    return sum + (Number.isFinite(amount) ? amount : 0)
  }, 0)

  useEffect(() => {
    const statusParam = searchParams.get('status')
    if (statusParam) {
      setStatus(statusParam)
    }
  }, [searchParams])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, status])

  useEffect(() => {
    if (permissionsLoading) return
    fetchInvoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, status, page, permissionsLoading, canViewList])

  const fetchInvoices = async () => {
    if (!canViewList) {
      setInvoices([])
      setSummary(null)
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

      const response = await fetch(`/api/invoices?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setInvoices(data.invoices || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
      if (data?.summary) {
        setSummary({
          totalInvoicesAllTime: Number(data.summary.totalInvoicesAllTime || 0),
          overdueCountAllTime: Number(data.summary.overdueCountAllTime || 0),
          unpaidCountAllTime: Number(data.summary.unpaidCountAllTime || 0),
          totalUnpaidAllTime: Number(data.summary.totalUnpaidAllTime || 0),
        })
      }
    } catch (error) {
      console.error('Failed to fetch invoices:', error)
    } finally {
      setInitialLoading(false)
      setIsFetching(false)
    }
  }

  const handleDelete = async (invoiceId: string, invoiceTitle: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete invoice "${invoiceTitle}"?\n\n` +
      'If the invoice has payments, it cannot be deleted and will be cancelled instead. This action cannot be undone.'
    )

    if (!confirmed) return

    setDeletingId(invoiceId)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/invoices/${invoiceId}`, {
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
        alert(error.error || 'Failed to delete invoice')
        setDeletingId(null)
        return
      }

      // Refresh the invoices list
      fetchInvoices()
    } catch (error) {
      console.error('Error deleting invoice:', error)
      alert('Failed to delete invoice')
    } finally {
      setDeletingId(null)
    }
  }

  const handleDuplicateSelected = async () => {
    if (selectedIds.length === 0) return
    if (!confirm(`Duplicate ${selectedIds.length} selected invoice(s)?`)) return

    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      for (const invoiceId of selectedIds) {
        const response = await fetch(`/api/invoices/${invoiceId}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          alert(data.error || 'Failed to duplicate one or more invoices')
          break
        }
      }

      setSelectedIds([])
      fetchInvoices()
    } catch (error) {
      console.error('Failed duplicating invoices:', error)
      alert('Failed to duplicate selected invoices')
    } finally {
      setDuplicating(false)
    }
  }

  const handleExport = async (scope: 'selected' | 'filtered' | 'all') => {
    setExporting(true)
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams()
      if (scope === 'selected') {
        if (selectedIds.length === 0) return
        params.set('ids', selectedIds.join(','))
      } else if (scope === 'filtered') {
        if (search)  params.set('search', search)
        if (status !== 'all') params.set('status', status)
      }
      // scope === 'all' sends no params → returns everything

      const res = await fetch(`/api/invoices/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) { alert('Export failed'); return }

      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const nameMatch = cd.match(/filename="([^"]+)"/)
      const filename = nameMatch ? nameMatch[1] : 'invoices.xlsx'

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Export error', e)
      alert('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const openBulkPaymentModal = () => {
    if (payableSelectedInvoices.length === 0) {
      alert('Select at least one unpaid invoice to add payments.')
      return
    }
    const nextAmounts: Record<string, string> = {}
    for (const invoice of payableSelectedInvoices) {
      nextAmounts[invoice.id] = Number(invoice.balance || 0).toFixed(2)
    }
    setBulkPaymentAmounts(nextAmounts)
    setBulkPaymentMethod('CHECK')
    setBulkPaymentOtherLabel('')
    setBulkPaymentDate(new Date().toISOString().split('T')[0])
    setBulkPaymentReference('')
    setBulkPaymentError('')
    setShowBulkPayment(true)
  }

  const handleBulkPaymentSubmit = async () => {
    if (payableSelectedInvoices.length === 0) {
      setBulkPaymentError('Select at least one unpaid invoice.')
      return
    }
    if (!bulkPaymentDate) {
      setBulkPaymentError('Payment date is required.')
      return
    }
    const parsedPaymentDate = new Date(bulkPaymentDate)
    if (Number.isNaN(parsedPaymentDate.getTime())) {
      setBulkPaymentError('Enter a valid payment date.')
      return
    }
    if (bulkPaymentMethod === 'OTHER' && !bulkPaymentOtherLabel.trim()) {
      setBulkPaymentError('Please enter a payment type name.')
      return
    }

    const items: Array<{ invoiceId: string; amount: number }> = []
    for (const invoice of payableSelectedInvoices) {
      const amount = parseFloat(bulkPaymentAmounts[invoice.id] || '0')
      const balance = parseFloat(invoice.balance || '0')
      if (!Number.isFinite(amount) || amount <= 0) {
        setBulkPaymentError(`Enter a valid amount for ${invoice.invoiceNumber}.`)
        return
      }
      if (amount > balance) {
        setBulkPaymentError(`${invoice.invoiceNumber} cannot exceed its balance of ${formatCurrency(balance)}.`)
        return
      }
      items.push({ invoiceId: invoice.id, amount })
    }

    setBulkPaymentSaving(true)
    setBulkPaymentError('')
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch('/api/invoices/bulk-manual-payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          method: bulkPaymentMethod,
          methodLabel: bulkPaymentMethod === 'OTHER' ? bulkPaymentOtherLabel.trim() : undefined,
          paidAt: bulkPaymentDate,
          reference: bulkPaymentReference.trim() || undefined,
          items,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setBulkPaymentError(data.error || 'Failed to record payments.')
        return
      }
      setShowBulkPayment(false)
      setBulkPaymentAmounts({})
      setBulkPaymentMethod('CHECK')
      setBulkPaymentOtherLabel('')
      setBulkPaymentDate(new Date().toISOString().split('T')[0])
      setBulkPaymentReference('')
      setSelectedIds((prev) => prev.filter((id) => !items.some((item) => item.invoiceId === id)))
      await fetchInvoices()
    } catch (error) {
      console.error('Bulk payment error:', error)
      setBulkPaymentError('Failed to record payments. Please try again.')
    } finally {
      setBulkPaymentSaving(false)
    }
  }

  if (initialLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading invoices...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Invoices</h1>
          <p className="mt-2 text-gray-600">Manage invoices and payments</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />

          {canViewList && (
            <>
          {/* Export controls */}
          <div className="flex items-center gap-1 border border-gray-200 rounded-md overflow-hidden">
            <button
              onClick={() => handleExport(selectedIds.length > 0 ? 'selected' : 'filtered')}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50 border-r border-gray-200 transition-colors"
              title={selectedIds.length > 0 ? `Export ${selectedIds.length} selected invoice(s)` : `Export ${total} filtered invoices`}
            >
              <Download className="h-4 w-4 text-emerald-600" />
              {exporting ? 'Exporting…' : selectedIds.length > 0 ? `Export (${selectedIds.length})` : `Export (${total})`}
            </button>
            <button
              onClick={() => handleExport('all')}
              disabled={exporting}
              className="px-2 py-2 text-xs bg-white hover:bg-gray-50 text-gray-500 disabled:opacity-50 transition-colors whitespace-nowrap"
              title="Export all invoices"
            >
              All
            </button>
          </div>

          <Button
            variant="outline"
            onClick={handleDuplicateSelected}
            disabled={selectedIds.length === 0 || duplicating}
          >
            <Copy className="mr-2 h-4 w-4" />
            {duplicating ? 'Duplicating...' : `Duplicate${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
          </Button>
          <Button
            variant="outline"
            onClick={openBulkPaymentModal}
            disabled={payableSelectedInvoices.length === 0}
          >
            <DollarSign className="mr-2 h-4 w-4" />
            {selectedIds.length > 0 ? `Add Payment (${payableSelectedInvoices.length})` : 'Add Payment'}
          </Button>
            </>
          )}
          {canCreate && (
          <Button onClick={() => router.push('/dashboard/invoices/new')}>
            <Plus className="mr-2 h-4 w-4" />
            New Invoice
          </Button>
          )}
        </div>
      </div>

      {!canViewList && (
        <Card>
          <CardContent className="py-10 text-center">
            <DollarSign className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-3 text-sm font-medium text-gray-900">Create-only access</h3>
            <p className="mt-1 text-sm text-gray-500">
              You can create new invoices, but you do not have permission to browse existing ones.
            </p>
            {canCreate && (
              <div className="mt-6">
                <Button onClick={() => router.push('/dashboard/invoices/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Invoice
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canViewList && (
        <>
      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Unpaid</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(summary?.totalUnpaidAllTime || 0)}</div>
            <p className="text-xs text-gray-500 mt-1">
              {summary?.unpaidCountAllTime ?? 0} invoices
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Overdue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{summary?.overdueCountAllTime ?? 0}</div>
            <p className="text-xs text-gray-500 mt-1">Requires attention</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.totalInvoicesAllTime ?? 0}</div>
            <p className="text-xs text-gray-500 mt-1">All time</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4 flex-wrap gap-y-2">
            <div className="flex-1 relative min-w-[180px]">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by invoice #, client name, or address..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="UNPAID_OVERDUE">Unpaid / Overdue</SelectItem>
                  <SelectItem value="PAID">Paid</SelectItem>
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="SENT">Sent</SelectItem>
                  <SelectItem value="VIEWED">Viewed</SelectItem>
                  <SelectItem value="PARTIAL">Partial</SelectItem>
                  <SelectItem value="OVERDUE">Overdue</SelectItem>
                  <SelectItem value="CANCELLED">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Select / deselect all on page */}
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={invoices.length > 0 && invoices.every((inv) => selectedIds.includes(inv.id))}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedIds((prev) => Array.from(new Set([...prev, ...invoices.map((i) => i.id)])))
                  } else {
                    setSelectedIds((prev) => prev.filter((id) => !invoices.map((i) => i.id).includes(id)))
                  }
                }}
              />
              {selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Select page'}
            </label>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showBulkPayment} onOpenChange={setShowBulkPayment}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Payment to Selected Invoices</DialogTitle>
            <DialogDescription>
              Record manual payments for the selected invoices. Each payment will update the invoice and sync to QuickBooks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Payment Type</Label>
              <div className="flex flex-col gap-2">
                {(['CHECK', 'QUICK_PAY', 'OTHER'] as const).map((method) => (
                  <label key={method} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={bulkPaymentMethod === method}
                      onChange={() => setBulkPaymentMethod(method)}
                      className="accent-blue-600"
                    />
                    <span className="text-sm font-medium">
                      {method === 'CHECK' ? 'Check' : method === 'QUICK_PAY' ? 'QuickPay' : 'Other'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {bulkPaymentMethod === 'OTHER' && (
              <div className="space-y-1">
                <Label htmlFor="bulk-payment-other">Payment Type Name</Label>
                <Input
                  id="bulk-payment-other"
                  placeholder="e.g. Cash, Zelle, Venmo..."
                  value={bulkPaymentOtherLabel}
                  onChange={(e) => setBulkPaymentOtherLabel(e.target.value)}
                />
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="bulk-payment-date">Payment Date</Label>
                <Input
                  id="bulk-payment-date"
                  type="date"
                  value={bulkPaymentDate}
                  onChange={(e) => setBulkPaymentDate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bulk-payment-reference">Reference Number</Label>
                <Input
                  id="bulk-payment-reference"
                  placeholder="Check #, confirmation #..."
                  value={bulkPaymentReference}
                  onChange={(e) => setBulkPaymentReference(e.target.value)}
                />
              </div>
            </div>
            <div className="max-h-[360px] overflow-y-auto rounded-md border">
              <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-3 border-b bg-gray-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                <div>Invoice</div>
                <div>Balance</div>
                <div>Payment Amount</div>
              </div>
              <div className="divide-y">
                {payableSelectedInvoices.map((invoice) => (
                  <div key={invoice.id} className="grid grid-cols-[1.4fr_1fr_1fr] gap-3 px-4 py-3 items-center">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-gray-900">{invoice.invoiceNumber}</div>
                      <div className="truncate text-xs text-gray-500">{invoice.client.name}</div>
                    </div>
                    <div className="text-sm text-gray-700">{formatCurrency(parseFloat(invoice.balance))}</div>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        className="pl-7"
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
                ))}
              </div>
            </div>
            {skippedSelectedInvoices.length > 0 && (
              <p className="text-xs text-amber-600">
                {skippedSelectedInvoices.length} selected invoice{skippedSelectedInvoices.length !== 1 ? 's were' : ' was'} skipped because {skippedSelectedInvoices.length !== 1 ? 'they are' : 'it is'} already fully paid or not payable.
              </p>
            )}
            <div className="flex items-center justify-between rounded-md bg-gray-50 px-4 py-3">
              <span className="text-sm text-gray-600">Total payment</span>
              <span className="text-lg font-semibold text-gray-900">{formatCurrency(bulkPaymentTotal)}</span>
            </div>
            {bulkPaymentError && <p className="text-sm text-red-600">{bulkPaymentError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkPayment(false)} disabled={bulkPaymentSaving}>
              Cancel
            </Button>
            <Button onClick={handleBulkPaymentSubmit} disabled={bulkPaymentSaving || payableSelectedInvoices.length === 0}>
              {bulkPaymentSaving ? 'Saving...' : 'Save Payments'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoices List */}
      {viewMode === 'grid' ? (
      <div className="space-y-4">
        {invoices.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <DollarSign className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No invoices</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating a new invoice.
              </p>
              <div className="mt-6">
                <Button onClick={() => router.push('/dashboard/invoices/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Invoice
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          invoices.map((invoice) => {
            const isOverdue = invoice.status === 'OVERDUE' || (invoice.dueDate && new Date(invoice.dueDate) < new Date() && Number(invoice.balance) > 0)
            return (
              <Card key={invoice.id} className={`hover:shadow-lg transition-shadow ${isOverdue ? 'border-red-300' : ''}`}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <Link href={`/dashboard/invoices/${invoice.id}`}>
                        <CardTitle className="text-lg hover:text-primary cursor-pointer">
                          {invoice.title}
                        </CardTitle>
                      </Link>
                      <CardDescription className="mt-1">
                        {invoice.invoiceNumber} • <Link href={`/dashboard/clients/${invoice.client.id}`} className="hover:text-primary">{invoice.client.name}</Link>
                        {invoice.job && ` • Job ${invoice.job.jobNumber}`}
                      </CardDescription>
                    {invoice.jobSiteAddress ? (
                      <p className="mt-1 text-xs text-gray-500" title={invoice.jobSiteAddress}>
                        <span className="inline-block max-w-[320px] truncate">{invoice.jobSiteAddress}</span>
                      </p>
                    ) : null}
                      {progressBillingLabel(invoice) ? (
                        <p className="mt-1 text-xs font-medium text-blue-600">
                          Converted from estimate: {progressBillingLabel(invoice)}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(invoice.id)}
                        onChange={(e) =>
                          setSelectedIds((prev) =>
                            e.target.checked
                              ? [...prev, invoice.id]
                              : prev.filter((id) => id !== invoice.id)
                          )
                        }
                        className="h-4 w-4"
                        title="Select for duplicate"
                      />
                      {isOverdue && (
                        <AlertCircle className="h-5 w-5 text-red-500" />
                      )}
                      <span className={`px-2 py-1 text-xs rounded-full ${statusColors[invoice.status] || 'bg-gray-100 text-gray-800'}`}>
                        {invoice.status}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-500">Total</span>
                      <span className="text-lg font-bold">{formatCurrency(parseFloat(invoice.total))}</span>
                    </div>
                    
                    {parseFloat(invoice.balance) > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-500">Balance</span>
                        <span className={`text-lg font-semibold ${isOverdue ? 'text-red-600' : 'text-gray-900'}`}>
                          {formatCurrency(parseFloat(invoice.balance))}
                        </span>
                      </div>
                    )}

                    {parseFloat(invoice.paidAmount) > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-500">Paid</span>
                        <span className="text-sm font-medium text-green-600">
                          {formatCurrency(parseFloat(invoice.paidAmount))}
                        </span>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 text-sm pt-2 border-t">
                      <div>
                        <p className="text-xs text-gray-500">Invoice Date</p>
                        <p className="font-medium text-gray-700">{formatDate(invoice.invoiceDate)}</p>
                      </div>
                      {invoice.dueDate && (
                        <div>
                          <p className={`text-xs ${isOverdue ? 'text-red-500' : 'text-gray-500'}`}>
                            Due Date {isOverdue && '• OVERDUE'}
                          </p>
                          <p className={`font-medium ${isOverdue ? 'text-red-600' : 'text-gray-700'}`}>
                            {formatDate(invoice.dueDate)}
                          </p>
                        </div>
                      )}
                    </div>

                    {invoice._count.payments > 0 && (
                      <div className="pt-2 border-t">
                        <p className="text-xs text-gray-500">
                          {invoice._count.payments} payment{invoice._count.payments !== 1 ? 's' : ''}
                        </p>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2 border-t">
                      <div className="flex items-center space-x-3 text-xs text-gray-500">
                        {invoice._count.lineItems > 0 && (
                          <span>{invoice._count.lineItems} line item{invoice._count.lineItems !== 1 ? 's' : ''}</span>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(invoice.id, invoice.title)
                        }}
                        disabled={deletingId === invoice.id}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
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
          {invoices.map((invoice) => (
            <RowCompactItem
              key={invoice.id}
              href={`/dashboard/invoices/${invoice.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(invoice.id)}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onChange={(e) => toggleSelected(invoice.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              }
              primary={`${invoice.invoiceNumber} • ${invoice.title}`}
              secondary={[
                invoice.client.name,
                invoice.jobSiteAddress || null,
                progressBillingLabel(invoice) ? `Converted: ${progressBillingLabel(invoice)}` : null,
              ].filter(Boolean).join(' • ')}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[invoice.status] || 'bg-gray-100 text-gray-800'}`}>{invoice.status}</span>}
              amount={formatCurrency(parseFloat(invoice.total))}
              date={formatDate(invoice.invoiceDate)}
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {invoices.map((invoice) => (
            <RowDetailedItem
              key={invoice.id}
              href={`/dashboard/invoices/${invoice.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(invoice.id)}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onChange={(e) => toggleSelected(invoice.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              }
              primary={`${invoice.invoiceNumber} • ${invoice.title}`}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[invoice.status] || 'bg-gray-100 text-gray-800'}`}>{invoice.status}</span>}
              line2={[
                invoice.client.name,
                invoice.jobSiteAddress || null,
                progressBillingLabel(invoice) ? `Converted: ${progressBillingLabel(invoice)}` : null,
                `Balance ${formatCurrency(parseFloat(invoice.balance))}`,
              ].filter(Boolean).join(' • ')}
              rightTop={formatCurrency(parseFloat(invoice.total))}
              rightBottom={formatDate(invoice.invoiceDate)}
            />
          ))}
        </div>
      ) : (
        <TableView
          highlightedRowId={highlightedId}
          sortKey={persistedSortKey}
          sortDirection={persistedSortDirection}
          onSortChange={setPersistedSort}
          data={invoices}
          rowKey={(invoice) => invoice.id}
          onRowClick={(invoice) => openFromList(router, { entity: 'invoices', detailHref: `/dashboard/invoices/${invoice.id}`, itemId: invoice.id })}
          columns={[
            {
              key: 'select',
              header: '',
              render: (invoice) => (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(invoice.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => toggleSelected(invoice.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              ),
              className: 'w-10',
              headerClassName: 'w-10',
            },
            {
              key: 'invoice',
              header: 'Invoice',
              sortValue: (invoice) => `${invoice.invoiceNumber} ${invoice.title}`,
              render: (invoice) => (
                <div>
                  <div className="font-medium">{invoice.invoiceNumber} • {invoice.title}</div>
                  {progressBillingLabel(invoice) ? (
                    <div className="text-xs text-blue-600">Converted: {progressBillingLabel(invoice)}</div>
                  ) : null}
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (invoice) => invoice.status,
              render: (invoice) => <span className={`px-2 py-1 text-xs rounded-full ${statusColors[invoice.status] || 'bg-gray-100 text-gray-800'}`}>{invoice.status}</span>,
            },
            {
              key: 'client',
              header: 'Client',
              sortValue: (invoice) => invoice.client.name,
              render: (invoice) => invoice.client.name,
            },
            {
              key: 'jobSiteAddress',
              header: 'Job Site Address',
              sortValue: () => '',
              render: (invoice) => renderJobSiteAddress(invoice.jobSiteAddress),
            },
            {
              key: 'total',
              header: 'Total',
              sortValue: (invoice) => Number(invoice.total),
              render: (invoice) => formatCurrency(parseFloat(invoice.total)),
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (invoice) => (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(invoice.id, invoice.title)
                  }}
                  disabled={deletingId === invoice.id}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
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
