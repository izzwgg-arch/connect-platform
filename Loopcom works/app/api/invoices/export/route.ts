/**
 * GET /api/invoices/export
 *
 * Query params:
 *   status   — filter by status (all | PAID | UNPAID_OVERDUE | DRAFT | SENT | VIEWED | PARTIAL | OVERDUE | CANCELLED)
 *   search   — text search on invoice number / title / client name
 *   ids      — comma-separated invoice IDs (export only these specific invoices)
 *
 * Returns an .xlsx file download.
 */
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import * as XLSX from 'xlsx'
import { invoiceJobSiteAddressSearchClauses } from '@/lib/search/job-site-address'
import { applySmartSearch, buildSmartSearchAnd, clientIdentityClauses, ilike } from '@/lib/search/prisma-filters'

export const dynamic = 'force-dynamic'

function fmt(n: any): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  if (isNaN(dt.getTime())) return ''
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.export')
  if (permError) return permError
  const user = getAuthUser(request)

  const { searchParams } = new URL(request.url)
  const status  = searchParams.get('status')  || 'all'
  const search  = searchParams.get('search')  || ''
  const idsParam = searchParams.get('ids')    || ''

  // Build Prisma where clause
  const where: any = { tenantId: user.tenantId }

  if (idsParam) {
    // Specific IDs requested — override status/search filters
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
    where.id = { in: ids }
  } else {
    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { invoiceNumber: ilike(term) },
        { title: ilike(term) },
        ...clientIdentityClauses(term),
        { job: { jobNumber: ilike(term) } },
        { job: { title: ilike(term) } },
        { client: { addresses: { some: { street: ilike(term) } } } },
        { client: { addresses: { some: { city: ilike(term) } } } },
        { client: { addresses: { some: { state: ilike(term) } } } },
        { client: { addresses: { some: { zipCode: ilike(term) } } } },
        ...invoiceJobSiteAddressSearchClauses(term),
      ])
    )
    if (status !== 'all') {
      if (status === 'UNPAID_OVERDUE') {
        where.status = { in: ['DRAFT', 'SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'] }
      } else if (status === 'PAID') {
        where.status = 'PAID'
      } else {
        where.status = status
      }
    }
  }

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      client: { select: { id: true, name: true, companyName: true, email: true, phone: true } },
      job:    { select: { id: true, jobNumber: true, title: true } },
    },
    orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
    take: 5000, // safety cap
  })

  // Build rows
  const rows = invoices.map((inv) => ({
    'Invoice #':     inv.invoiceNumber,
    'Title':         inv.title,
    'Status':        inv.status,
    'Client':        inv.client.name,
    'Company':       inv.client.companyName || '',
    'Client Email':  inv.client.email       || '',
    'Client Phone':  inv.client.phone       || '',
    'Job #':         inv.job?.jobNumber      || '',
    'Invoice Date':  fmtDate(inv.invoiceDate),
    'Due Date':      fmtDate(inv.dueDate),
    'Total ($)':     fmt(inv.total),
    'Paid ($)':      fmt(inv.paidAmount),
    'Balance ($)':   fmt(inv.balance),
    'Sent At':       fmtDate(inv.sentAt),
    'Paid At':       fmtDate(inv.paidAt),
    'QB Sync ID':    inv.qboSyncId || '',
  }))

  // Build workbook
  const wb  = XLSX.utils.book_new()
  const ws  = XLSX.utils.json_to_sheet(rows)

  // Column widths
  ws['!cols'] = [
    { wch: 14 }, // Invoice #
    { wch: 30 }, // Title
    { wch: 12 }, // Status
    { wch: 25 }, // Client
    { wch: 25 }, // Company
    { wch: 28 }, // Client Email
    { wch: 16 }, // Client Phone
    { wch: 10 }, // Job #
    { wch: 14 }, // Invoice Date
    { wch: 12 }, // Due Date
    { wch: 12 }, // Total
    { wch: 12 }, // Paid
    { wch: 12 }, // Balance
    { wch: 14 }, // Sent At
    { wch: 14 }, // Paid At
    { wch: 16 }, // QB Sync ID
  ]

  XLSX.utils.book_append_sheet(wb, ws, 'Invoices')

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  const filterLabel = idsParam
    ? `selected-${invoices.length}`
    : status !== 'all' ? status.toLowerCase() : 'all'
  const filename = `invoices-${filterLabel}-${new Date().toISOString().slice(0, 10)}.xlsx`

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
    },
  })
}
