'use client'

import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { EmptyState } from '@/components/charts/EmptyState'

export function DashboardJobsChart() {
  const [data, setData] = useState<Array<{ date: string; jobsCreated: number; jobsCompleted: number }>>([])
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
          setData(timeSeries.filter((d: any) => d && (d.jobsCreated || d.jobsCompleted)).slice(-30))
        }
      } else {
        console.error('Failed to fetch jobs data:', response.status)
      }
    } catch (error) {
      console.error('Failed to fetch jobs data:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="h-[200px] flex items-center justify-center text-gray-500">Loading...</div>
  }

  if (data.length === 0) {
    return <EmptyState title="No job data" message="No jobs created or completed in the last 30 days." />
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
        <Legend />
        <Bar dataKey="jobsCreated" fill="#2E4A59" name="Created" />
        <Bar dataKey="jobsCompleted" fill="#00C49F" name="Completed" />
      </BarChart>
    </ResponsiveContainer>
  )
}
