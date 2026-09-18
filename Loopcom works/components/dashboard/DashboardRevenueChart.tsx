'use client'

import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { EmptyState } from '@/components/charts/EmptyState'

export function DashboardRevenueChart() {
  const [data, setData] = useState<Array<{ date: string; revenue: number }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return

      const endDate = new Date()
      const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000)
      const response = await fetch(
        `/api/analytics/overview?range=30d&startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      )

      if (response.ok) {
        const result = await response.json()
        const timeSeries = result?.metrics?.timeSeries || []
        if (Array.isArray(timeSeries)) {
          setData(timeSeries.filter((d: any) => d && d.revenue).slice(-30))
        }
      } else {
        console.error('Failed to fetch revenue data:', response.status)
      }
    } catch (error) {
      console.error('Failed to fetch revenue data:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="h-[200px] flex items-center justify-center text-gray-500">Loading...</div>
  }

  if (data.length === 0) {
    return <EmptyState title="No revenue data" message="No revenue recorded in the last 30 days." />
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip formatter={(value: number) => formatCurrency(value)} />
        <Line type="monotone" dataKey="revenue" stroke="#2E4A59" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
