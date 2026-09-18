'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, Download, FileText, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { Checkbox } from '@/components/ui/checkbox'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { downloadReportExport } from '@/lib/reports/download-export'
import { EmailReportButton } from '@/components/reports/EmailReportButton'

type LedgerRow = {
  date: string
  type: 'INVOICE' | 'PAYMENT' | 'CREDIT_MEMO'
  description: string
  reference: string
  debit: number
  credit: number
  balance: number
  invoiceBalance?: number
  invoiceStatus?: string
}

type LedgerFilter = 'all' | 'invoices' | 'open' | 'payments' | 'credits'
const LEDGER_FILTERS: Array<{ key: LedgerFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'open', label: 'Open Invoices' },
  { key: 'payments', label: 'Payments' },
  { key: 'credits', label: 'Credit Memos' },
]

type StatementResponse = {
  client: { id: string; name: string; companyName: string | null }
  ledger: LedgerRow[]
  summary: {
    totalInvoiced: number
    totalPaid: number
    totalCredited: number
    balance: number
    invoiceCount: number
  }
}

const TYPE_LABEL: Record<LedgerRow['type'], string> = {
  INVOICE: 'Invoice',
  PAYMENT: 'Payment',
  CREDIT_MEMO: 'Credit Memo',
}

export default function CustomerStatementReportPage() {
  const searchParams = useSearchParams()
  const [clients, setClients] = useState<PickerClient[]>([])
  const [clientId, setClientId] = useState(searchParams.get('clientId') || '')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [jobSiteAddress, setJobSiteAddress] = useState('')
  const [hideSubClients, setHideSubClients] = useState(true)
  const [data, setData] = useState<StatementResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ledgerFilter, setLedgerFilter] = useState<LedgerFilter>('all')

  const selectedClient = clients.find((c) => c.id === clientId) || null
  const filteredLedger = (data?.ledger || []).filter((row) => {
    if (ledgerFilter === 'all') return true
    if (ledgerFilter === 'invoices') return row.type === 'INVOICE'
    if (ledgerFilter === 'open') return row.type === 'INVOICE' && Number(row.invoiceBalance || 0) > 0.01
    if (ledgerFilter === 'payments') return row.type === 'PAYMENT'
    if (ledgerFilter === 'credits') return row.type === 'CREDIT_MEMO'
    return true
  })

  useEffect(() => {
    fetchAllPickerClients()
      .then(setClients)
      .catch(() => setError('Failed to load clients'))
  }, [])

  const buildQuery = () => {
    const params = new URLSearchParams({ clientId })
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)
    if (jobSiteAddress) params.set('jobSiteAddress', jobSiteAddress)
    params.set('hideSubClients', String(hideSubClients))
    return params
  }

  useEffect(() => {
    if (!clientId) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    const token = localStorage.getItem('accessToken')
    fetch(`/api/reports/customer-statement?${buildQuery().toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to load statement')
        return res.json()
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, startDate, endDate, jobSiteAddress, hideSubClients])

  const handleExport = async (format: 'csv' | 'pdf') => {
    if (!clientId || !data) return
    setExporting(true)
    try {
      const params = buildQuery()
      params.set('format', format)
      await downloadReportExport(
        `/api/reports/customer-statement?${params.toString()}`,
        `statement-${data.client.name}.${format}`
      )
    } catch {
      alert(`Failed to export ${format.toUpperCase()}`)
    } finally {
      setExporting(false)
    }
  }

  const handlePrint = async () => {
    if (!clientId) return
    const params = buildQuery()
    params.set('format', 'html')
    const token = localStorage.getItem('accessToken')
    const res = await fetch(`/api/reports/customer-statement?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const html = await res.text()
    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      alert('Popup blocked. Please allow popups to print.')
      return
    }
    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.addEventListener('load', () => printWindow.print())
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/reports">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Customer Statement</h1>
          <p className="text-sm text-gray-500">Invoices, payments applied, and running balance for a customer</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-4">
          <div>
            <Label>Customer *</Label>
            <SearchableClientSelect clients={clients} value={clientId} onSelect={setClientId} placeholder="Select a customer..." />
          </div>
          <div>
            <Label>Start Date</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <Label>End Date</Label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div>
            <Label>Job Site Address</Label>
            <Input
              value={jobSiteAddress}
              onChange={(e) => setJobSiteAddress(e.target.value)}
              placeholder="Street, city, state, or zip"
            />
          </div>
          <div className="flex items-center gap-2 pt-6 sm:col-span-4">
            <Checkbox
              id="hideSubClients"
              checked={hideSubClients}
              onCheckedChange={(v) => setHideSubClients(v === true)}
            />
            <Label htmlFor="hideSubClients" className="!mb-0 cursor-pointer font-normal">
              Include this customer's sub-customers, consolidated into one statement
            </Label>
          </div>
        </CardContent>
      </Card>

      {error && <div className="text-sm text-red-600">{error}</div>}
      {loading && <div className="text-sm text-gray-500">Loading statement...</div>}

      {data && !loading && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Total Invoiced</div>
                <div className="text-xl font-bold">${data.summary.totalInvoiced.toFixed(2)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Total Paid</div>
                <div className="text-xl font-bold text-green-700">${data.summary.totalPaid.toFixed(2)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Total Credited</div>
                <div className="text-xl font-bold text-blue-700">${data.summary.totalCredited.toFixed(2)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Balance Due</div>
                <div className={`text-xl font-bold ${data.summary.balance > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                  ${data.summary.balance.toFixed(2)}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Transaction Ledger</CardTitle>
                <CardDescription>{data.client.companyName || data.client.name}</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handlePrint}>
                  <Printer className="h-4 w-4 mr-1" /> Print
                </Button>
                <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('csv')}>
                  <Download className="h-4 w-4 mr-1" /> CSV
                </Button>
                <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('pdf')}>
                  <FileText className="h-4 w-4 mr-1" /> PDF
                </Button>
                <EmailReportButton
                  report="customer-statement"
                  params={Object.fromEntries(buildQuery())}
                  defaultRecipient={selectedClient?.email || ''}
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {LEDGER_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setLedgerFilter(f.key)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                      ledgerFilter === f.key
                        ? 'bg-gray-900 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Reference</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3 text-right">Debit</th>
                      <th className="py-2 pr-3 text-right">Credit</th>
                      <th className="py-2 pr-3 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLedger.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-6 text-center text-gray-400">
                          {data.ledger.length === 0 ? 'No transactions in this period' : 'No transactions match this filter'}
                        </td>
                      </tr>
                    ) : (
                      filteredLedger.map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-2 pr-3">{new Date(row.date).toLocaleDateString()}</td>
                          <td className="py-2 pr-3">{TYPE_LABEL[row.type]}</td>
                          <td className="py-2 pr-3">{row.reference}</td>
                          <td className="py-2 pr-3">{row.description}</td>
                          <td className="py-2 pr-3 text-right">{row.debit ? `$${row.debit.toFixed(2)}` : ''}</td>
                          <td className="py-2 pr-3 text-right">{row.credit ? `$${row.credit.toFixed(2)}` : ''}</td>
                          <td className="py-2 pr-3 text-right font-medium">${row.balance.toFixed(2)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {ledgerFilter === 'all' && data.ledger.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2 pr-3" colSpan={4}>Total</td>
                        <td className="py-2 pr-3 text-right">${data.summary.totalInvoiced.toFixed(2)}</td>
                        <td className="py-2 pr-3 text-right">${(data.summary.totalPaid + data.summary.totalCredited).toFixed(2)}</td>
                        <td className="py-2 pr-3 text-right">${data.summary.balance.toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  )}
                  {ledgerFilter !== 'all' && filteredLedger.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2 pr-3" colSpan={4}>
                          {LEDGER_FILTERS.find((f) => f.key === ledgerFilter)?.label} total
                        </td>
                        <td className="py-2 pr-3 text-right">
                          ${filteredLedger.reduce((sum, r) => sum + r.debit, 0).toFixed(2)}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          ${filteredLedger.reduce((sum, r) => sum + r.credit, 0).toFixed(2)}
                        </td>
                        <td className="py-2 pr-3 text-right text-gray-400">—</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
