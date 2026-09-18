import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { notifyInvoicePaid } from '@/lib/notifications'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { afterInvoicePayment } from '@/lib/payments/after-invoice-payment'
import { applyInvoicePayment } from '@/lib/payments/apply-payment'

const ALLOWED_METHODS = new Set(['CHECK', 'QUICK_PAY', 'OTHER'])

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.manage')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const method = String(body?.method || '').trim().toUpperCase()
    const methodLabel = String(body?.methodLabel || '').trim() // custom label for OTHER
    const amountRaw = body?.amount
    const reference = String(body?.reference || '').trim()
    const paidAtRaw = body?.paidAt ? new Date(String(body.paidAt)) : null
    const processedAt =
      paidAtRaw && !Number.isNaN(paidAtRaw.getTime()) ? paidAtRaw : new Date()

    if (!ALLOWED_METHODS.has(method)) {
      return NextResponse.json(
        { error: 'Payment method must be CHECK, QUICK_PAY, or OTHER' },
        { status: 400 }
      )
    }
    if (method === 'OTHER' && !methodLabel) {
      return NextResponse.json(
        { error: 'Please enter a payment type name.' },
        { status: 400 }
      )
    }

    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        client: {
          select: {
            name: true,
          },
        },
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.status === 'CANCELLED' || invoice.status === 'REFUNDED') {
      return NextResponse.json(
        { error: `Cannot mark a ${invoice.status.toLowerCase()} invoice as paid.` },
        { status: 400 }
      )
    }

    const remaining = Math.max(0, toNumber(invoice.total) - toNumber(invoice.paidAmount))
    if (remaining <= 0) {
      return NextResponse.json({ error: 'Invoice is already fully paid.' }, { status: 400 })
    }

    const requestedAmount = amountRaw === undefined || amountRaw === null ? remaining : toNumber(amountRaw)
    if (requestedAmount <= 0) {
      return NextResponse.json({ error: 'Payment amount must be greater than zero.' }, { status: 400 })
    }

    const paymentNotes =
      method === 'CHECK'
        ? 'Manually marked as paid by check'
        : method === 'QUICK_PAY'
          ? 'Manually marked as paid by Quick Pay'
          : `Manually marked as paid — ${methodLabel}`

    const result = await applyInvoicePayment({
      invoiceId: invoice.id,
      tenantId: user.tenantId,
      amount: requestedAmount,
      method:
        method === 'CHECK'
          ? 'CHECK'
          : methodLabel.toLowerCase() === 'cash'
            ? 'CASH'
            : 'OTHER',
      provider: method === 'QUICK_PAY' ? 'quick_pay' : method === 'OTHER' ? methodLabel.toLowerCase().replace(/\s+/g, '_') : 'manual',
      reference: reference || null,
      processedAt,
      notes: paymentNotes,
    })

    if (!result.created || !result.paymentId || !result.invoice) {
      return NextResponse.json({ error: 'Unable to record this payment.' }, { status: 400 })
    }

    const createdPayment = { id: result.paymentId }
    const amount = Math.max(0, toNumber(result.invoice.paidAmount) - toNumber(invoice.paidAmount))
    const newPaidAmount = toNumber(result.invoice.paidAmount)
    const newBalance = toNumber(result.invoice.balance)
    const nextStatus = result.invoice.status

    try {
      await enqueueQboSync(user.tenantId, 'payment', createdPayment.id)
    } catch (error) {
      console.error('QuickBooks payment sync trigger error (manual mark paid):', error)
    }

    await notifyInvoicePaid(
      user.tenantId,
      invoice.id,
      invoice.invoiceNumber,
      amount,
      invoice.client?.name || 'Customer'
    ).catch(() => null)

    await afterInvoicePayment(invoice.id).catch((error) => {
      console.error('[mark-paid] afterInvoicePayment failed:', { invoiceId: invoice.id, error })
    })

    return NextResponse.json({
      ok: true,
      payment: {
        id: createdPayment.id,
        amount,
        method,
      },
      invoice: {
        id: invoice.id,
        status: nextStatus,
        paidAmount: newPaidAmount,
        balance: newBalance,
      },
    })
  } catch (error) {
    console.error('Manual mark-paid error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
