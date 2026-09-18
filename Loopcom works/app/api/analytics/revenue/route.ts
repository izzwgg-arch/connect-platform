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

  const validation = validateQuery(searchParams, dateRangeSchema)
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: validation.status })
  }

  const startDate = validation.data.startDate
    ? new Date(validation.data.startDate)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const endDate = validation.data.endDate ? new Date(validation.data.endDate) : new Date()

  try {
    // Revenue over time (monthly)
    const monthlyRevenue = await prisma.$queryRaw<Array<{ month: string; revenue: number }>>`
      SELECT
        TO_CHAR("createdAt", 'YYYY-MM') as month,
        COALESCE(SUM(total), 0)::decimal as revenue
      FROM invoices
      WHERE "tenantId" = ${user.tenantId}
        AND "createdAt" >= ${startDate}
        AND "createdAt" <= ${endDate}
      GROUP BY TO_CHAR("createdAt", 'YYYY-MM')
      ORDER BY month ASC
    `

    // Payments over time
    const monthlyPayments = await prisma.$queryRaw<Array<{ month: string; amount: number }>>`
      SELECT
        TO_CHAR("processedAt", 'YYYY-MM') as month,
        COALESCE(SUM(amount), 0)::decimal as amount
      FROM payments
      WHERE status = 'COMPLETED'
        AND "invoiceId" IN (
          SELECT id FROM invoices WHERE "tenantId" = ${user.tenantId}
        )
        AND "processedAt" >= ${startDate}
        AND "processedAt" <= ${endDate}
      GROUP BY TO_CHAR("processedAt", 'YYYY-MM')
      ORDER BY month ASC
    `

    // Outstanding invoices waterfall
    const totalBilled = await prisma.invoice.aggregate({
      where: {
        tenantId: user.tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
      _sum: { total: true },
    })

    const totalCollected = await prisma.payment.aggregate({
      where: {
        invoice: {
          tenantId: user.tenantId,
        },
        status: 'COMPLETED',
        processedAt: { gte: startDate, lte: endDate },
      },
      _sum: { amount: true },
    })

    const totalCredits = await prisma.payment.aggregate({
      where: {
        invoice: {
          tenantId: user.tenantId,
        },
        refundedAt: { gte: startDate, lte: endDate },
      },
      _sum: { refundedAmount: true },
    })

    const outstanding = (totalBilled._sum.total || 0) - (totalCollected._sum.amount || 0) - (totalCredits._sum.refundedAmount || 0)

    // AR Aging breakdown
    const now = new Date()
    const agingBreakdown = await Promise.all([
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
        revenueOverTime: monthlyRevenue.map((r) => ({
          month: r.month,
          revenue: Number(r.revenue),
        })),
        paymentsOverTime: monthlyPayments.map((p) => ({
          month: p.month,
          amount: Number(p.amount),
        })),
        waterfall: {
          totalBilled: Number(totalBilled._sum.total || 0),
          totalCollected: Number(totalCollected._sum.amount || 0),
          totalCredits: Number(totalCredits._sum.refundedAmount || 0),
          outstanding: Number(outstanding),
        },
        arAging: {
          '0-30': Number(agingBreakdown[0]._sum.balance || 0),
          '31-60': Number(agingBreakdown[1]._sum.balance || 0),
          '61-90': Number(agingBreakdown[2]._sum.balance || 0),
          '90+': Number(agingBreakdown[3]._sum.balance || 0),
        },
      },
    })
  } catch (error) {
    console.error('Analytics revenue error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
