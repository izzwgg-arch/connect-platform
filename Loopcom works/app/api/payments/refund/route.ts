import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { solaService } from '@/lib/services/sola'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'

type RefundProviderResult = {
  providerRefundId: string | null
  rawResponse: any
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  }) as Promise<T>
}

function toMoney(value: any): number {
  const n = Number(value || 0)
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0
}

function normalizeProvider(payment: {
  provider?: string | null
  method: string
}): 'sola' | 'quickbooks' {
  const p = String(payment.provider || '').toLowerCase().trim()
  if (p === 'quickbooks' || p === 'qbo' || p === 'qbo_ach') return 'quickbooks'
  if (p === 'sola') return 'sola'
  return payment.method === 'ACH' ? 'quickbooks' : 'sola'
}

async function refundWithSola(params: {
  paymentProviderId: string
  amount: number
}): Promise<RefundProviderResult> {
  const rawResponse = await withTimeout(
    solaService.refundPayment(params.paymentProviderId, params.amount),
    30_000,
    'SOLA refund timed out'
  )
  const providerRefundId =
    rawResponse?.id ||
    rawResponse?.refundId ||
    rawResponse?.transactionId ||
    rawResponse?.TransactionID ||
    null
  return { providerRefundId, rawResponse }
}

async function refundWithQuickBooks(params: {
  tenantId: string
  qboInvoiceId: string
  amount: number
  reason?: string | null
}): Promise<RefundProviderResult> {
  const session = await getQboSessionForTenant(params.tenantId)
  if (!session) {
    throw new Error('QuickBooks session not connected')
  }

  const qboInvoiceRes = await withTimeout(
    quickBooksService.makeAPIRequest(
      session.accessToken,
      session.realmId,
      `/invoice/${params.qboInvoiceId}`,
      'GET'
    ),
    30_000,
    'QuickBooks invoice lookup timed out'
  )
  const qboInvoice = qboInvoiceRes?.Invoice
  const customerRef = qboInvoice?.CustomerRef?.value
  if (!customerRef) {
    throw new Error('QuickBooks refund failed: missing customer reference')
  }

  const payload = {
    CustomerRef: { value: String(customerRef) },
    TxnDate: new Date().toISOString().slice(0, 10),
    PrivateNote: params.reason || 'Refund from TrimPro',
    TotalAmt: params.amount,
    Line: [
      {
        Amount: params.amount,
        DetailType: 'SalesItemLineDetail',
        Description: params.reason || 'Invoice refund',
        SalesItemLineDetail: {},
      },
    ],
  }

  const rawResponse = await withTimeout(
    quickBooksService.makeAPIRequest(
      session.accessToken,
      session.realmId,
      '/refundreceipt',
      'POST',
      payload
    ),
    30_000,
    'QuickBooks refund timed out'
  )

  const providerRefundId =
    rawResponse?.RefundReceipt?.Id ||
    rawResponse?.Id ||
    null
  return { providerRefundId, rawResponse }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.refund')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const paymentId = String(body?.paymentId || '').trim()
    const reason = String(body?.reason || '').trim() || null
    const fullRefund = Boolean(body?.fullRefund)
    const idempotencyKey = String(body?.idempotencyKey || '').trim()
    const partialAmount = toMoney(body?.partialAmount)

    if (!paymentId) {
      return NextResponse.json({ error: 'paymentId is required' }, { status: 400 })
    }

    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        invoice: { tenantId: user.tenantId },
      },
      include: {
        invoice: {
          select: {
            id: true,
            tenantId: true,
            total: true,
            paidAmount: true,
            balance: true,
            status: true,
            qboSyncId: true,
            invoiceNumber: true,
            clientId: true,
          },
        },
      },
    })

    if (!payment) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    const originalAmount = toMoney(payment.amount)
    const currentRefunded = toMoney(payment.refundedAmount)
    const refundableRemaining = toMoney(originalAmount - currentRefunded)

    if (refundableRemaining <= 0) {
      return NextResponse.json({ error: 'Payment already fully refunded' }, { status: 409 })
    }

    const refundAmount = fullRefund ? refundableRemaining : partialAmount
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return NextResponse.json({ error: 'Valid refund amount is required' }, { status: 400 })
    }
    if (refundAmount > refundableRemaining) {
      return NextResponse.json(
        { error: `Refund exceeds refundable amount (${refundableRemaining.toFixed(2)})` },
        { status: 400 }
      )
    }

    const effectiveIdemKey =
      idempotencyKey ||
      `refund:${payment.id}:${refundAmount.toFixed(2)}:${reason || ''}`

    const existingRefund = await prisma.paymentRefund.findUnique({
      where: { idempotencyKey: effectiveIdemKey },
    })
    if (existingRefund) {
      // Retry-safe return for previously-processed idempotent requests.
      if (existingRefund.status === 'COMPLETED' || existingRefund.status === 'REFUNDED') {
        return NextResponse.json({
          ok: true,
          idempotent: true,
          refund: existingRefund,
        })
      }
      if (existingRefund.status === 'PROCESSING' || existingRefund.status === 'PENDING') {
        return NextResponse.json(
          { error: 'Refund is already processing for this idempotency key', refund: existingRefund },
          { status: 409 }
        )
      }
    }

    // Create pending refund entry first so duplicate requests are naturally blocked.
    const pendingRefund = await prisma.paymentRefund.create({
      data: {
        paymentId: payment.id,
        provider: normalizeProvider(payment),
        amount: refundAmount,
        currency: payment.currency || 'USD',
        status: 'PROCESSING',
        reason,
        idempotencyKey: effectiveIdemKey,
        requestedById: user.id,
      },
    })

    let providerResult: RefundProviderResult
    const provider = normalizeProvider(payment)

    try {
      if (provider === 'sola') {
        const providerPaymentId = String(payment.providerPaymentId || payment.solaTransactionId || '').trim()
        if (!providerPaymentId) {
          throw new Error('SOLA refund failed: payment has no provider payment id')
        }
        providerResult = await refundWithSola({
          paymentProviderId: providerPaymentId,
          amount: refundAmount,
        })
      } else {
        const qboInvoiceId = String(payment.providerInvoiceId || payment.invoice.qboSyncId || '').trim()
        if (!qboInvoiceId) {
          throw new Error('QuickBooks refund failed: payment has no provider invoice id')
        }
        providerResult = await refundWithQuickBooks({
          tenantId: payment.invoice.tenantId,
          qboInvoiceId,
          amount: refundAmount,
          reason,
        })
      }
    } catch (providerError: any) {
      await prisma.paymentRefund.update({
        where: { id: pendingRefund.id },
        data: {
          status: 'FAILED',
          errorMessage: providerError?.message || 'Refund provider request failed',
        },
      })
      console.error('Payment refund provider error:', providerError)
      return NextResponse.json(
        { error: providerError?.message || 'Refund failed at provider' },
        { status: 502 }
      )
    }

    const updatedPayment = await prisma.$transaction(async (tx) => {
      const refreshed = await tx.payment.findUnique({
        where: { id: payment.id },
        select: { refundedAmount: true, amount: true, invoiceId: true },
      })
      if (!refreshed) {
        throw new Error('Payment no longer exists')
      }

      const nextRefundedAmount = toMoney(toMoney(refreshed.refundedAmount) + refundAmount)
      const fullyRefunded = nextRefundedAmount >= toMoney(refreshed.amount)

      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          refundedAmount: nextRefundedAmount,
          refundedAt: new Date(),
          refundStatus: fullyRefunded ? 'FULLY_REFUNDED' : 'PARTIALLY_REFUNDED',
          status: fullyRefunded ? 'REFUNDED' : payment.status,
        },
      })

      const currentPaidAmount = toMoney(payment.invoice.paidAmount)
      const invoiceTotal = toMoney(payment.invoice.total)
      const newPaidAmount = Math.max(0, toMoney(currentPaidAmount - refundAmount))
      const newBalance = Math.max(0, toMoney(invoiceTotal - newPaidAmount))

      await tx.invoice.update({
        where: { id: payment.invoice.id },
        data: {
          paidAmount: newPaidAmount,
          balance: newBalance,
          status: newBalance <= 0 ? 'PAID' : newPaidAmount > 0 ? 'PARTIAL' : 'SENT',
          paidAt: newPaidAmount > 0 ? payment.invoice.paidAmount ? new Date() : null : null,
        },
      })

      await tx.paymentRefund.update({
        where: { id: pendingRefund.id },
        data: {
          providerRefundId: providerResult.providerRefundId || null,
          rawResponse: providerResult.rawResponse || null,
          status: 'COMPLETED',
          refundedAt: new Date(),
        },
      })

      await tx.paymentTransaction.create({
        data: {
          tenantId: payment.invoice.tenantId,
          provider: `${provider}_refund`,
          status: 'refunded',
          amount: refundAmount,
          currency: payment.currency || 'USD',
          externalId: providerResult.providerRefundId || `${provider}:refund:${pendingRefund.id}`,
          invoiceId: payment.invoice.id,
          rawEvent: providerResult.rawResponse || undefined,
          metadata: {
            paymentId: payment.id,
            refundId: pendingRefund.id,
            idempotencyKey: effectiveIdemKey,
            reason,
          },
        },
      })

      await tx.auditLog.create({
        data: {
          tenantId: payment.invoice.tenantId,
          userId: user.id,
          action: 'REFUND',
          entityType: 'Payment',
          entityId: payment.id,
          ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
          userAgent: request.headers.get('user-agent') || undefined,
          changes: {
            provider,
            amount: refundAmount,
            timestamp: new Date().toISOString(),
            reason,
            invoiceId: payment.invoice.id,
            invoiceNumber: payment.invoice.invoiceNumber,
            paymentRefundId: pendingRefund.id,
          },
        },
      })

      return updatedPayment
    })

    return NextResponse.json({
      ok: true,
      payment: updatedPayment,
      refund: {
        id: pendingRefund.id,
        provider,
        amount: refundAmount,
        providerRefundId: providerResult.providerRefundId || null,
      },
    })
  } catch (error: any) {
    console.error('Payment refund error:', error)
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 500 })
  }
}

