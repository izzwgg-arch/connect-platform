import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import {
  getDateRange,
  getAnalyticsKPIs,
  getTimeSeriesData,
  getFunnelData,
  getRevenueWaterfall,
  getJobLifecycleWaterfall,
} from '@/lib/analytics'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'analytics.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '30d'
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')

  try {
    const dateRange = getDateRange(
      range,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined
    )

    const [kpis, timeSeries, funnel, revenueWaterfall, jobWaterfall] = await Promise.all([
      getAnalyticsKPIs(user.tenantId, dateRange),
      getTimeSeriesData(user.tenantId, dateRange),
      getFunnelData(user.tenantId, dateRange),
      getRevenueWaterfall(user.tenantId, dateRange),
      getJobLifecycleWaterfall(user.tenantId, dateRange),
    ])

    // Invoice aging
    const now = new Date()
    const [aging30, aging60, aging90, aging90Plus] = await Promise.all([
      prisma.invoice.aggregate({
        where: {
          tenantId: user.tenantId,
          status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] },
          dueDate: {
            gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
            lte: now,
          },
        },
        _sum: { balance: true },
      }),
      prisma.invoice.aggregate({
        where: {
          tenantId: user.tenantId,
          status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] },
          dueDate: {
            gte: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
            lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          },
        },
        _sum: { balance: true },
      }),
      prisma.invoice.aggregate({
        where: {
          tenantId: user.tenantId,
          status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] },
          dueDate: {
            gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
            lt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
          },
        },
        _sum: { balance: true },
      }),
      prisma.invoice.aggregate({
        where: {
          tenantId: user.tenantId,
          status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] },
          dueDate: {
            lt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
          },
        },
        _sum: { balance: true },
      }),
    ])

    return NextResponse.json({
      metrics: {
        kpis,
        timeSeries,
        funnel,
        revenueWaterfall,
        jobWaterfall,
        invoiceAging: {
          '0-30': aging30._sum.balance || 0,
          '31-60': aging60._sum.balance || 0,
          '61-90': aging90._sum.balance || 0,
          '90+': aging90Plus._sum.balance || 0,
        },
      },
    })
  } catch (error) {
    console.error('Analytics overview error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
