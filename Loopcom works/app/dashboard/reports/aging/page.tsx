'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { downloadReportExport } from '@/lib/reports/download-export'
import { ReportFilterBar } from '@/components/reports/ReportFilterBar'
import { EmailReportButton } from '@/components/reports/EmailReportButton'
import type { PickerClient } from '@/lib/clients/fetch-all-picker-clients'

const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const
type Bucket = (typeof BUCKETS)[number]
const BUCKET_LABEL: Record<Bucket, string> = {
  current: 'Current',
  '1-30': '1-30 Days',
  '31-60': '31-60 Days',
  '61-90': '61-90 Days',
  '90+': '90+ Days',
}

type ClientAging = {
  clientId: string
  clientName: string
  buckets: Record<Bucket, number>
  total: number
}

type AgingResponse = {
  byClient: ClientAging[]
  bucketTotals: Record<Bucket, number>
  grandTotal: number
  asOf: string
}

export default function AgingReportPage() {
  const [asOf, setAsOf] = useState('')
  const [clientId, setClientId] = useState('')
  const [jobSiteAddress, setJobSiteAddress] = useState('')
  const [hideSubClients, setHideSubClients] = useState(true)
  const [selectedClient, setSelectedClient] = useState<PickerClient | null>(null)
  const [data, setData] = useState<AgingResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const buildQuery = () => {
    const params = new URLSearchParams()
    if (asOf) params.set('asOf', asOf)
    if (clientId) params.set('clientId', clientId)
    if (jobSiteAddress) params.set('jobSiteAddress', jobSiteAddress)
    params.set('hideSubClients', String(hideSubClients))
    return params
  }

  useEffect(() => {
    setLoading(true)
    setError(null)
    const token = localStorage.getItem('accessToken')
    fetch(`/api/reports/aging?${buildQuery().toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to load report')
        return res.json()
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf, clientId, jobSiteAddress, hideSubClients])

  const handleExport = async (format: 'csv' | 'pdf') => {
    setExporting(true)
    try {
      const params = buildQuery()
      params.set('format', format)
      await downloadReportExport(`/api/reports/aging?${params.toString()}`, `aging-report.${format}`)
    } catch {
      alert(`Failed to export ${format.toUpperCase()}`)
    } finally {
      setExporting(false)
    }
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
          <h1 className="text-2xl font-bold text-gray-900">Invoices Aging</h1>
          <p className="text-sm text-gray-500">Outstanding balances by how overdue they are</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <Label>As of date</Label>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('csv')}>
              <Download className="h-4 w-4 mr-1" /> CSV
            </Button>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('pdf')}>
              <FileText className="h-4 w-4 mr-1" /> PDF
            </Button>
            <EmailReportButton
              report="aging"
              params={Object.fromEntries(buildQuery())}
              defaultRecipient={selectedClient?.email || ''}
            />
          </div>
        </CardHeader>
        <CardContent>
          <ReportFilterBar
            clientId={clientId}
            onClientChange={setClientId}
            jobSiteAddress={jobSiteAddress}
            onJobSiteAddressChange={setJobSiteAddress}
            hideSubClients={hideSubClients}
            onHideSubClientsChange={setHideSubClients}
            onClientResolved={setSelectedClient}
          />
        </CardContent>
      </Card>

      {error && <div className="text-sm text-red-600">{error}</div>}
      {loading && <div className="text-sm text-gray-500">Loading...</div>}

      {data && !loading && (
        <>
          <div className="grid gap-4 sm:grid-cols-5">
            {BUCKETS.map((b) => (
              <Card key={b}>
                <CardContent className="p-4">
                  <div className="text-xs text-gray-500">{BUCKET_LABEL[b]}</div>
                  <div className={`text-xl font-bold ${b === '90+' ? 'text-red-600' : b === '61-90' ? 'text-orange-600' : ''}`}>
                    ${data.bucketTotals[b].toFixed(2)}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>By Customer</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-2 pr-3">Customer</th>
                      {BUCKETS.map((b) => (
                        <th key={b} className="py-2 pr-3 text-right">
                          {BUCKET_LABEL[b]}
                        </th>
                      ))}
                      <th className="py-2 pr-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byClient.length === 0 ? (
                      <tr>
                        <td colSpan={BUCKETS.length + 2} className="py-6 text-center text-gray-400">
                          No outstanding balances
                        </td>
                      </tr>
                    ) : (
                      data.byClient.map((c) => (
                        <tr key={c.clientId} className="border-b last:border-0">
                          <td className="py-2 pr-3">
                            <Link href={`/dashboard/reports/customer-statement?clientId=${c.clientId}`} className="text-blue-600 hover:underline">
                              {c.clientName}
                            </Link>
                          </td>
                          {BUCKETS.map((b) => (
                            <td key={b} className="py-2 pr-3 text-right">
                              {c.buckets[b] ? `$${c.buckets[b].toFixed(2)}` : ''}
                            </td>
                          ))}
                          <td className="py-2 pr-3 text-right font-medium">${c.total.toFixed(2)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="py-2 pr-3">Total</td>
                      {BUCKETS.map((b) => (
                        <td key={b} className="py-2 pr-3 text-right">
                          ${data.bucketTotals[b].toFixed(2)}
                        </td>
                      ))}
                      <td className="py-2 pr-3 text-right">${data.grandTotal.toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
