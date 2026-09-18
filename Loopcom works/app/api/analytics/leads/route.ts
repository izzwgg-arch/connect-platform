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
    // Leads created over time
    const dailyLeads = await prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
      SELECT
        DATE("createdAt") as date,
        COUNT(*)::int as count
      FROM leads
      WHERE "tenantId" = ${user.tenantId}
        AND "createdAt" >= ${startDate}
        AND "createdAt" <= ${endDate}
      GROUP BY DATE("createdAt")
      ORDER BY date ASC
    `

    // Lead sources breakdown
    const leadsBySource = await prisma.lead.groupBy({
      by: ['source'],
      where: {
        tenantId: user.tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
      _count: true,
    })

    // Conversion funnel
    const totalLeads = await prisma.lead.count({
      where: {
        tenantId: user.tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
    })

    const estimatesSent = await prisma.lead.count({
      where: {
        tenantId: user.tenantId,
        createdAt: { gte: startDate, lte: endDate },
        estimates: {
          some: {},
        },
      },
    })

    const leadsWon = await prisma.lead.count({
      where: {
        tenantId: user.tenantId,
        status: 'CONVERTED',
        convertedAt: { gte: startDate, lte: endDate },
      },
    })

    const leadsLost = await prisma.lead.count({
      where: {
        tenantId: user.tenantId,
        status: 'LOST',
        updatedAt: { gte: startDate, lte: endDate },
      },
    })

    // Average time in stage
    const convertedLeads = await prisma.lead.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'CONVERTED',
        convertedAt: { gte: startDate, lte: endDate },
      },
      select: {
        createdAt: true,
        convertedAt: true,
      },
    })

    const avgTimeToConvert =
      convertedLeads.length > 0
        ? convertedLeads.reduce((sum, lead) => {
            const timeDiff = lead.convertedAt!.getTime() - lead.createdAt.getTime()
            return sum + timeDiff
          }, 0) /
          convertedLeads.length /
          (1000 * 60 * 60 * 24) // Convert to days
        : 0

    return NextResponse.json({
      metrics: {
        leadsOverTime: dailyLeads.map((d) => ({
          date: d.date.toISOString().split('T')[0],
          count: Number(d.count),
        })),
        leadsBySource: leadsBySource.map((l) => ({
          source: l.source || 'Unknown',
          count: l._count,
        })),
        funnel: {
          totalLeads,
          estimatesSent,
          won: leadsWon,
          lost: leadsLost,
          conversionRate: totalLeads > 0 ? (leadsWon / totalLeads) * 100 : 0,
        },
        avgTimeToConvert: Math.round(avgTimeToConvert * 100) / 100,
      },
    })
  } catch (error) {
    console.error('Analytics leads error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
