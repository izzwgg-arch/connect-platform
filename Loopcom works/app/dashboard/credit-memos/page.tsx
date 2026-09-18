'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Plus, Search, Download } from 'lucide-react'
import Link from 'next/link'

interface CreditMemoRow {
  id: string
  creditMemoNumber: string
  title: string
  status: string
  total: number
  remainingCredit: number
  appliedAmount: number
  creditMemoDate: string
  client?: { id: string; name: string; companyName?: string | null } | null
  job?: { id: string; jobNumber: string; title?: string | null } | null
  sourceInvoice?: { id: string; invoiceNumber: string } | null
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  PARTIALLY_APPLIED: 'bg-yellow-100 text-yellow-800',
  APPLIED: 'bg-green-100 text-green-800',
  VOID: 'bg-red-100 text-red-800',
}

export default function CreditMemosPage() {
  const router = useRouter()
  const [rows, setRows] = useState<CreditMemoRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [qboImporting, setQboImporting] = useState(false)

  const fetchRows = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({ limit: '100' })
      if (search.trim()) params.set('search', search.trim())
      if (status !== 'all') params.set('status', status)
      const response = await fetch(`/api/credit-memos?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!response.ok) throw new Error('Failed to load credit memos')
      const data = await response.json()
      setRows(data.creditMemos || [])
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const handleImportFromQuickBooks = async () => {
    if (
      !confirm(
        'Import open credit memos from QuickBooks?\n\n' +
          '• Creates local credit memos for QB credits with remaining balance\n' +
          '• Updates already-imported credit memos\n' +
          '• Customers must already be mapped in TrimPro'
      )
    ) {
      return
    }
    setQboImporting(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch('/api/credit-memos/import-quickbooks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'QuickBooks credit memo import failed.')
        return
      }
      alert(
        [
          `QuickBooks credit memos: ${data.fetchedFromQuickBooks || 0} fetched.`,
          `Created ${data.created || 0}, updated ${data.updated || 0}.`,
          data.skippedMissingClient
            ? `Skipped ${data.skippedMissingClient} (no client mapping).`
            : null,
          data.skippedZeroBalance
            ? `Skipped ${data.skippedZeroBalance} fully applied.`
            : null,
        ]
          .filter(Boolean)
          .join(' ')
      )
      if (Array.isArray(data.errors) && data.errors.length) {
        console.warn('Credit memo import errors:', data.errors)
      }
      await fetchRows()
    } catch (e) {
      console.error(e)
      alert('QuickBooks credit memo import failed.')
    } finally {
      setQboImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Credit Memos</h1>
          <p className="mt-1 text-gray-600">Issue and apply customer credits</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void handleImportFromQuickBooks()}
            disabled={qboImporting}
          >
            <Download className="mr-2 h-4 w-4" />
            {qboImporting ? 'Importing…' : 'Import from QuickBooks'}
          </Button>
          <Link href="/dashboard/credit-memos/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Credit Memo
            </Button>
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              className="pl-9"
              placeholder="Search credit memos..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') fetchRows()
              }}
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="SENT">Sent</SelectItem>
              <SelectItem value="PARTIALLY_APPLIED">Partially applied</SelectItem>
              <SelectItem value="APPLIED">Applied</SelectItem>
              <SelectItem value="VOID">Void</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={fetchRows}>
            Search
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No credit memos found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="px-4 py-3 text-left">Number</th>
                    <th className="px-4 py-3 text-left">Client</th>
                    <th className="px-4 py-3 text-left">Job</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-right">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b hover:bg-gray-50 cursor-pointer"
                      onClick={() => router.push(`/dashboard/credit-memos/${row.id}`)}
                    >
                      <td className="px-4 py-3 font-medium">{row.creditMemoNumber}</td>
                      <td className="px-4 py-3">
                        {row.client?.companyName || row.client?.name || '—'}
                      </td>
                      <td className="px-4 py-3">
                        {row.job
                          ? `${row.job.jobNumber}${row.job.title ? ` — ${row.job.title}` : ''}`
                          : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            statusColors[row.status] || 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {row.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3">{formatDate(row.creditMemoDate)}</td>
                      <td className="px-4 py-3 text-right">{formatCurrency(row.total)}</td>
                      <td className="px-4 py-3 text-right">{formatCurrency(row.remainingCredit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
