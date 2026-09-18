'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, FileText, TrendingDown, TrendingUp } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatCurrency } from '@/lib/utils'
import { downloadReportExport } from '@/lib/reports/download-export'
import { ReportFilterBar } from '@/components/reports/ReportFilterBar'
import { EmailReportButton } from '@/components/reports/EmailReportButton'
import type { PickerClient } from '@/lib/clients/fetch-all-picker-clients'

type RevenueRow = { month: string; invoiced: number; collected: number }
type RevenueResponse = {
  rows: RevenueRow[]
  summary: { totalInvoiced: number; totalCollected: number; prevInvoiced: number; changePercent: number | null }
}

export default function RevenueReportPage() {
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [clientId, setClientId] = useState('')
  const [jobSiteAddress, setJobSiteAddress] = useState('')
  const [hideSubClients, setHideSubClients] = useState(true)
  const [selectedClient, setSelectedClient] = useState<PickerClient | null>(null)
  const [data, setData] = useState<RevenueResponse | null>(null)
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
    fetch(`/api/reports/revenue?${buildQuery().toString()}`, {
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
      await downloadReportExport(`/api/reports/revenue?${params.toString()}`, `revenue-report.${format}`)
    } catch {
      alert(`Failed to export ${format.toUpperCase()}`)
    } finally {
      setExporting(false)
    }
  }

  const change = data?.summary.changePercent

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/reports">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Revenue by Month</h1>
          <p className="text-sm text-gray-500">Invoiced vs. collected revenue, compared to the prior period</p>
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
            <p className="text-xs text-gray-400 pb-2">Defaults to trailing 12 months</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('csv')}>
              <Download className="h-4 w-4 mr-1" /> CSV
            </Button>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('pdf')}>
              <FileText className="h-4 w-4 mr-1" /> PDF
            </Button>
            <EmailReportButton
              report="revenue"
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
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Total Invoiced</div>
                <div className="text-xl font-bold">{formatCurrency(data.summary.totalInvoiced)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">Total Collected</div>
                <div className="text-xl font-bold text-green-700">{formatCurrency(data.summary.totalCollected)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-gray-500">vs. Prior Period</div>
                <div className={`text-xl font-bold flex items-center gap-1 ${change !== null && change !== undefined && change < 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {change === null || change === undefined ? (
                    'N/A'
                  ) : (
                    <>
                      {change >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                      {change >= 0 ? '+' : ''}
                      {change.toFixed(1)}%
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Monthly Revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <div style={{ width: '100%', height: 320 }}>
                <ResponsiveContainer>
                  <BarChart data={data.rows}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Legend />
                    <Bar dataKey="invoiced" name="Invoiced" fill="#2563eb" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="collected" name="Collected" fill="#16a34a" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-2 px-4">Month</th>
                      <th className="py-2 px-4 text-right">Invoiced</th>
                      <th className="py-2 px-4 text-right">Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.month} className="border-b last:border-0">
                        <td className="py-2 px-4">{r.month}</td>
                        <td className="py-2 px-4 text-right">{formatCurrency(r.invoiced)}</td>
                        <td className="py-2 px-4 text-right">{formatCurrency(r.collected)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="py-2 px-4">Total</td>
                      <td className="py-2 px-4 text-right">{formatCurrency(data.summary.totalInvoiced)}</td>
                      <td className="py-2 px-4 text-right">{formatCurrency(data.summary.totalCollected)}</td>
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
