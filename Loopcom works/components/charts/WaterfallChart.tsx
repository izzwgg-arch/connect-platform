'use client'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { EmptyState } from './EmptyState'

interface WaterfallData {
  starting: number
  adjustments: Array<{ label: string; value: number }>
  ending: number
}

interface WaterfallChartProps {
  data: WaterfallData
  title: string
  height?: number
}

export function WaterfallChart({ data, title, height = 300 }: WaterfallChartProps) {
  if (data.starting === 0 && data.adjustments.length === 0 && data.ending === 0) {
    return (
      <div style={{ height }}>
        <EmptyState title="No data available" message="No data to display for this waterfall chart." />
      </div>
    )
  }

  // Build waterfall data
  const chartData: Array<{ name: string; value: number; cumulative: number; isAdjustment: boolean }> = []
  let cumulative = data.starting

  chartData.push({
    name: 'Starting',
    value: data.starting,
    cumulative: data.starting,
    isAdjustment: false,
  })

  data.adjustments.forEach((adj) => {
    cumulative += adj.value
    chartData.push({
      name: adj.label,
      value: adj.value,
      cumulative,
      isAdjustment: true,
    })
  })

  chartData.push({
    name: 'Ending',
    value: data.ending,
    cumulative: data.ending,
    isAdjustment: false,
  })

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip
          formatter={(value: number) => {
            const num = Number(value)
            return num >= 0 ? `+${num.toLocaleString()}` : num.toLocaleString()
          }}
        />
        <Bar dataKey="value">
          {chartData.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.isAdjustment ? (entry.value >= 0 ? '#10b981' : '#ef4444') : '#2E4A59'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
