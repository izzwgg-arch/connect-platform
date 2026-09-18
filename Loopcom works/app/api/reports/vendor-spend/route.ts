import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildVendorSpendPdfHtml } from '@/lib/documents/pdf-templates'
import { csvResponse } from '@/lib/reports/csv'
import { jobSiteAddressWhere, resolveClientFilterIds } from '@/lib/reports/client-filters'

// Draft/pending/cancelled POs aren't committed spend yet.
const SPEND_STATUSES = ['APPROVED', 'ORDERED', 'RECEIVED'] as const

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

    // PO creation never sets PurchaseOrder.clientId directly — client is normally
    // only known via the linked job — so match either in case clientId is ever set.
    const where: Record<string, any> = {
      tenantId: user.tenantId,
      status: { in: [...SPEND_STATUSES] },
      ...(startDate || endDate ? { orderDate: { gte: startDate || undefined, lte: endDate || undefined } } : {}),
    }
    if (effectiveClientIds) {
      where.OR = [{ clientId: { in: effectiveClientIds } }, { job: { clientId: { in: effectiveClientIds } } }]
    }
    if (siteWhere) {
      where.job = { ...(where.job || {}), addresses: { some: siteWhere } }
    }

    const orders = await prisma.purchaseOrder.findMany({
      where,
      select: {
        id: true,
        poNumber: true,
        vendor: true,
        vendorId: true,
        total: true,
        orderDate: true,
        status: true,
        vendorRef: { select: { name: true } },
      },
      orderBy: { orderDate: 'desc' },
    })

    type VendorAgg = { vendorKey: string; vendorName: string; poCount: number; total: number }
    const byVendorMap = new Map<string, VendorAgg>()
    for (const po of orders) {
      const vendorKey = po.vendorId || `name:${po.vendor}`
      const vendorName = po.vendorRef?.name || po.vendor
      if (!byVendorMap.has(vendorKey)) {
        byVendorMap.set(vendorKey, { vendorKey, vendorName, poCount: 0, total: 0 })
      }
      const entry = byVendorMap.get(vendorKey)!
      entry.poCount += 1
      entry.total += Number(po.total)
    }
    const byVendor = Array.from(byVendorMap.values()).sort((a, b) => b.total - a.total)
    const grandTotal = byVendor.reduce((sum, v) => sum + v.total, 0)

    const orderRows = orders.map((po) => ({
      poId: po.id,
      poNumber: po.poNumber,
      vendorName: po.vendorRef?.name || po.vendor,
      total: Number(po.total),
      orderDate: po.orderDate,
      status: po.status,
    }))

    if (format === 'csv') {
      const csvRows: Array<Array<string | number>> = [
        ['Vendor', 'PO Count', 'Total Spend'],
        ...byVendor.map((v) => [v.vendorName, v.poCount, v.total.toFixed(2)]),
        [],
        ['Grand Total', '', grandTotal.toFixed(2)],
        [],
        ['PO #', 'Vendor', 'Order Date', 'Status', 'Total'],
        ...orderRows.map((o) => [
          o.poNumber,
          o.vendorName,
          o.orderDate ? o.orderDate.toISOString().split('T')[0] : '',
          o.status,
          o.total.toFixed(2),
        ]),
      ]
      return csvResponse(csvRows, `vendor-spend-${new Date().toISOString().split('T')[0]}.csv`)
    }

    if (format === 'pdf' || format === 'html') {
      const brand = await getPdfBranding(user.tenantId)
      const html = buildVendorSpendPdfHtml({ byVendor, grandTotal, startDate, endDate }, brand)
      if (format === 'html') {
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      try {
        const pdf = await renderPdfFromHtml(html)
        return new NextResponse(pdf, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="vendor-spend.pdf"`,
          },
        })
      } catch (e) {
        console.error('Vendor spend PDF render failed, falling back to HTML:', e)
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
    }

    return NextResponse.json({ byVendor, grandTotal, orders: orderRows })
  } catch (error) {
    console.error('Vendor spend report error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
