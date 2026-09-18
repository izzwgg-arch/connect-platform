'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, FileText } from 'lucide-react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatCurrency } from '@/lib/utils'
import { downloadReportExport } from '@/lib/reports/download-export'
import { ReportFilterBar } from '@/components/reports/ReportFilterBar'
import { EmailReportButton } from '@/components/reports/EmailReportButton'
import type { PickerClient } from '@/lib/clients/fetch-all-picker-clients'

type VendorRow = { vendorKey: string; vendorName: string; poCount: number; total: number }
type VendorSpendResponse = { byVendor: VendorRow[]; grandTotal: number }

const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#8b5cf6', '#0891b2', '#db2777', '#65a30d']

export default function VendorSpendReportPage() {
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [clientId, setClientId] = useState('')
  const [jobSiteAddress, setJobSiteAddress] = useState('')
  const [hideSubClients, setHideSubClients] = useState(true)
  const [selectedClient, setSelectedClient] = useState<PickerClient | null>(null)
  const [data, setData] = useState<VendorSpendResponse | null>(null)
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
    fetch(`/api/reports/vendor-spend?${buildQuery().toString()}`, {
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
      await downloadReportExport(`/api/reports/vendor-spend?${params.toString()}`, `vendor-spend.${format}`)
    } catch {
      alert(`Failed to export ${format.toUpperCase()}`)
    } finally {
      setExporting(false)
    }
  }

  const top8 = data?.byVendor.slice(0, 8) || []

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/reports">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Vendor Spend</h1>
          <p className="text-sm text-gray-500">Purchase order spend by vendor (approved, ordered, or received POs)</p>
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
              report="vendor-spend"
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
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-gray-500">Total Spend</div>
              <div className="text-2xl font-bold">{formatCurrency(data.grandTotal)}</div>
            </CardContent>
          </Card>

          {top8.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Spend by Vendor</CardTitle>
              </CardHeader>
              <CardContent>
                <div style={{ width: '100%', height: 320 }}>
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={top8} dataKey="total" nameKey="vendorName" cx="50%" cy="50%" outerRadius={110} label>
                        {top8.map((entry, index) => (
                          <Cell key={entry.vendorKey} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>By Vendor</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-2 pr-3">Vendor</th>
                      <th className="py-2 pr-3 text-right">Purchase Orders</th>
                      <th className="py-2 pr-3 text-right">Total Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byVendor.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-6 text-center text-gray-400">
                          No purchase order spend in this period
                        </td>
                      </tr>
                    ) : (
                      data.byVendor.map((v) => (
                        <tr key={v.vendorKey} className="border-b last:border-0">
                          <td className="py-2 pr-3">{v.vendorName}</td>
                          <td className="py-2 pr-3 text-right">{v.poCount}</td>
                          <td className="py-2 pr-3 text-right font-medium">{formatCurrency(v.total)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="py-2 pr-3">Total</td>
                      <td className="py-2 pr-3 text-right">{data.byVendor.reduce((s, v) => s + v.poCount, 0)}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(data.grandTotal)}</td>
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
