import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildRevenueReportPdfHtml } from '@/lib/documents/pdf-templates'
import { csvResponse } from '@/lib/reports/csv'
import { jobSiteAddressWhere, resolveClientFilterIds } from '@/lib/reports/client-filters'

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
  const clientId = String(searchParams.get('clientId') || '').trim() || null
  const jobSiteTerm = String(searchParams.get('jobSiteAddress') || '').trim()
  const hideSubClients = String(searchParams.get('hideSubClients') || 'true') !== 'false'

  const endDate = endDateRaw ? new Date(endDateRaw + 'T23:59:59.999') : new Date()
  const startDate = startDateRaw
    ? new Date(startDateRaw)
    : new Date(endDate.getFullYear(), endDate.getMonth() - 11, 1) // default: trailing 12 months

  try {
    const effectiveClientIds = await resolveClientFilterIds(user.tenantId, clientId, hideSubClients)
    const clientSqlFilter = effectiveClientIds
      ? Prisma.sql`AND i."clientId" IN (${Prisma.join(effectiveClientIds)})`
      : Prisma.empty
    const jobSiteSqlFilter = jobSiteTerm
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM addresses addr
          WHERE addr."jobId" = i."jobId" AND addr.type = 'job_site'
            AND (addr.street ILIKE ${`%${jobSiteTerm}%`} OR addr.city ILIKE ${`%${jobSiteTerm}%`}
                 OR addr.state ILIKE ${`%${jobSiteTerm}%`} OR addr."zipCode" ILIKE ${`%${jobSiteTerm}%`})
        )`
      : Prisma.empty

    const invoiced = await prisma.$queryRaw<Array<{ month: string; revenue: string }>>`
      SELECT TO_CHAR(i."invoiceDate", 'YYYY-MM') as month, COALESCE(SUM(i.total), 0)::text as revenue
      FROM invoices i
      WHERE i."tenantId" = ${user.tenantId}
        AND i.status NOT IN ('DRAFT', 'CANCELLED')
        AND i."invoiceDate" >= ${startDate}
        AND i."invoiceDate" <= ${endDate}
        ${clientSqlFilter}
        ${jobSiteSqlFilter}
      GROUP BY TO_CHAR(i."invoiceDate", 'YYYY-MM')
      ORDER BY month ASC
    `

    const collected = await prisma.$queryRaw<Array<{ month: string; amount: string }>>`
      SELECT TO_CHAR(p."processedAt", 'YYYY-MM') as month, COALESCE(SUM(p.amount - p."refundedAmount"), 0)::text as amount
      FROM payments p
      JOIN invoices i ON i.id = p."invoiceId"
      WHERE i."tenantId" = ${user.tenantId}
        AND p.status = 'COMPLETED'
        AND p."processedAt" >= ${startDate}
        AND p."processedAt" <= ${endDate}
        ${clientSqlFilter}
        ${jobSiteSqlFilter}
      GROUP BY TO_CHAR(p."processedAt", 'YYYY-MM')
      ORDER BY month ASC
    `

    // invoice.paidAmount is kept accurate by both the local payment flow and
    // the QuickBooks sync, so it can be ahead of what local `payments` rows
    // add up to (money collected through QuickBooks directly, without a
    // matching TrimPro payment record). Fold that gap into "Collected" too,
    // bucketed by paidAt, so this doesn't understate real collections.
    const externalCollected = await prisma.$queryRaw<Array<{ month: string; amount: string }>>`
      SELECT month, COALESCE(SUM(gap), 0)::text as amount
      FROM (
        SELECT
          TO_CHAR(i."paidAt", 'YYYY-MM') as month,
          i."paidAmount" - COALESCE((
            SELECT SUM(p.amount - p."refundedAmount")
            FROM payments p
            WHERE p."invoiceId" = i.id AND p.status = 'COMPLETED'
          ), 0) AS gap
        FROM invoices i
        WHERE i."tenantId" = ${user.tenantId}
          AND i."paidAt" IS NOT NULL
          AND i."paidAt" >= ${startDate}
          AND i."paidAt" <= ${endDate}
          ${clientSqlFilter}
          ${jobSiteSqlFilter}
      ) sub
      WHERE gap > 0.01
      GROUP BY month
    `

    const invoicedMap = new Map(invoiced.map((r) => [r.month, Number(r.revenue)]))
    const collectedMap = new Map(collected.map((r) => [r.month, Number(r.amount)]))
    for (const row of externalCollected) {
      collectedMap.set(row.month, (collectedMap.get(row.month) || 0) + Number(row.amount))
    }

    // Build a complete list of months in range so gaps show as $0, not missing.
    const months: string[] = []
    const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1)
    while (cursor <= end) {
      months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
      cursor.setMonth(cursor.getMonth() + 1)
    }

    const rows = months.map((month) => ({
      month,
      invoiced: invoicedMap.get(month) || 0,
      collected: collectedMap.get(month) || 0,
    }))

    const totalInvoiced = rows.reduce((sum, r) => sum + r.invoiced, 0)
    const totalCollected = rows.reduce((sum, r) => sum + r.collected, 0)

    // Period-over-period: compare to the immediately preceding period of equal length.
    const periodMs = endDate.getTime() - startDate.getTime()
    const prevEnd = new Date(startDate.getTime() - 1)
    const prevStart = new Date(prevEnd.getTime() - periodMs)
    const siteWhere = jobSiteAddressWhere(jobSiteTerm)
    const prevInvoicedResult = await prisma.invoice.aggregate({
      where: {
        tenantId: user.tenantId,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        invoiceDate: { gte: prevStart, lte: prevEnd },
        ...(effectiveClientIds ? { clientId: { in: effectiveClientIds } } : {}),
        ...(siteWhere ? { job: { addresses: { some: siteWhere } } } : {}),
      },
      _sum: { total: true },
    })
    const prevInvoiced = Number(prevInvoicedResult._sum.total || 0)
    const changePercent = prevInvoiced > 0 ? ((totalInvoiced - prevInvoiced) / prevInvoiced) * 100 : null

    const summary = { totalInvoiced, totalCollected, prevInvoiced, changePercent }

    if (format === 'csv') {
      const csvRows: Array<Array<string | number>> = [
        ['Month', 'Invoiced', 'Collected'],
        ...rows.map((r) => [r.month, r.invoiced.toFixed(2), r.collected.toFixed(2)]),
        [],
        ['Total Invoiced', totalInvoiced.toFixed(2)],
        ['Total Collected', totalCollected.toFixed(2)],
        ['Previous Period Invoiced', prevInvoiced.toFixed(2)],
        ['Change %', changePercent === null ? 'N/A' : changePercent.toFixed(1)],
      ]
      return csvResponse(csvRows, `revenue-report-${new Date().toISOString().split('T')[0]}.csv`)
    }

    if (format === 'pdf' || format === 'html') {
      const brand = await getPdfBranding(user.tenantId)
      const html = buildRevenueReportPdfHtml({ rows, summary, startDate, endDate }, brand)
      if (format === 'html') {
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      try {
        const pdf = await renderPdfFromHtml(html)
        return new NextResponse(pdf, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="revenue-report.pdf"`,
          },
        })
      } catch (e) {
        console.error('Revenue report PDF render failed, falling back to HTML:', e)
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
    }

    return NextResponse.json({ rows, summary })
  } catch (error) {
    console.error('Revenue report error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
