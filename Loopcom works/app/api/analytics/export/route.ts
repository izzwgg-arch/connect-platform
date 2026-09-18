import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { validateQuery, dateRangeSchema } from '@/lib/validation'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'analytics.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const format = searchParams.get('format') || 'csv'
  const type = searchParams.get('type') || 'overview'

  const validation = validateQuery(searchParams, dateRangeSchema)
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: validation.status })
  }

  const startDate = validation.data.startDate
    ? new Date(validation.data.startDate)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const endDate = validation.data.endDate ? new Date(validation.data.endDate) : new Date()

  try {
    let csvData = ''

    if (type === 'jobs') {
      const jobs = await prisma.job.findMany({
        where: {
          tenantId: user.tenantId,
          createdAt: { gte: startDate, lte: endDate },
        },
        select: {
          jobNumber: true,
          title: true,
          status: true,
          priority: true,
          createdAt: true,
          scheduledStart: true,
          actualEnd: true,
          client: {
            select: {
              name: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      })

      csvData = [
        'Job Number,Title,Status,Priority,Client,Created Date,Scheduled Start,Completed Date',
        ...jobs.map(
          (job) =>
            `${job.jobNumber},"${job.title}",${job.status},${job.priority},"${job.client.name}",${job.createdAt.toISOString().split('T')[0]},${job.scheduledStart?.toISOString().split('T')[0] || ''},${job.actualEnd?.toISOString().split('T')[0] || ''}`
        ),
      ].join('\n')
    } else if (type === 'revenue') {
      const invoices = await prisma.invoice.findMany({
        where: {
          tenantId: user.tenantId,
          createdAt: { gte: startDate, lte: endDate },
        },
        select: {
          invoiceNumber: true,
          total: true,
          balance: true,
          status: true,
          dueDate: true,
          createdAt: true,
          client: {
            select: {
              name: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      })

      csvData = [
        'Invoice Number,Client,Total,Balance,Status,Due Date,Created Date',
        ...invoices.map(
          (inv) =>
            `${inv.invoiceNumber},"${inv.client.name}",${inv.total},${inv.balance},${inv.status},${inv.dueDate?.toISOString().split('T')[0] || ''},${inv.createdAt.toISOString().split('T')[0]}`
        ),
      ].join('\n')
    } else if (type === 'leads') {
      const leads = await prisma.lead.findMany({
        where: {
          tenantId: user.tenantId,
          createdAt: { gte: startDate, lte: endDate },
        },
        select: {
          firstName: true,
          lastName: true,
          company: true,
          source: true,
          status: true,
          value: true,
          convertedAt: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      })

      csvData = [
        'Name,Company,Source,Status,Value,Created Date,Converted Date',
        ...leads.map(
          (lead) =>
            `"${lead.firstName} ${lead.lastName}","${lead.company || ''}",${lead.source},${lead.status},${lead.value || 0},${lead.createdAt.toISOString().split('T')[0]},${lead.convertedAt?.toISOString().split('T')[0] || ''}`
        ),
      ].join('\n')
    } else {
      // Overview summary
      const [jobsCount, revenueSum, invoicesCount] = await Promise.all([
        prisma.job.count({
          where: {
            tenantId: user.tenantId,
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
        prisma.invoice.aggregate({
          where: {
            tenantId: user.tenantId,
            createdAt: { gte: startDate, lte: endDate },
          },
          _sum: { total: true },
        }),
        prisma.invoice.count({
          where: {
            tenantId: user.tenantId,
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
      ])

      csvData = [
        'Metric,Value',
        `Jobs Created,${jobsCount}`,
        `Total Revenue,${revenueSum._sum.total || 0}`,
        `Invoices Created,${invoicesCount}`,
        `Date Range,${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
      ].join('\n')
    }

    return new NextResponse(csvData, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="analytics-${type}-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (error) {
    console.error('Analytics export error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
