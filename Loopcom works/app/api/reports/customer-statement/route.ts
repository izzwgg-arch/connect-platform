import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildCustomerStatementPdfHtml } from '@/lib/documents/pdf-templates'
import { csvResponse } from '@/lib/reports/csv'
import { jobSiteAddressWhere, resolveClientFilterIds } from '@/lib/reports/client-filters'

type TransactionRow = {
  date: Date
  type: 'INVOICE' | 'PAYMENT' | 'CREDIT_MEMO'
  description: string
  reference: string
  debit: number
  credit: number
  /** Only set on INVOICE rows — lets the UI filter to just still-open invoices. */
  invoiceBalance?: number
  invoiceStatus?: string
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'reports.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const clientId = String(searchParams.get('clientId') || '').trim()
  const format = String(searchParams.get('format') || 'json').toLowerCase()
  const startDateRaw = String(searchParams.get('startDate') || '').trim()
  const endDateRaw = String(searchParams.get('endDate') || '').trim()
  const startDate = startDateRaw ? new Date(startDateRaw) : null
  const endDate = endDateRaw ? new Date(endDateRaw + 'T23:59:59.999') : null
  const jobSiteTerm = String(searchParams.get('jobSiteAddress') || '').trim()
  const hideSubClients = String(searchParams.get('hideSubClients') || 'true') !== 'false'

  if (!clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  }

  try {
    const client = await prisma.client.findFirst({
      where: { id: clientId, tenantId: user.tenantId },
      include: {
        addresses: { where: { type: 'billing' }, take: 1 },
      },
    })
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // When rolling up, include this client's sub-customers' invoices in one
    // consolidated statement (each line labeled with which entity it belongs to).
    const effectiveClientIds = await resolveClientFilterIds(user.tenantId, clientId, hideSubClients)
    const siteWhere = jobSiteAddressWhere(jobSiteTerm)

    const dateFilter =
      startDate || endDate
        ? { gte: startDate || undefined, lte: endDate || undefined }
        : undefined

    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: user.tenantId,
        clientId: { in: effectiveClientIds || [clientId] },
        status: { not: 'DRAFT' },
        ...(dateFilter ? { invoiceDate: dateFilter } : {}),
        ...(siteWhere ? { job: { addresses: { some: siteWhere } } } : {}),
      },
      include: {
        client: { select: { id: true, name: true, companyName: true } },
        payments: {
          where: { status: 'COMPLETED' },
          orderBy: { createdAt: 'asc' },
        },
        creditMemoApplications: {
          include: { creditMemo: { select: { creditMemoNumber: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { invoiceDate: 'asc' },
    })

    const transactions: TransactionRow[] = []
    for (const inv of invoices) {
      // Only label sub-customer transactions when this is a consolidated (rolled-up) view.
      const subLabel = inv.clientId !== clientId ? `${inv.client.companyName || inv.client.name} — ` : ''
      transactions.push({
        date: inv.invoiceDate,
        type: 'INVOICE',
        description: `${subLabel}${inv.title || 'Invoice'}`,
        reference: inv.invoiceNumber,
        debit: Number(inv.total),
        credit: 0,
        invoiceBalance: Number(inv.balance),
        invoiceStatus: inv.status,
      })
      let localNetPaid = 0
      for (const p of inv.payments) {
        const netPaid = Number(p.amount) - Number(p.refundedAmount || 0)
        localNetPaid += netPaid
        if (netPaid <= 0) continue
        transactions.push({
          date: p.processedAt || p.createdAt,
          type: 'PAYMENT',
          description: `${subLabel}Payment (${p.method}${p.reference ? ` - ${p.reference}` : ''})`,
          reference: inv.invoiceNumber,
          debit: 0,
          credit: netPaid,
        })
      }
      // invoice.paidAmount is kept accurate by both the local payment flow and
      // the QuickBooks sync. If it's ahead of what we have local Payment rows
      // for, the rest was paid through QuickBooks directly — reconcile the gap
      // so the ledger's running balance matches the invoice's real balance,
      // instead of only reflecting payments TrimPro happened to record.
      const externalGap = Number(inv.paidAmount) - localNetPaid
      if (externalGap > 0.01) {
        transactions.push({
          date: inv.paidAt || inv.updatedAt,
          type: 'PAYMENT',
          description: `${subLabel}Payment (recorded in QuickBooks)`,
          reference: inv.invoiceNumber,
          debit: 0,
          credit: externalGap,
        })
      }
      for (const app of inv.creditMemoApplications) {
        transactions.push({
          date: app.createdAt,
          type: 'CREDIT_MEMO',
          description: `${subLabel}Credit memo applied (${app.creditMemo.creditMemoNumber})`,
          reference: inv.invoiceNumber,
          debit: 0,
          credit: Number(app.amount),
        })
      }
    }

    transactions.sort((a, b) => a.date.getTime() - b.date.getTime())

    let runningBalance = 0
    const ledger = transactions.map((t) => {
      runningBalance += t.debit - t.credit
      return { ...t, balance: runningBalance }
    })

    const totalInvoiced = transactions.reduce((sum, t) => sum + t.debit, 0)
    const totalPaid = transactions
      .filter((t) => t.type === 'PAYMENT')
      .reduce((sum, t) => sum + t.credit, 0)
    const totalCredited = transactions
      .filter((t) => t.type === 'CREDIT_MEMO')
      .reduce((sum, t) => sum + t.credit, 0)

    const summary = {
      totalInvoiced,
      totalPaid,
      totalCredited,
      balance: runningBalance,
      invoiceCount: invoices.length,
    }

    if (format === 'csv') {
      const rows: Array<Array<string | number>> = [
        ['Date', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'],
        ...ledger.map((t) => [
          t.date.toISOString().split('T')[0],
          t.type,
          t.reference,
          t.description,
          t.debit ? t.debit.toFixed(2) : '',
          t.credit ? t.credit.toFixed(2) : '',
          t.balance.toFixed(2),
        ]),
        [],
        ['Total Invoiced', totalInvoiced.toFixed(2)],
        ['Total Paid', totalPaid.toFixed(2)],
        ['Total Credited', totalCredited.toFixed(2)],
        ['Balance Due', runningBalance.toFixed(2)],
      ]
      return csvResponse(rows, `statement-${client.name.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().split('T')[0]}.csv`)
    }

    if (format === 'pdf' || format === 'html') {
      const brand = await getPdfBranding(user.tenantId)
      const html = buildCustomerStatementPdfHtml({ client, ledger, summary, startDate, endDate }, brand)
      if (format === 'html') {
        return new NextResponse(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
      try {
        const pdf = await renderPdfFromHtml(html)
        return new NextResponse(pdf, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="statement-${client.name.replace(/[^a-z0-9]/gi, '-')}.pdf"`,
          },
        })
      } catch (e) {
        console.error('Customer statement PDF render failed, falling back to HTML:', e)
        return new NextResponse(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
    }

    return NextResponse.json({
      client: {
        id: client.id,
        name: client.name,
        companyName: client.companyName,
        email: client.email,
        phone: client.phone,
      },
      ledger,
      summary,
    })
  } catch (error) {
    console.error('Customer statement report error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
