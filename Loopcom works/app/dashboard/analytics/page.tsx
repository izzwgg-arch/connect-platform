'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { Download, TrendingUp, TrendingDown } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { EmptyState } from '@/components/charts/EmptyState'
import { WaterfallChart } from '@/components/charts/WaterfallChart'

const COLORS = ['#2E4A59', '#00C49F', '#FFBB28', '#FF8042', '#2E4A59']

interface AnalyticsData {
  kpis: {
    totalRevenue: number
    outstandingInvoices: number
    jobsCreated: number
    jobsCompleted: number
    activeJobsByStatus: Record<string, number>
    leadConversionRate: number
    avgJobCompletionTime: number
    dispatchThroughput: number
    topClientsByRevenue: Array<{ clientId: string; clientName: string; revenue: number }>
    topClientsByJobCount: Array<{ clientId: string; clientName: string; jobCount: number }>
  }
  timeSeries: Array<{
    date: string
    revenue?: number
    jobsCreated?: number
    jobsCompleted?: number
    leadsCreated?: number
    leadsConverted?: number
    payments?: number
  }>
  funnel: {
    totalLeads: number
    estimatesSent: number
    won: number
    lost: number
    jobsCreated: number
    invoicesCreated: number
    invoicesPaid: number
    conversionRate: number
  }
  revenueWaterfall: {
    starting: number
    adjustments: Array<{ label: string; value: number }>
    ending: number
  }
  jobWaterfall: {
    starting: number
    adjustments: Array<{ label: string; value: number }>
    ending: number
  }
  invoiceAging: {
    '0-30': number
    '31-60': number
    '61-90': number
    '90+': number
  }
}

export default function AnalyticsPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [dateRange, setDateRange] = useState('30d')
  const [activeTab, setActiveTab] = useState('overview')

  useEffect(() => {
    fetchMetrics()
  }, [dateRange, activeTab])

  const fetchMetrics = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('accessToken')
      if (!token) {
        window.location.href = '/auth/login'
        return
      }

      const startDate = getStartDate(dateRange)
      const endDate = new Date().toISOString()
      const queryParams = `range=${dateRange}&startDate=${startDate}&endDate=${endDate}`

      const response = await fetch(`/api/analytics/overview?${queryParams}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const result = await response.json()
        if (result.metrics) {
          setData(result.metrics)
        } else {
          console.error('Invalid response structure:', result)
          setData(null)
        }
      } else {
        const errorData = await response.json().catch(() => ({}))
        console.error('Failed to fetch analytics:', errorData.error || response.statusText)
        setData(null)
      }
    } catch (error) {
      console.error('Error fetching metrics:', error)
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const getStartDate = (range: string): string => {
    const now = new Date()
    switch (range) {
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
      case '90d':
        return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
      case 'ytd':
        return new Date(now.getFullYear(), 0, 1).toISOString()
      default:
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  }

  const handleExport = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const startDate = getStartDate(dateRange)
      const endDate = new Date().toISOString()
      const url = `/api/analytics/export?type=${activeTab}&format=csv&startDate=${startDate}&endDate=${endDate}`

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const blob = await response.blob()
        const downloadUrl = window.URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = downloadUrl
        link.download = `analytics-${activeTab}-${new Date().toISOString().split('T')[0]}.csv`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        window.URL.revokeObjectURL(downloadUrl)
      }
    } catch (error) {
      console.error('Export failed:', error)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading analytics...</p>
        </div>
      </div>
    )
  }

  // Always show the page, even with no data - each widget handles its own empty state
  // Defensive: Ensure data structure exists before accessing nested properties
  const safeData = data || {}
  const kpis = safeData.kpis || {
    totalRevenue: 0,
    outstandingInvoices: 0,
    jobsCreated: 0,
    jobsCompleted: 0,
    activeJobsByStatus: {},
    leadConversionRate: 0,
    avgJobCompletionTime: 0,
    dispatchThroughput: 0,
    topClientsByRevenue: [],
    topClientsByJobCount: [],
  }

  const timeSeries = Array.isArray(safeData.timeSeries) ? safeData.timeSeries.filter((d) => d && d.date) : []
  const funnel = safeData.funnel || {
    totalLeads: 0,
    estimatesSent: 0,
    won: 0,
    lost: 0,
    jobsCreated: 0,
    invoicesCreated: 0,
    invoicesPaid: 0,
    conversionRate: 0,
  }
  const revenueWaterfall = safeData.revenueWaterfall || { starting: 0, adjustments: [], ending: 0 }
  const jobWaterfall = safeData.jobWaterfall || { starting: 0, adjustments: [], ending: 0 }
  const invoiceAging = safeData.invoiceAging || { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }

  const invoiceAgingData = [
    { name: '0-30 days', value: invoiceAging['0-30'] },
    { name: '31-60 days', value: invoiceAging['31-60'] },
    { name: '61-90 days', value: invoiceAging['61-90'] },
    { name: '90+ days', value: invoiceAging['90+'] },
  ]

  const hasAnyData = Array.isArray(timeSeries) && timeSeries.length > 0 && timeSeries.some((d) => d && (d.revenue || d.jobsCreated || d.jobsCompleted || d.leadsCreated))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
          <p className="mt-2 text-gray-600">Business insights and performance metrics</p>
        </div>
        <div className="flex items-center space-x-2">
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
              <SelectItem value="ytd">Year to date</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={handleExport}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
          <TabsTrigger value="leads">Requests</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{formatCurrency(kpis.totalRevenue)}</div>
                <p className="text-xs text-gray-500 mt-1">Paid invoices</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Outstanding</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{formatCurrency(kpis.outstandingInvoices)}</div>
                <p className="text-xs text-gray-500 mt-1">Unpaid invoices</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Jobs Created</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{kpis.jobsCreated}</div>
                <p className="text-xs text-gray-500 mt-1">In selected period</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Jobs Completed</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{kpis.jobsCompleted}</div>
                <p className="text-xs text-gray-500 mt-1">In selected period</p>
              </CardContent>
            </Card>
          </div>

          {/* Revenue Over Time */}
          <Card>
            <CardHeader>
              <CardTitle>Revenue Over Time</CardTitle>
              <CardDescription>Daily revenue from paid invoices</CardDescription>
            </CardHeader>
            <CardContent>
              {hasAnyData && timeSeries.some((d) => d && d.revenue) ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={timeSeries.filter((d) => d && d.date)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Legend />
                    <Line type="monotone" dataKey="revenue" stroke="#2E4A59" name="Revenue" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No revenue data" message="No revenue recorded for this time period." />
              )}
            </CardContent>
          </Card>

          {/* Jobs Created vs Completed */}
          <Card>
            <CardHeader>
              <CardTitle>Jobs Created vs Completed</CardTitle>
              <CardDescription>Daily job activity</CardDescription>
            </CardHeader>
            <CardContent>
              {hasAnyData && timeSeries.some((d) => d && (d.jobsCreated || d.jobsCompleted)) ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={timeSeries.filter((d) => d && d.date)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="jobsCreated" fill="#2E4A59" name="Created" />
                    <Bar dataKey="jobsCompleted" fill="#00C49F" name="Completed" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No job data" message="No jobs created or completed in this time period." />
              )}
            </CardContent>
          </Card>

          {/* Funnel Chart */}
          <Card>
            <CardHeader>
              <CardTitle>Conversion Funnel</CardTitle>
              <CardDescription>Request → Job → Invoice → Paid</CardDescription>
            </CardHeader>
            <CardContent>
              {funnel.totalLeads > 0 || funnel.jobsCreated > 0 || funnel.invoicesCreated > 0 ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-4 gap-4">
                    <div className="text-center p-4 bg-[#2E4A59]/10 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.totalLeads}</div>
                      <div className="text-sm text-gray-600">Requests</div>
                    </div>
                    <div className="text-center p-4 bg-green-50 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.jobsCreated}</div>
                      <div className="text-sm text-gray-600">Jobs</div>
                    </div>
                    <div className="text-center p-4 bg-yellow-50 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.invoicesCreated}</div>
                      <div className="text-sm text-gray-600">Invoices</div>
                    </div>
                    <div className="text-center p-4 bg-purple-50 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.invoicesPaid}</div>
                      <div className="text-sm text-gray-600">Paid</div>
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-semibold">Conversion Rate: {funnel.conversionRate.toFixed(1)}%</div>
                  </div>
                </div>
              ) : (
                <EmptyState title="No funnel data" message="No conversion data available for this time period." />
              )}
            </CardContent>
          </Card>

          {/* Waterfall Charts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Revenue Waterfall</CardTitle>
                <CardDescription>Billed → Collected → Outstanding</CardDescription>
              </CardHeader>
              <CardContent>
                <WaterfallChart data={revenueWaterfall} title="Revenue Waterfall" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Job Lifecycle Waterfall</CardTitle>
                <CardDescription>Created → Scheduled → Completed → Paid</CardDescription>
              </CardHeader>
              <CardContent>
                <WaterfallChart data={jobWaterfall} title="Job Lifecycle" />
              </CardContent>
            </Card>
          </div>

          {/* Top Clients */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Top Clients by Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                {kpis.topClientsByRevenue.length > 0 ? (
                  <div className="space-y-2">
                    {kpis.topClientsByRevenue.slice(0, 10).map((client, idx) => (
                      <div key={client.clientId} className="flex justify-between items-center">
                        <span className="text-sm">{idx + 1}. {client.clientName}</span>
                        <span className="font-medium">{formatCurrency(client.revenue)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No client data" message="No revenue data by client for this period." />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Top Clients by Job Count</CardTitle>
              </CardHeader>
              <CardContent>
                {kpis.topClientsByJobCount.length > 0 ? (
                  <div className="space-y-2">
                    {kpis.topClientsByJobCount.slice(0, 10).map((client, idx) => (
                      <div key={client.clientId} className="flex justify-between items-center">
                        <span className="text-sm">{idx + 1}. {client.clientName}</span>
                        <span className="font-medium">{client.jobCount} jobs</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No client data" message="No job data by client for this period." />
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="jobs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Jobs Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              {hasAnyData && timeSeries.some((d) => d && (d.jobsCreated || d.jobsCompleted)) ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={timeSeries.filter((d) => d && d.date)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="jobsCreated" stroke="#2E4A59" name="Created" />
                    <Line type="monotone" dataKey="jobsCompleted" stroke="#00C49F" name="Completed" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No job data" message="No jobs created or completed in this time period." />
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Avg Completion Time</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{kpis.avgJobCompletionTime.toFixed(1)}</div>
                <p className="text-xs text-gray-500 mt-1">days</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Active Jobs by Status</CardTitle>
              </CardHeader>
              <CardContent>
                {Object.keys(kpis.activeJobsByStatus).length > 0 ? (
                  <div className="space-y-2">
                    {Object.entries(kpis.activeJobsByStatus).map(([status, count]) => (
                      <div key={status} className="flex justify-between">
                        <span className="text-sm">{status}</span>
                        <span className="font-medium">{count}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No active jobs" message="No active jobs in this period." />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Dispatch Throughput</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{kpis.dispatchThroughput.toFixed(1)}</div>
                <p className="text-xs text-gray-500 mt-1">assignments per day</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="revenue" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Revenue & Payments Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              {hasAnyData && timeSeries.some((d) => d && d.revenue) ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={timeSeries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Legend />
                    <Line type="monotone" dataKey="revenue" stroke="#2E4A59" name="Revenue" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No revenue data" message="No revenue recorded for this time period." />
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Revenue Waterfall</CardTitle>
              </CardHeader>
              <CardContent>
                <WaterfallChart data={revenueWaterfall} title="Revenue Waterfall" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>AR Aging</CardTitle>
              </CardHeader>
              <CardContent>
                {Object.values(invoiceAging).some((v) => v > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={invoiceAgingData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      <Bar dataKey="value" fill="#2E4A59" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState title="No aging data" message="No outstanding invoices to age." />
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="leads" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Conversion Funnel</CardTitle>
            </CardHeader>
            <CardContent>
              {funnel.totalLeads > 0 ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-4 gap-4">
                    <div className="text-center p-4 bg-[#2E4A59]/10 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.totalLeads}</div>
                      <div className="text-sm text-gray-600">Requests</div>
                    </div>
                    <div className="text-center p-4 bg-green-50 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.won}</div>
                      <div className="text-sm text-gray-600">Won</div>
                    </div>
                    <div className="text-center p-4 bg-red-50 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.lost}</div>
                      <div className="text-sm text-gray-600">Lost</div>
                    </div>
                    <div className="text-center p-4 bg-purple-50 rounded-lg">
                      <div className="text-2xl font-bold">{funnel.conversionRate.toFixed(1)}%</div>
                      <div className="text-sm text-gray-600">Rate</div>
                    </div>
                  </div>
                </div>
              ) : (
                <EmptyState title="No request data" message="No requests created in this time period." />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Requests Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              {hasAnyData && timeSeries.some((d) => d && (d.leadsCreated || d.leadsConverted)) ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={timeSeries.filter((d) => d && d.date)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="leadsCreated" stroke="#2E4A59" name="Created" />
                    <Line type="monotone" dataKey="leadsConverted" stroke="#00C49F" name="Converted" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No request data" message="No requests created or converted in this time period." />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
