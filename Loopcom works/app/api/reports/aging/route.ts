import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildAgingReportPdfHtml } from '@/lib/documents/pdf-templates'
import { csvResponse } from '@/lib/reports/csv'
import { getClientHierarchyMap, jobSiteAddressWhere, resolveClientFilterIds, rollupTarget } from '@/lib/reports/client-filters'

const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const
type Bucket = (typeof BUCKETS)[number]

function bucketFor(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return 'current'
  if (daysOverdue <= 30) return '1-30'
  if (daysOverdue <= 60) return '31-60'
  if (daysOverdue <= 90) return '61-90'
  return '90+'
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'reports.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const format = String(searchParams.get('format') || 'json').toLowerCase()
  const asOfRaw = String(searchParams.get('asOf') || '').trim()
  const asOf = asOfRaw ? new Date(asOfRaw) : new Date()
  const clientId = String(searchParams.get('clientId') || '').trim() || null
  const jobSiteTerm = String(searchParams.get('jobSiteAddress') || '').trim()
  const hideSubClients = String(searchParams.get('hideSubClients') || 'true') !== 'false'

  try {
    const effectiveClientIds = await resolveClientFilterIds(user.tenantId, clientId, hideSubClients)
    const siteWhere = jobSiteAddressWhere(jobSiteTerm)

    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: user.tenantId,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        balance: { gt: 0 },
        ...(effectiveClientIds ? { clientId: { in: effectiveClientIds } } : {}),
        ...(siteWhere ? { job: { addresses: { some: siteWhere } } } : {}),
      },
      include: {
        client: { select: { id: true, name: true, companyName: true } },
        job: { select: { addresses: { where: { type: 'job_site' }, take: 1 } } },
      },
      orderBy: { dueDate: 'asc' },
    })

    type Row = {
      invoiceId: string
      invoiceNumber: string
      clientId: string
      clientName: string
      jobSiteAddress: string | null
      invoiceDate: Date
      dueDate: Date | null
      balance: number
      daysOverdue: number
      bucket: Bucket
    }

    const rows: Row[] = invoices.map((inv) => {
      const dueDate = inv.dueDate || inv.invoiceDate
      const daysOverdue = Math.floor((asOf.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      const addr = inv.job?.addresses?.[0]
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientId: inv.clientId,
        clientName: inv.client.companyName || inv.client.name,
        jobSiteAddress: addr ? [addr.street, addr.city, addr.state].filter(Boolean).join(', ') : null,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        balance: Number(inv.balance),
        daysOverdue,
        bucket: bucketFor(daysOverdue),
      }
    })

    const bucketTotals: Record<Bucket, number> = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
    for (const r of rows) bucketTotals[r.bucket] += r.balance
    const grandTotal = rows.reduce((sum, r) => sum + r.balance, 0)

    // Group by client (rolling sub-customers into their parent when hideSubClients is on)
    const hierarchy = await getClientHierarchyMap(user.tenantId)
    const byClientMap = new Map<
      string,
      { clientId: string; clientName: string; buckets: Record<Bucket, number>; total: number }
    >()
    for (const r of rows) {
      const target = rollupTarget(r.clientId, hierarchy, hideSubClients)
      if (!byClientMap.has(target.id)) {
        byClientMap.set(target.id, {
          clientId: target.id,
          clientName: target.name,
          buckets: { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
          total: 0,
        })
      }
      const entry = byClientMap.get(target.id)!
      entry.buckets[r.bucket] += r.balance
      entry.total += r.balance
    }
    const byClient = Array.from(byClientMap.values()).sort((a, b) => b.total - a.total)

    if (format === 'csv') {
      const csvRows: Array<Array<string | number>> = [
        ['Customer', 'Invoice #', 'Job Site', 'Invoice Date', 'Due Date', 'Days Overdue', 'Bucket', 'Balance'],
        ...rows.map((r) => [
          r.clientName,
          r.invoiceNumber,
          r.jobSiteAddress || '',
          r.invoiceDate.toISOString().split('T')[0],
          r.dueDate ? r.dueDate.toISOString().split('T')[0] : '',
          r.daysOverdue,
          r.bucket,
          r.balance.toFixed(2),
        ]),
        [],
        ['Bucket', 'Total'],
        ...BUCKETS.map((b) => [b, bucketTotals[b].toFixed(2)]),
        ['Grand Total', grandTotal.toFixed(2)],
      ]
      return csvResponse(csvRows, `aging-report-${new Date().toISOString().split('T')[0]}.csv`)
    }

    if (format === 'pdf' || format === 'html') {
      const brand = await getPdfBranding(user.tenantId)
      const html = buildAgingReportPdfHtml({ byClient, bucketTotals, grandTotal, asOf }, brand)
      if (format === 'html') {
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      try {
        const pdf = await renderPdfFromHtml(html)
        return new NextResponse(pdf, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="aging-report.pdf"`,
          },
        })
      } catch (e) {
        console.error('Aging report PDF render failed, falling back to HTML:', e)
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
    }

    return NextResponse.json({ rows, byClient, bucketTotals, grandTotal, asOf })
  } catch (error) {
    console.error('Aging report error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
