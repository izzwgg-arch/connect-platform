/**
 * Analytics Data Layer
 * Provides server-side aggregation functions for analytics queries
 * All functions return safe defaults (0, empty arrays) when no data exists
 */

import { prisma } from '@/lib/prisma'

export interface DateRange {
  startDate: Date
  endDate: Date
}

export interface AnalyticsKPIs {
  totalRevenue: number
  outstandingInvoices: number
  jobsCreated: number
  jobsCompleted: number
  activeJobsByStatus: Record<string, number>
  leadConversionRate: number
  avgJobCompletionTime: number // in days
  dispatchThroughput: number // assignments per day
  topClientsByRevenue: Array<{ clientId: string; clientName: string; revenue: number }>
  topClientsByJobCount: Array<{ clientId: string; clientName: string; jobCount: number }>
}

export interface TimeSeriesData {
  date: string
  revenue?: number
  jobsCreated?: number
  jobsCompleted?: number
  leadsCreated?: number
  leadsConverted?: number
  payments?: number
}

export interface FunnelData {
  totalLeads: number
  estimatesSent: number
  won: number
  lost: number
  jobsCreated: number
  invoicesCreated: number
  invoicesPaid: number
  conversionRate: number
}

export interface WaterfallData {
  starting: number
  adjustments: Array<{ label: string; value: number }>
  ending: number
}

/**
 * Get date range from preset or custom dates
 */
export function getDateRange(range: string, customStart?: Date, customEnd?: Date): DateRange {
  const now = new Date()
  let startDate: Date

  switch (range) {
    case '7d':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      break
    case '30d':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      break
    case '90d':
      startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
      break
    case 'ytd':
      startDate = new Date(now.getFullYear(), 0, 1)
      break
    case 'custom':
      if (customStart && customEnd) {
        return { startDate: customStart, endDate: customEnd }
      }
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      break
    default:
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }

  return {
    startDate,
    endDate: customEnd || now,
  }
}

/**
 * Get comprehensive KPIs for a date range
 */
export async function getAnalyticsKPIs(
  tenantId: string,
  dateRange: DateRange
): Promise<AnalyticsKPIs> {
  const { startDate, endDate } = dateRange

  // Total revenue (paid invoices) - filter through invoice relationship
  const totalRevenueResult = await prisma.payment.aggregate({
    where: {
      invoice: {
        tenantId,
      },
      status: 'COMPLETED',
      processedAt: { gte: startDate, lte: endDate },
    },
    _sum: { amount: true },
  })
  const totalRevenue = totalRevenueResult._sum.amount || 0

  // Outstanding invoices
  const outstandingResult = await prisma.invoice.aggregate({
    where: {
      tenantId,
      status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] },
    },
    _sum: { balance: true },
  })
  const outstandingInvoices = outstandingResult._sum.balance || 0

  // Jobs created and completed
  const [jobsCreated, jobsCompleted] = await Promise.all([
    prisma.job.count({
      where: {
        tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
    }),
    prisma.job.count({
      where: {
        tenantId,
        status: 'COMPLETED',
        updatedAt: { gte: startDate, lte: endDate },
      },
    }),
  ])

  // Active jobs by status
  const activeJobs = await prisma.job.groupBy({
    by: ['status'],
    where: {
      tenantId,
      status: { in: ['QUOTE', 'SCHEDULED', 'IN_PROGRESS', 'MEASURED', 'NEED_TO_ORDER', 'ORDERED', 'INSTALLATION_COMPLETE', 'NEED_TOUCH_UPS', 'FINISHING_COMPLETE', 'ON_HOLD'] },
    },
    _count: { id: true },
  })
  const activeJobsByStatus: Record<string, number> = {}
  activeJobs.forEach((job) => {
    activeJobsByStatus[job.status] = job._count.id
  })

  // Lead conversion rate
  const [leadsCreated, leadsConverted] = await Promise.all([
    prisma.lead.count({
      where: {
        tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
    }),
    prisma.lead.count({
      where: {
        tenantId,
        status: 'CONVERTED',
        convertedAt: { gte: startDate, lte: endDate },
      },
    }),
  ])
  const leadConversionRate = leadsCreated > 0 ? (leadsConverted / leadsCreated) * 100 : 0

  // Average job completion time
  const completedJobs = await prisma.job.findMany({
    where: {
      tenantId,
      status: 'COMPLETED',
      createdAt: { gte: startDate, lte: endDate },
      actualEnd: { not: null },
    },
    select: {
      createdAt: true,
      actualEnd: true,
    },
    take: 1000, // Limit for performance
  })

  let avgJobCompletionTime = 0
  if (completedJobs.length > 0) {
    const totalDays = completedJobs.reduce((sum, job) => {
      if (job.actualEnd) {
        const days = (job.actualEnd.getTime() - job.createdAt.getTime()) / (1000 * 60 * 60 * 24)
        return sum + days
      }
      return sum
    }, 0)
    avgJobCompletionTime = totalDays / completedJobs.length
  }

  // Dispatch throughput (assignments per day)
  const dispatchEvents = await prisma.dispatchEvent.count({
    where: {
      tenantId,
      eventType: 'ASSIGNED',
      timestamp: { gte: startDate, lte: endDate },
    },
  })
  const daysDiff = Math.max(1, (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  const dispatchThroughput = dispatchEvents / daysDiff

  // Top clients by revenue - filter through invoice relationship
  const payments = await prisma.payment.findMany({
    where: {
      invoice: {
        tenantId,
      },
      status: 'COMPLETED',
      processedAt: { gte: startDate, lte: endDate },
    },
    include: {
      invoice: {
        select: {
          clientId: true,
        },
      },
    },
  })

  // Group by clientId manually
  const clientRevenueMap = new Map<string, number>()
  payments.forEach((payment) => {
    if (payment.invoice?.clientId) {
      const current = clientRevenueMap.get(payment.invoice.clientId) || 0
      clientRevenueMap.set(payment.invoice.clientId, current + Number(payment.amount))
    }
  })

  const topClientsByRevenueRaw = Array.from(clientRevenueMap.entries())
    .map(([clientId, revenue]) => ({ clientId, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)

  const topClientsByRevenue = await Promise.all(
    topClientsByRevenueRaw.map(async (item) => {
      if (!item.clientId) return null
      const client = await prisma.client.findUnique({
        where: { id: item.clientId },
        select: { name: true },
      })
      return {
        clientId: item.clientId,
        clientName: client?.name || 'Unknown',
        revenue: item.revenue || 0,
      }
    })
  )

  // Top clients by job count
  const topClientsByJobCountRaw = await prisma.job.groupBy({
    by: ['clientId'],
    where: {
      tenantId,
      createdAt: { gte: startDate, lte: endDate },
    },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 10,
  })

  const topClientsByJobCount = await Promise.all(
    topClientsByJobCountRaw.map(async (item) => {
      if (!item.clientId) return null
      const client = await prisma.client.findUnique({
        where: { id: item.clientId },
        select: { name: true },
      })
      return {
        clientId: item.clientId,
        clientName: client?.name || 'Unknown',
        jobCount: item._count.id,
      }
    })
  )

  return {
    totalRevenue,
    outstandingInvoices,
    jobsCreated,
    jobsCompleted,
    activeJobsByStatus,
    leadConversionRate: Math.round(leadConversionRate * 100) / 100,
    avgJobCompletionTime: Math.round(avgJobCompletionTime * 100) / 100,
    dispatchThroughput: Math.round(dispatchThroughput * 100) / 100,
    topClientsByRevenue: topClientsByRevenue.filter((c) => c !== null) as Array<{
      clientId: string
      clientName: string
      revenue: number
    }>,
    topClientsByJobCount: topClientsByJobCount.filter((c) => c !== null) as Array<{
      clientId: string
      clientName: string
      jobCount: number
    }>,
  }
}

/**
 * Get time series data for charts
 */
export async function getTimeSeriesData(
  tenantId: string,
  dateRange: DateRange
): Promise<TimeSeriesData[]> {
  const { startDate, endDate } = dateRange

  // Generate date array for the range
  const dates: string[] = []
  const currentDate = new Date(startDate)
  while (currentDate <= endDate) {
    dates.push(currentDate.toISOString().split('T')[0])
    currentDate.setDate(currentDate.getDate() + 1)
  }

  // Get daily revenue (payments) - filter through invoice relationship
  const payments = await prisma.payment.findMany({
    where: {
      invoice: {
        tenantId,
      },
      status: 'COMPLETED',
      processedAt: { gte: startDate, lte: endDate },
    },
    select: {
      amount: true,
      processedAt: true,
    },
  })

  // Get daily jobs
  const jobs = await prisma.job.findMany({
    where: {
      tenantId,
      createdAt: { gte: startDate, lte: endDate },
    },
    select: {
      createdAt: true,
      status: true,
      actualEnd: true,
    },
  })

  // Get daily leads
  const leads = await prisma.lead.findMany({
    where: {
      tenantId,
      createdAt: { gte: startDate, lte: endDate },
    },
    select: {
      createdAt: true,
      status: true,
      convertedAt: true,
    },
  })

  // Aggregate by date
  const dataMap = new Map<string, TimeSeriesData>()

  dates.forEach((date) => {
    dataMap.set(date, {
      date,
      revenue: 0,
      jobsCreated: 0,
      jobsCompleted: 0,
      leadsCreated: 0,
      leadsConverted: 0,
      payments: 0,
    })
  })

  // Aggregate payments
  payments.forEach((payment) => {
    if (!payment || !payment.processedAt) return
    const date = payment.processedAt.toISOString().split('T')[0]
    const entry = dataMap.get(date)
    if (entry) {
      entry.revenue = (entry.revenue || 0) + Number(payment.amount || 0)
      entry.payments = (entry.payments || 0) + Number(payment.amount || 0)
    }
  })

  // Aggregate jobs
  jobs.forEach((job) => {
    if (!job || !job.createdAt) return
    const date = job.createdAt.toISOString().split('T')[0]
    const entry = dataMap.get(date)
    if (entry) {
      entry.jobsCreated = (entry.jobsCreated || 0) + 1
    }

    if (job.status === 'COMPLETED' && job.actualEnd) {
      const completedDate = job.actualEnd.toISOString().split('T')[0]
      const completedEntry = dataMap.get(completedDate)
      if (completedEntry) {
        completedEntry.jobsCompleted = (completedEntry.jobsCompleted || 0) + 1
      }
    }
  })

  // Aggregate leads
  leads.forEach((lead) => {
    if (!lead || !lead.createdAt) return
    const date = lead.createdAt.toISOString().split('T')[0]
    const entry = dataMap.get(date)
    if (entry) {
      entry.leadsCreated = (entry.leadsCreated || 0) + 1
    }

    if (lead.status === 'CONVERTED' && lead.convertedAt) {
      const convertedDate = lead.convertedAt.toISOString().split('T')[0]
      const convertedEntry = dataMap.get(convertedDate)
      if (convertedEntry) {
        convertedEntry.leadsConverted = (convertedEntry.leadsConverted || 0) + 1
      }
    }
  })

  return Array.from(dataMap.values())
}

/**
 * Get funnel data (Lead -> Job -> Invoice -> Paid)
 */
export async function getFunnelData(
  tenantId: string,
  dateRange: DateRange
): Promise<FunnelData> {
  const { startDate, endDate } = dateRange

  const [totalLeads, estimatesSent, won, lost, jobsCreated, invoicesCreated, invoicesPaid] =
    await Promise.all([
      prisma.lead.count({
        where: {
          tenantId,
          createdAt: { gte: startDate, lte: endDate },
        },
      }),
      prisma.estimate.count({
        where: {
          tenantId,
          createdAt: { gte: startDate, lte: endDate },
        },
      }),
      prisma.lead.count({
        where: {
          tenantId,
          status: 'CONVERTED',
          convertedAt: { gte: startDate, lte: endDate },
        },
      }),
      prisma.lead.count({
        where: {
          tenantId,
          status: 'LOST',
          updatedAt: { gte: startDate, lte: endDate },
        },
      }),
      prisma.job.count({
        where: {
          tenantId,
          createdAt: { gte: startDate, lte: endDate },
        },
      }),
      prisma.invoice.count({
        where: {
          tenantId,
          createdAt: { gte: startDate, lte: endDate },
        },
      }),
      prisma.invoice.count({
        where: {
          tenantId,
          status: 'PAID',
          updatedAt: { gte: startDate, lte: endDate },
        },
      }),
    ])

  const conversionRate = totalLeads > 0 ? (won / totalLeads) * 100 : 0

  return {
    totalLeads,
    estimatesSent,
    won,
    lost,
    jobsCreated,
    invoicesCreated,
    invoicesPaid,
    conversionRate: Math.round(conversionRate * 100) / 100,
  }
}

/**
 * Get revenue waterfall data
 */
export async function getRevenueWaterfall(
  tenantId: string,
  dateRange: DateRange
): Promise<WaterfallData> {
  const { startDate, endDate } = dateRange

  // Total billed
  const totalBilledResult = await prisma.invoice.aggregate({
    where: {
      tenantId,
      createdAt: { gte: startDate, lte: endDate },
    },
    _sum: { total: true },
  })
  const totalBilled = totalBilledResult._sum.total || 0

  // Total collected - filter through invoice relationship
  const totalCollectedResult = await prisma.payment.aggregate({
    where: {
      invoice: {
        tenantId,
      },
      status: 'COMPLETED',
      processedAt: { gte: startDate, lte: endDate },
    },
    _sum: { amount: true },
  })
  const totalCollected = totalCollectedResult._sum.amount || 0

  // Credits/refunds
  const totalCreditsResult = await prisma.payment.aggregate({
    where: {
      invoice: {
        tenantId,
      },
      refundedAt: { gte: startDate, lte: endDate },
    },
    _sum: { refundedAmount: true },
  })
  const totalCredits = totalCreditsResult._sum.refundedAmount || 0

  // Outstanding
  const outstandingResult = await prisma.invoice.aggregate({
    where: {
      tenantId,
      status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] },
    },
    _sum: { balance: true },
  })
  const outstanding = outstandingResult._sum.balance || 0

  return {
    starting: totalBilled,
    adjustments: [
      { label: 'Collected', value: -totalCollected },
      { label: 'Credits/Refunds', value: -totalCredits },
    ],
    ending: outstanding,
  }
}

/**
 * Get job lifecycle waterfall data
 */
export async function getJobLifecycleWaterfall(
  tenantId: string,
  dateRange: DateRange
): Promise<WaterfallData> {
  const { startDate, endDate } = dateRange

  const [created, scheduled, inProgress, completed, invoiced, paid] = await Promise.all([
    prisma.job.count({
      where: {
        tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
    }),
    prisma.job.count({
      where: {
        tenantId,
        status: 'SCHEDULED',
        updatedAt: { gte: startDate, lte: endDate },
      },
    }),
    prisma.job.count({
      where: {
        tenantId,
        status: 'IN_PROGRESS',
        updatedAt: { gte: startDate, lte: endDate },
      },
    }),
    prisma.job.count({
      where: {
        tenantId,
        status: 'COMPLETED',
        updatedAt: { gte: startDate, lte: endDate },
      },
    }),
    prisma.job.count({
      where: {
        tenantId,
        invoices: { some: { createdAt: { gte: startDate, lte: endDate } } },
      },
    }),
    prisma.job.count({
      where: {
        tenantId,
        invoices: {
          some: {
            status: 'PAID',
            updatedAt: { gte: startDate, lte: endDate },
          },
        },
      },
    }),
  ])

  return {
    starting: created,
    adjustments: [
      { label: 'Scheduled', value: scheduled },
      { label: 'In Progress', value: inProgress },
      { label: 'Completed', value: completed },
      { label: 'Invoiced', value: invoiced },
      { label: 'Paid', value: paid },
    ],
    ending: paid,
  }
}
