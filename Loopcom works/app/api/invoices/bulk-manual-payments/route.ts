import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { notifyInvoicePaid } from '@/lib/notifications'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { afterInvoicePayment } from '@/lib/payments/after-invoice-payment'
import { applyInvoicePayment } from '@/lib/payments/apply-payment'
import crypto from 'crypto'

const ALLOWED_METHODS = new Set(['CHECK', 'QUICK_PAY', 'OTHER'])

function toNumber(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  // Round to cents so float leftovers (e.g. 433.849999999) don't reject full balances.
  return Math.round(n * 100) / 100
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.manage')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const method = String(body?.method || '').trim().toUpperCase()
    const methodLabel = String(body?.methodLabel || '').trim()
    const reference = String(body?.reference || '').trim() || null
    const paidAtRaw = body?.paidAt ? new Date(String(body.paidAt)) : null
    const processedAt =
      paidAtRaw && !Number.isNaN(paidAtRaw.getTime()) ? paidAtRaw : new Date()
    const items: any[] = Array.isArray(body?.items) ? body.items : []

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
    if (items.length === 0) {
      return NextResponse.json({ error: 'Select at least one invoice.' }, { status: 400 })
    }

    const requestedIds = Array.from(
      new Set(
        items
          .map((item: any) => String(item?.invoiceId || '').trim())
          .filter(Boolean)
      )
    )
    if (requestedIds.length === 0) {
      return NextResponse.json({ error: 'No valid invoices were provided.' }, { status: 400 })
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        id: { in: requestedIds },
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

    const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]))

    const preparedItems = items.map((item: any) => {
      const invoiceId = String(item?.invoiceId || '').trim()
      const requestedAmount = toNumber(item?.amount)
      const invoice = invoicesById.get(invoiceId)
      const remaining = invoice
        ? Math.max(0, toNumber(toNumber(invoice.total) - toNumber(invoice.paidAmount)))
        : 0
      return {
        invoiceId,
        invoice,
        requestedAmount,
        remaining,
      }
    })

    const invalidItem = preparedItems.find((item) => {
      if (!item.invoice) return true
      if (item.invoice.status === 'CANCELLED' || item.invoice.status === 'REFUNDED') return true
      if (item.remaining <= 0) return true
      if (item.requestedAmount <= 0) return true
      if (item.requestedAmount > item.remaining) return true
      return false
    })

    if (invalidItem) {
      if (!invalidItem.invoice) {
        return NextResponse.json({ error: 'One or more invoices were not found.' }, { status: 404 })
      }
      if (invalidItem.invoice.status === 'CANCELLED' || invalidItem.invoice.status === 'REFUNDED') {
        return NextResponse.json(
          { error: `Invoice ${invalidItem.invoice.invoiceNumber} cannot accept manual payments.` },
          { status: 400 }
        )
      }
      if (invalidItem.remaining <= 0) {
        return NextResponse.json(
          { error: `Invoice ${invalidItem.invoice.invoiceNumber} is already fully paid.` },
          { status: 400 }
        )
      }
      if (invalidItem.requestedAmount <= 0) {
        return NextResponse.json(
          { error: `Payment amount for ${invalidItem.invoice.invoiceNumber} must be greater than zero.` },
          { status: 400 }
        )
      }
      return NextResponse.json(
        { error: `Payment amount for ${invalidItem.invoice.invoiceNumber} exceeds its remaining balance.` },
        { status: 400 }
      )
    }

    const paymentNotes =
      method === 'CHECK'
        ? 'Manually marked as paid by check'
        : method === 'QUICK_PAY'
          ? 'Manually marked as paid by Quick Pay'
          : `Manually marked as paid — ${methodLabel}`

    // One manual entry (e.g. a single check) covering several invoices is ONE
    // payment group, so QuickBooks records it as a single distributed payment.
    const paymentGroupId = `pg_manual_${crypto.randomBytes(12).toString('hex')}`

    const results = await prisma.$transaction(async (tx) => {
      const created: Array<{
        paymentId: string
        invoiceId: string
        invoiceNumber: string
        clientName: string
        amount: number
        newPaidAmount: number
        newBalance: number
        nextStatus: string
      }> = []

      for (const item of preparedItems) {
        const invoice = item.invoice!
        const res = await applyInvoicePayment(
          {
            invoiceId: invoice.id,
            tenantId: user.tenantId,
            amount: item.requestedAmount,
            method:
              method === 'CHECK'
                ? 'CHECK'
                : methodLabel.toLowerCase() === 'cash'
                  ? 'CASH'
                  : 'OTHER',
            provider:
              method === 'QUICK_PAY'
                ? 'quick_pay'
                : method === 'OTHER'
                  ? methodLabel.toLowerCase().replace(/\s+/g, '_')
                  : 'manual',
            processedAt,
            reference,
            notes: paymentNotes,
            paymentGroupId,
          },
          { tx }
        )
        if (!res.created || !res.paymentId || !res.invoice) {
          throw new Error(
            `Failed to apply payment to ${invoice.invoiceNumber}${
              res.reason ? ` (${res.reason})` : ''
            }`
          )
        }

        created.push({
          paymentId: res.paymentId,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clientName: invoice.client?.name || 'Customer',
          amount: Math.max(0, toNumber(res.invoice.paidAmount) - toNumber(invoice.paidAmount)),
          newPaidAmount: toNumber(res.invoice.paidAmount),
          newBalance: toNumber(res.invoice.balance),
          nextStatus: res.invoice.status,
        })
      }

      return created
    })

    // Sync the whole group once -> a single QuickBooks payment across invoices.
    if (results.length > 0) {
      try {
        await enqueueQboSync(user.tenantId, 'payment', results[0].paymentId, { processImmediately: true })
      } catch (error) {
        console.error('QuickBooks payment sync trigger error (bulk manual payment group):', error)
      }
    }

    for (const result of results) {
      await notifyInvoicePaid(
        user.tenantId,
        result.invoiceId,
        result.invoiceNumber,
        result.amount,
        result.clientName
      ).catch(() => null)

      await afterInvoicePayment(result.invoiceId).catch((error) => {
        console.error('[bulk-manual-payments] afterInvoicePayment failed:', {
          invoiceId: result.invoiceId,
          error,
        })
      })
    }

    return NextResponse.json({
      ok: true,
      count: results.length,
      totalApplied: results.reduce((sum, item) => sum + item.amount, 0),
      invoices: results.map((item) => ({
        id: item.invoiceId,
        invoiceNumber: item.invoiceNumber,
        status: item.nextStatus,
        paidAmount: item.newPaidAmount,
        balance: item.newBalance,
      })),
    })
  } catch (error) {
    console.error('Bulk manual payment error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    const isApplyFailure = message.startsWith('Failed to apply payment')
    return NextResponse.json(
      { error: isApplyFailure ? message : 'Internal server error' },
      { status: isApplyFailure ? 400 : 500 }
    )
  }
}
