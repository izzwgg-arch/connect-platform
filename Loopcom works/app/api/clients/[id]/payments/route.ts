import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { appBaseUrl } from '@/lib/payments/receipts'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const page = Math.max(1, Number(searchParams.get('page') || 1))
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') || 25)))
  const skip = (page - 1) * limit

  try {
    const client = await prisma.client.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      select: { id: true, name: true },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const where = {
      invoice: {
        clientId: client.id,
        tenantId: user.tenantId,
      },
    }

    const [items, total, totalPaidAgg] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
            },
          },
        },
        orderBy: [{ processedAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.payment.count({ where }),
      prisma.payment.aggregate({
        where: {
          ...where,
          status: 'COMPLETED',
          refundStatus: { not: 'FULLY_REFUNDED' },
        },
        _sum: { amount: true },
      }),
    ])

    const appUrl = appBaseUrl()

    const payments = items.map((p) => {
      const displayStatus =
        p.refundStatus === 'FULLY_REFUNDED'
          ? 'REFUNDED'
          : p.refundStatus === 'PARTIALLY_REFUNDED'
            ? 'PARTIALLY_REFUNDED'
            : p.status

      const canReceipt =
        displayStatus === 'COMPLETED' ||
        displayStatus === 'REFUNDED' ||
        displayStatus === 'PARTIALLY_REFUNDED'

      return {
        id: p.id,
        amount: Number(p.amount || 0),
        currency: p.currency || 'USD',
        status: displayStatus,
        refundStatus: p.refundStatus,
        refundedAmount: Number(p.refundedAmount || 0),
        method: p.method,
        reference: p.reference,
        provider: p.provider,
        providerPaymentId: p.providerPaymentId || p.solaTransactionId || null,
        processedAt: p.processedAt,
        createdAt: p.createdAt,
        invoiceId: p.invoice?.id || null,
        invoiceNumber: p.invoice?.invoiceNumber || '',
        receiptEmailSentAt: p.receiptEmailSentAt,
        receiptUrl: p.receiptToken
          ? `${appUrl}/pay/receipt/${encodeURIComponent(p.receiptToken)}`
          : null,
        canReceipt,
      }
    })

    return NextResponse.json({
      client: { id: client.id, name: client.name },
      payments,
      summary: {
        totalPaid: Number(totalPaidAgg._sum.amount || 0),
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    console.error('Client payments list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
