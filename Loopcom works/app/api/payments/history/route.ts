import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { csvResponse } from '@/lib/reports/csv'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildPaymentHistoryPdfHtml } from '@/lib/documents/pdf-templates'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const format = String(searchParams.get('format') || 'json').toLowerCase()
  const isFullExport = format === 'csv' || format === 'pdf' || format === 'html'
  const page = Math.max(1, Number(searchParams.get('page') || 1))
  const limit = isFullExport ? 5000 : Math.min(100, Math.max(1, Number(searchParams.get('limit') || 25)))
  const skip = isFullExport ? 0 : (page - 1) * limit

  const provider = String(searchParams.get('provider') || '').trim().toLowerCase()
  const status = String(searchParams.get('status') || '').trim().toUpperCase()
  const q = String(searchParams.get('q') || '').trim()
  const startDateRaw = String(searchParams.get('startDate') || '').trim()
  const endDateRaw = String(searchParams.get('endDate') || '').trim()

  const startDate = startDateRaw ? new Date(startDateRaw) : null
  const endDate = endDateRaw ? new Date(endDateRaw) : null

  const providerWhere =
    provider === 'sola' || provider === 'quickbooks'
      ? { provider }
      : undefined

  const where: any = {
    invoice: {
      tenantId: user.tenantId,
    },
    ...(providerWhere ? providerWhere : {}),
    ...(status
      ? {
          OR: [
            { status },
            // Allow filtering refunded records via computed refund state too.
            ...(status === 'REFUNDED' ? [{ refundStatus: { in: ['PARTIALLY_REFUNDED', 'FULLY_REFUNDED'] } }] : []),
          ],
        }
      : {}),
    ...(startDate || endDate
      ? {
          createdAt: {
            ...(startDate ? { gte: startDate } : {}),
            ...(endDate ? { lte: endDate } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { id: { contains: q, mode: 'insensitive' } },
            { providerPaymentId: { contains: q, mode: 'insensitive' } },
            { providerInvoiceId: { contains: q, mode: 'insensitive' } },
            { reference: { contains: q, mode: 'insensitive' } },
            {
              invoice: {
                invoiceNumber: { contains: q, mode: 'insensitive' },
              },
            },
            {
              invoice: {
                client: {
                  name: { contains: q, mode: 'insensitive' },
                },
              },
            },
          ],
        }
      : {}),
  }

  try {
    const [items, total, aggregate, succeededCount, failedCount] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              client: { select: { id: true, name: true } },
            },
          },
          refunds: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              refundedAt: true,
              amount: true,
              providerRefundId: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.payment.count({ where }),
      // Sums across the full filtered set, not just the current page.
      prisma.payment.aggregate({ where, _sum: { amount: true, refundedAmount: true } }),
      prisma.payment.count({ where: { ...where, status: 'COMPLETED' } }),
      prisma.payment.count({ where: { ...where, status: 'FAILED' } }),
    ])

    const rows = items.map((p) => {
      const latestRefund = p.refunds?.[0] || null
      const provider = String(p.provider || (p.method === 'ACH' ? 'quickbooks' : 'sola') || 'unknown').toUpperCase()
      const computedStatus =
        p.refundStatus === 'FULLY_REFUNDED'
          ? 'REFUNDED'
          : p.status
      return {
        id: p.id,
        provider,
        providerPaymentId: p.providerPaymentId || p.solaTransactionId || p.reference || '',
        providerInvoiceId: p.providerInvoiceId || p.invoice?.invoiceNumber || '',
        providerRealmId: p.providerRealmId || null,
        customerName: p.invoice?.client?.name || 'Unknown',
        invoiceId: p.invoice?.id || null,
        invoiceNumber: p.invoice?.invoiceNumber || '',
        amount: Number(p.amount || 0),
        currency: p.currency || 'USD',
        paymentMethod: p.method,
        status: computedStatus,
        refundStatus: p.refundStatus,
        refundedAmount: Number(p.refundedAmount || 0),
        createdAt: p.createdAt,
        refundedAt: p.refundedAt || latestRefund?.refundedAt || null,
        latestRefund,
      }
    })

    if (format === 'csv') {
      const csvRows: Array<Array<string | number>> = [
        ['Date', 'Customer', 'Invoice #', 'Provider', 'Method', 'Status', 'Amount', 'Refunded', 'Reference'],
        ...rows.map((r) => [
          r.createdAt.toISOString().split('T')[0],
          r.customerName,
          r.invoiceNumber,
          r.provider,
          r.paymentMethod,
          r.status,
          r.amount.toFixed(2),
          r.refundedAmount.toFixed(2),
          r.providerPaymentId,
        ]),
      ]
      return csvResponse(csvRows, `payment-history-${new Date().toISOString().split('T')[0]}.csv`)
    }

    if (format === 'pdf' || format === 'html') {
      const brand = await getPdfBranding(user.tenantId)
      const html = buildPaymentHistoryPdfHtml(
        {
          rows,
          summary: {
            totalAmount: Number(aggregate._sum.amount || 0),
            totalRefunded: Number(aggregate._sum.refundedAmount || 0),
            succeededCount,
            failedCount,
          },
          startDate,
          endDate,
        },
        brand
      )
      if (format === 'html') {
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      try {
        const pdf = await renderPdfFromHtml(html)
        return new NextResponse(pdf, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="payment-history.pdf"`,
          },
        })
      } catch (e) {
        console.error('Payment history PDF render failed, falling back to HTML:', e)
        return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
    }

    return NextResponse.json({
      payments: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      summary: {
        totalAmount: Number(aggregate._sum.amount || 0),
        totalRefunded: Number(aggregate._sum.refundedAmount || 0),
        succeededCount,
        failedCount,
      },
    })
  } catch (error) {
    console.error('Payment history list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

