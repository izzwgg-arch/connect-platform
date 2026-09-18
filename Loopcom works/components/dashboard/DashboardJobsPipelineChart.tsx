'use client'

import { useEffect, useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { EmptyState } from '@/components/charts/EmptyState'

const COLORS = ['#2E4A59', '#00C49F', '#FFBB28', '#FF8042', '#2E4A59']

export function DashboardJobsPipelineChart() {
  const [data, setData] = useState<Array<{ name: string; value: number }>>([])
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
        const activeJobs = result?.metrics?.kpis?.activeJobsByStatus || {}
        if (activeJobs && typeof activeJobs === 'object') {
          const chartData = Object.entries(activeJobs).map(([name, value]) => ({
            name,
            value: Number(value) || 0,
          }))
          setData(chartData)
        }
      } else {
        console.error('Failed to fetch jobs pipeline data:', response.status)
      }
    } catch (error) {
      console.error('Failed to fetch jobs data:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="min-h-[360px] flex items-center justify-center text-gray-500">Loading...</div>
  }

  if (data.length === 0) {
    return <EmptyState title="No active jobs" message="No active jobs to display." />
  }

  return (
    <div className="w-full min-h-[360px]">
      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="48%"
              labelLine={false}
              label={false}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-2 pb-2">
        {data.map((item, index) => (
          <div key={`legend-${item.name}-${index}`} className="flex items-center gap-2 text-xs text-gray-600">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: COLORS[index % COLORS.length] }}
              aria-hidden="true"
            />
            <span className="whitespace-nowrap">{item.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
