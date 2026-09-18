'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatCurrency } from '@/lib/utils'
import { downloadReportExport } from '@/lib/reports/download-export'
import { ReportFilterBar } from '@/components/reports/ReportFilterBar'
import { EmailReportButton } from '@/components/reports/EmailReportButton'
import type { PickerClient } from '@/lib/clients/fetch-all-picker-clients'

type JobRow = {
  jobId: string
  jobNumber: string
  title: string
  status: string
  clientName: string
  revenue: number
  laborCost: number
  materialCost: number
  totalCost: number
  profit: number
  marginPercent: number | null
  poSpend: number
  hoursLogged: number
  hasCostData: boolean
}

type ProfitabilityResponse = {
  rows: JobRow[]
  totals: { revenue: number; laborCost: number; materialCost: number; profit: number }
  jobsMissingCostData: number
}

export default function JobProfitabilityReportPage() {
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [clientId, setClientId] = useState('')
  const [jobSiteAddress, setJobSiteAddress] = useState('')
  const [hideSubClients, setHideSubClients] = useState(true)
  const [selectedClient, setSelectedClient] = useState<PickerClient | null>(null)
  const [data, setData] = useState<ProfitabilityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const buildQuery = () => {
    const params = new URLSearchParams()
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)
    if (clientId) params.set('clientId', clientId)
    if (jobSiteAddress) params.set('jobSiteAddress', jobSiteAddress)
    params.set('hideSubClients', String(hideSubClients))
    return params
  }

  useEffect(() => {
    setLoading(true)
    setError(null)
    const token = localStorage.getItem('accessToken')
    fetch(`/api/reports/job-profitability?${buildQuery().toString()}`, {
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
  }, [startDate, endDate, clientId, jobSiteAddress, hideSubClients])

  const handleExport = async (format: 'csv' | 'pdf') => {
    setExporting(true)
    try {
      const params = buildQuery()
      params.set('format', format)
      await downloadReportExport(`/api/reports/job-profitability?${params.toString()}`, `job-profitability.${format}`)
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
          <h1 className="text-2xl font-bold text-gray-900">Job Profitability</h1>
          <p className="text-sm text-gray-500">Revenue vs. labor and material cost per job</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-end gap-4">
            <div>
              <Label>Start Date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label>End Date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('csv')}>
              <Download className="h-4 w-4 mr-1" /> CSV
            </Button>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('pdf')}>
              <FileText className="h-4 w-4 mr-1" /> PDF
            </Button>
            <EmailReportButton
              report="job-profitability"
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
          {data.jobsMissingCostData > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                {data.jobsMissingCostData} job{data.jobsMissingCostData === 1 ? '' : 's'} in this period {data.jobsMissingCostData === 1 ? 'has' : 'have'} no
                labor/material cost entered — margin shown as "—" for those. Enter costs on the job edit page for accurate profitability.
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Total Revenue</div>
                <div className="text-xl font-bold">{formatCurrency(data.totals.revenue)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Labor Cost</div>
                <div className="text-xl font-bold">{formatCurrency(data.totals.laborCost)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Material Cost</div>
                <div className="text-xl font-bold">{formatCurrency(data.totals.materialCost)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Total Profit</div>
                <div className={`text-xl font-bold ${data.totals.profit < 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {formatCurrency(data.totals.profit)}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>By Job</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-2 pr-3">Job #</th>
                      <th className="py-2 pr-3">Customer</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3 text-right">Revenue</th>
                      <th className="py-2 pr-3 text-right">Labor</th>
                      <th className="py-2 pr-3 text-right">Material</th>
                      <th className="py-2 pr-3 text-right">PO Spend</th>
                      <th className="py-2 pr-3 text-right">Hours</th>
                      <th className="py-2 pr-3 text-right">Profit</th>
                      <th className="py-2 pr-3 text-right">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-6 text-center text-gray-400">
                          No jobs in this period
                        </td>
                      </tr>
                    ) : (
                      data.rows.map((r) => (
                        <tr key={r.jobId} className="border-b last:border-0">
                          <td className="py-2 pr-3">
                            <Link href={`/dashboard/jobs/${r.jobId}`} className="text-blue-600 hover:underline">
                              {r.jobNumber}
                            </Link>
                          </td>
                          <td className="py-2 pr-3">{r.clientName}</td>
                          <td className="py-2 pr-3">{r.status}</td>
                          <td className="py-2 pr-3 text-right">{formatCurrency(r.revenue)}</td>
                          <td className="py-2 pr-3 text-right">{formatCurrency(r.laborCost)}</td>
                          <td className="py-2 pr-3 text-right">{formatCurrency(r.materialCost)}</td>
                          <td className="py-2 pr-3 text-right text-gray-500">{formatCurrency(r.poSpend)}</td>
                          <td className="py-2 pr-3 text-right text-gray-500">{r.hoursLogged.toFixed(1)}</td>
                          <td className={`py-2 pr-3 text-right font-medium ${r.profit < 0 ? 'text-red-600' : ''}`}>
                            {formatCurrency(r.profit)}
                          </td>
                          <td className="py-2 pr-3 text-right">{r.marginPercent === null ? '—' : `${r.marginPercent.toFixed(1)}%`}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {data.rows.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2 pr-3" colSpan={3}>Total</td>
                        <td className="py-2 pr-3 text-right">{formatCurrency(data.totals.revenue)}</td>
                        <td className="py-2 pr-3 text-right">{formatCurrency(data.totals.laborCost)}</td>
                        <td className="py-2 pr-3 text-right">{formatCurrency(data.totals.materialCost)}</td>
                        <td className="py-2 pr-3 text-right text-gray-500">
                          {formatCurrency(data.rows.reduce((s, r) => s + r.poSpend, 0))}
                        </td>
                        <td className="py-2 pr-3 text-right text-gray-500">
                          {data.rows.reduce((s, r) => s + r.hoursLogged, 0).toFixed(1)}
                        </td>
                        <td className={`py-2 pr-3 text-right ${data.totals.profit < 0 ? 'text-red-600' : ''}`}>
                          {formatCurrency(data.totals.profit)}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {data.totals.revenue > 0 ? `${((data.totals.profit / data.totals.revenue) * 100).toFixed(1)}%` : '—'}
                        </td>
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
