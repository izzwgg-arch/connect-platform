import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildJobProfitabilityPdfHtml } from '@/lib/documents/pdf-templates'
import { csvResponse } from '@/lib/reports/csv'
import { getClientHierarchyMap, jobSiteAddressWhere, resolveClientFilterIds, rollupTarget } from '@/lib/reports/client-filters'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'reports.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const format = String(searchParams.get('format') || 'json').toLowerCase()
  const startDateRaw = String(searchParams.get('startDate') || '').trim()
  const endDateRaw = String(searchParams.get('endDate') || '').trim()
  const startDate = startDateRaw ? new Date(startDateRaw) : null
  const endDate = endDateRaw ? new Date(endDateRaw + 'T23:59:59.999') : null
  const clientId = String(searchParams.get('clientId') || '').trim() || null
  const jobSiteTerm = String(searchParams.get('jobSiteAddress') || '').trim()
  const hideSubClients = String(searchParams.get('hideSubClients') || 'true') !== 'false'

  try {
    const effectiveClientIds = await resolveClientFilterIds(user.tenantId, clientId, hideSubClients)
    const siteWhere = jobSiteAddressWhere(jobSiteTerm)
    const hierarchy = await getClientHierarchyMap(user.tenantId)

    const jobs = await prisma.job.findMany({
      where: {
        tenantId: user.tenantId,
        status: { notIn: ['QUOTE', 'CANCELLED'] },
        ...(startDate || endDate
          ? { createdAt: { gte: startDate || undefined, lte: endDate || undefined } }
          : {}),
        ...(effectiveClientIds ? { clientId: { in: effectiveClientIds } } : {}),
        ...(siteWhere ? { addresses: { some: siteWhere } } : {}),
      },
      select: {
        id: true,
        jobNumber: true,
        title: true,
        status: true,
        actualAmount: true,
        estimateAmount: true,
        laborCost: true,
        materialCost: true,
        clientId: true,
        client: { select: { name: true, companyName: true } },
        invoices: { where: { status: { not: 'DRAFT' } }, select: { total: true } },
        purchaseOrders: {
          where: { status: { not: 'CANCELLED' } },
          select: { lineItems: { select: { total: true } } },
        },
        timeEntries: { select: { durationMinutes: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const rows = jobs.map((job) => {
      const invoicedRevenue = job.invoices.reduce((sum, inv) => sum + Number(inv.total), 0)
      const revenue = job.actualAmount != null ? Number(job.actualAmount) : invoicedRevenue
      const laborCost = job.laborCost != null ? Number(job.laborCost) : 0
      const materialCost = job.materialCost != null ? Number(job.materialCost) : 0
      const poSpend = job.purchaseOrders.reduce(
        (sum, po) => sum + po.lineItems.reduce((s, li) => s + Number(li.total), 0),
        0
      )
      const hoursLogged = job.timeEntries.reduce((sum, te) => sum + te.durationMinutes, 0) / 60
      const totalCost = laborCost + materialCost
      const profit = revenue - totalCost
      const marginPercent = revenue > 0 ? (profit / revenue) * 100 : null
      const hasCostData = job.laborCost != null || job.materialCost != null
      const target = rollupTarget(job.clientId, hierarchy, hideSubClients)

      return {
        jobId: job.id,
        jobNumber: job.jobNumber,
        title: job.title,
        status: job.status,
        clientName: target.name || job.client.companyName || job.client.name,
        revenue,
        laborCost,
        materialCost,
        totalCost,
        profit,
        marginPercent,
        poSpend,
        hoursLogged,
        hasCostData,
      }
    })

    const totals = rows.reduce(
      (acc, r) => ({
        revenue: acc.revenue + r.revenue,
        laborCost: acc.laborCost + r.laborCost,
        materialCost: acc.materialCost + r.materialCost,
        profit: acc.profit + r.profit,
      }),
      { revenue: 0, laborCost: 0, materialCost: 0, profit: 0 }
    )
    const jobsMissingCostData = rows.filter((r) => !r.hasCostData).length

    if (format === 'csv') {
      const csvRows: Array<Array<string | number>> = [
        ['Job #', 'Client', 'Title', 'Status', 'Revenue', 'Labor Cost', 'Material Cost', 'Total Cost', 'Profit', 'Margin %', 'PO Spend', 'Hours Logged'],
        ...rows.map((r) => [
          r.jobNumber,
          r.clientName,
          r.title,
          r.status,
          r.revenue.toFixed(2),
          r.laborCost.toFixed(2),
          r.materialCost.toFixed(2),
          r.totalCost.toFixed(2),
          r.profit.toFixed(2),
          r.marginPercent === null ? '' : r.marginPercent.toFixed(1),
          r.poSpend.toFixed(2),
          r.hoursLogged.toFixed(1),
        ]),
        [],
        ['Total Revenue', totals.revenue.toFixed(2)],
        ['Total Labor Cost', totals.laborCost.toFixed(2)],
        ['Total Material Cost', totals.materialCost.toFixed(2)],
        ['Total Profit', totals.profit.toFixed(2)],
      ]
      return csvResponse(csvRows, `job-profitability-${new Date().toISOString().split('T')[0]}.csv`)
    }

    if (format === 'pdf' || format === 'html') {
      const brand = await getPdfBranding(user.tenantId)
      const html = buildJobProfitabilityPdfHtml({ rows, totals, startDate, endDate }, brand)
      if (format === 'html') {
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      try {
        const pdf = await renderPdfFromHtml(html)
        return new NextResponse(pdf, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="job-profitability.pdf"`,
          },
        })
      } catch (e) {
        console.error('Job profitability PDF render failed, falling back to HTML:', e)
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
    }

    return NextResponse.json({ rows, totals, jobsMissingCostData })
  } catch (error) {
    console.error('Job profitability report error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
