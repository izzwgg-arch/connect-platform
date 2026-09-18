'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, FileText, Search } from 'lucide-react'
import { downloadReportExport } from '@/lib/reports/download-export'
import { EmailReportButton } from '@/components/reports/EmailReportButton'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import { formatCurrency } from '@/lib/utils'

type PaymentRow = {
  id: string
  provider: string
  providerPaymentId: string
  providerInvoiceId: string
  providerRealmId: string | null
  customerName: string
  invoiceId: string | null
  invoiceNumber: string
  amount: number
  currency: string
  paymentMethod: string
  status: string
  refundStatus: string
  refundedAmount: number
  createdAt: string
  refundedAt: string | null
}

type PaymentsSummary = {
  totalAmount: number
  totalRefunded: number
  succeededCount: number
  failedCount: number
}

type PageResponse = {
  payments: PaymentRow[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  summary: PaymentsSummary
}

type RefundModalState = {
  open: boolean
  payment: PaymentRow | null
  fullRefund: boolean
  partialAmount: string
  reason: string
  submitting: boolean
}

export default function PaymentHistoryPage() {
  const { permissions } = usePermissions()
  const canRefund =
    hasPermission(permissions, 'payments.refund') ||
    hasPermission(permissions, 'payments.manage')
  const canManagePayments = hasPermission(permissions, 'payments.manage')
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null)

  const [rows, setRows] = useState<PaymentRow[]>([])
  const [summary, setSummary] = useState<PaymentsSummary>({ totalAmount: 0, totalRefunded: 0, succeededCount: 0, failedCount: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [limit] = useState(25)
  const [totalPages, setTotalPages] = useState(1)
  const [search, setSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const [refundModal, setRefundModal] = useState<RefundModalState>({
    open: false,
    payment: null,
    fullRefund: true,
    partialAmount: '',
    reason: '',
    submitting: false,
  })

  const fetchHistory = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        window.location.href = '/auth/login'
        return
      }

      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      })
      if (search.trim()) params.set('q', search.trim())
      if (providerFilter !== 'all') params.set('provider', providerFilter)
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)

      const res = await fetch(`/api/payments/history?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        window.location.href = '/auth/login'
        return
      }
      const data: PageResponse & { error?: string } = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load payment history')
      }
      setRows(data.payments || [])
      setTotalPages(data.pagination?.totalPages || 1)
      setSummary(data.summary || { totalAmount: 0, totalRefunded: 0, succeededCount: 0, failedCount: 0 })
    } catch (err: any) {
      setError(err?.message || 'Failed to load payment history')
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, providerFilter, statusFilter, startDate, endDate])

  useEffect(() => {
    void fetchHistory()
  }, [fetchHistory])

  const [exporting, setExporting] = useState(false)

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('q', search.trim())
    if (providerFilter !== 'all') params.set('provider', providerFilter)
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)
    return params
  }, [search, providerFilter, statusFilter, startDate, endDate])

  const handleExport = async (format: 'csv' | 'pdf') => {
    setExporting(true)
    try {
      const params = buildQuery()
      params.set('format', format)
      await downloadReportExport(`/api/payments/history?${params.toString()}`, `payment-history.${format}`)
    } catch {
      alert(`Failed to export ${format.toUpperCase()}`)
    } finally {
      setExporting(false)
    }
  }

  const openRefundModal = (payment: PaymentRow) => {
    setRefundModal({
      open: true,
      payment,
      fullRefund: true,
      partialAmount: '',
      reason: '',
      submitting: false,
    })
  }

  const closeRefundModal = () => {
    setRefundModal((prev) => ({ ...prev, open: false, payment: null }))
  }

  const refundableRemaining = useMemo(() => {
    if (!refundModal.payment) return 0
    return Math.max(0, Number(refundModal.payment.amount || 0) - Number(refundModal.payment.refundedAmount || 0))
  }, [refundModal.payment])

  const displayStatus = (status: string) => {
    const s = String(status || '').toUpperCase()
    if (s === 'COMPLETED') return 'Succeeded'
    if (s === 'REFUNDED') return 'Refunded'
    if (s === 'FAILED') return 'Failed'
    if (s === 'PENDING' || s === 'PROCESSING') return 'Pending'
    return s || 'Unknown'
  }

  const deletePayment = async (row: PaymentRow) => {
    if (!canManagePayments) return
    const confirmed = window.confirm(
      `Delete payment ${row.id} (${row.currency} ${Number(row.amount || 0).toFixed(2)})?\n\n` +
        'This removes it from TrimPro and recalculates the invoice. Gateway/QuickBooks may still need a separate void/refund.'
    )
    if (!confirmed) return

    setDeletingPaymentId(row.id)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        window.location.href = '/auth/login'
        return
      }
      const res = await fetch(`/api/payments/${row.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Delete failed')
      }
      await fetchHistory()
    } catch (err: any) {
      alert(err?.message || 'Delete failed')
    } finally {
      setDeletingPaymentId(null)
    }
  }

  const submitRefund = async () => {
    if (!refundModal.payment) return
    const amount = refundModal.fullRefund ? refundableRemaining : Number(refundModal.partialAmount || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Refund amount must be greater than 0.')
      return
    }
    if (amount > refundableRemaining) {
      alert(`Refund amount exceeds remaining refundable amount (${refundableRemaining.toFixed(2)}).`)
      return
    }

    setRefundModal((prev) => ({ ...prev, submitting: true }))
    try {
      const token = localStorage.getItem('accessToken')
      const idempotencyKey = `refund:${refundModal.payment.id}:${amount.toFixed(2)}:${Date.now()}`
      const res = await fetch('/api/payments/refund', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          paymentId: refundModal.payment.id,
          fullRefund: refundModal.fullRefund,
          partialAmount: refundModal.fullRefund ? null : amount,
          reason: refundModal.reason || null,
          idempotencyKey,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Refund failed')
      }
      alert('Refund processed successfully.')
      closeRefundModal()
      await fetchHistory()
    } catch (err: any) {
      alert(err?.message || 'Refund failed')
    } finally {
      setRefundModal((prev) => ({ ...prev, submitting: false }))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/reports">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Reports
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Payment History</h1>
            <p className="text-gray-600 mt-1">SOLA + QuickBooks ACH payment events and refunds</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('csv')}>
            <Download className="mr-2 h-4 w-4" /> CSV
          </Button>
          <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('pdf')}>
            <FileText className="mr-2 h-4 w-4" /> PDF
          </Button>
          <EmailReportButton report="payments" params={Object.fromEntries(buildQuery())} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Filter by date range, provider, status, or search</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div className="md:col-span-2">
              <Label>Search</Label>
              <div className="relative mt-1">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  className="pl-8"
                  value={search}
                  onChange={(e) => {
                    setPage(1)
                    setSearch(e.target.value)
                  }}
                  placeholder="Invoice, customer, payment ID"
                />
              </div>
            </div>
            <div>
              <Label>Provider</Label>
              <Select
                value={providerFilter}
                onValueChange={(v) => {
                  setPage(1)
                  setProviderFilter(v)
                }}
              >
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="sola">SOLA</SelectItem>
                  <SelectItem value="quickbooks">QuickBooks</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setPage(1)
                  setStatusFilter(v)
                }}
              >
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="COMPLETED">Succeeded</SelectItem>
                  <SelectItem value="REFUNDED">Refunded</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button onClick={() => void fetchHistory()}>Apply</Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Start Date</Label>
              <Input type="date" className="mt-1" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>End Date</Label>
              <Input type="date" className="mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {!loading && !error && (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-gray-500">Total Amount</div>
              <div className="text-xl font-bold">{formatCurrency(summary.totalAmount)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-gray-500">Total Refunded</div>
              <div className="text-xl font-bold text-blue-700">{formatCurrency(summary.totalRefunded)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-gray-500">Succeeded</div>
              <div className="text-xl font-bold text-green-700">{summary.succeededCount}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-gray-500">Failed</div>
              <div className="text-xl font-bold text-red-600">{summary.failedCount}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Payments</CardTitle>
          <CardDescription>Production payment ledger with refund tracking</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-10 text-center text-gray-500">Loading payment history...</div>
          ) : error ? (
            <div className="py-10 text-center text-red-600">{error}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="p-2">Internal Payment ID</th>
                    <th className="p-2">Provider</th>
                    <th className="p-2">Provider Payment ID</th>
                    <th className="p-2">Provider Invoice ID</th>
                    <th className="p-2">Customer Name</th>
                    <th className="p-2">Invoice Number</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2">Payment Method</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Refund Status</th>
                    <th className="p-2">Created At</th>
                    <th className="p-2">Refunded At</th>
                    <th className="p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const fullyRefunded = row.refundStatus === 'FULLY_REFUNDED'
                    const isCardPayment = row.paymentMethod === 'CARD'
                    return (
                      <tr key={row.id} className="border-b">
                        <td className="p-2 font-mono text-xs">{row.id}</td>
                        <td className="p-2">{row.provider}</td>
                        <td className="p-2 font-mono text-xs">{row.providerPaymentId || '-'}</td>
                        <td className="p-2 font-mono text-xs">{row.providerInvoiceId || '-'}</td>
                        <td className="p-2">{row.customerName}</td>
                        <td className="p-2">{row.invoiceNumber}</td>
                        <td className="p-2 text-right">{row.currency} {Number(row.amount || 0).toFixed(2)}</td>
                        <td className="p-2">{row.paymentMethod}</td>
                        <td className="p-2">{displayStatus(row.status)}</td>
                        <td className="p-2">
                          {row.refundStatus}
                          {row.refundedAmount > 0 ? ` ($${row.refundedAmount.toFixed(2)})` : ''}
                        </td>
                        <td className="p-2">{new Date(row.createdAt).toLocaleString()}</td>
                        <td className="p-2">{row.refundedAt ? new Date(row.refundedAt).toLocaleString() : '-'}</td>
                        <td className="p-2">
                          <div className="flex flex-wrap gap-2">
                            {canRefund && isCardPayment ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={fullyRefunded}
                                onClick={() => openRefundModal(row)}
                              >
                                Refund
                              </Button>
                            ) : null}
                            {canManagePayments ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-red-700 border-red-200 hover:bg-red-50"
                                disabled={deletingPaymentId === row.id || row.refundedAmount > 0}
                                onClick={() => void deletePayment(row)}
                              >
                                {deletingPaymentId === row.id ? 'Deleting...' : 'Delete'}
                              </Button>
                            ) : null}
                            {!canRefund && !canManagePayments ? (
                              <span className="text-xs text-gray-400">No access</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {rows.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="p-2" colSpan={6}>Total (this page)</td>
                      <td className="p-2 text-right">
                        {formatCurrency(rows.reduce((s, r) => s + Number(r.amount || 0), 0))}
                      </td>
                      <td className="p-2" colSpan={5}></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-gray-500">Page {page} of {totalPages}</div>
            <div className="flex gap-2">
              <Button variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              <Button
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {refundModal.open && refundModal.payment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold">Refund Payment</h2>
            <p className="mt-1 text-sm text-gray-600">
              Payment: {refundModal.payment.id}{' \u2022 '}Remaining refundable: ${refundableRemaining.toFixed(2)}
            </p>

            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={refundModal.fullRefund}
                  onChange={(e) => setRefundModal((prev) => ({ ...prev, fullRefund: e.target.checked }))}
                />
                Refund full amount
              </label>

              {!refundModal.fullRefund && (
                <div>
                  <Label>Partial Refund Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={refundableRemaining}
                    value={refundModal.partialAmount}
                    onChange={(e) => setRefundModal((prev) => ({ ...prev, partialAmount: e.target.value }))}
                  />
                </div>
              )}

              <div>
                <Label>Reason</Label>
                <textarea
                  value={refundModal.reason}
                  onChange={(e) => setRefundModal((prev) => ({ ...prev, reason: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm"
                  rows={3}
                  placeholder="Refund reason (optional but recommended)"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={closeRefundModal} disabled={refundModal.submitting}>
                Cancel
              </Button>
              <Button onClick={() => void submitRefund()} disabled={refundModal.submitting}>
                {refundModal.submitting ? 'Processing...' : 'Confirm Refund'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

