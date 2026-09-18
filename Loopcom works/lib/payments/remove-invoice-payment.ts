import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

function round2(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

const PAID_EPSILON = 0.005

type InvoiceStatusValue =
  | 'DRAFT'
  | 'SENT'
  | 'VIEWED'
  | 'PARTIAL'
  | 'PAID'
  | 'OVERDUE'
  | 'CANCELLED'
  | 'REFUNDED'

export interface RemoveInvoicePaymentResult {
  removed: boolean
  paymentId: string
  invoice: { paidAmount: number; balance: number; status: string } | null
  reason?: 'not_found' | 'wrong_tenant' | 'has_refunds'
}

export async function removeInvoicePayment(
  paymentId: string,
  tenantId: string
): Promise<RemoveInvoicePaymentResult> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: {
          select: {
            id: true,
            tenantId: true,
            total: true,
            status: true,
            paidAt: true,
          },
        },
        refunds: { select: { id: true }, take: 1 },
      },
    })

    if (!payment) {
      return { removed: false, paymentId, invoice: null, reason: 'not_found' }
    }
    if (payment.invoice.tenantId !== tenantId) {
      return { removed: false, paymentId, invoice: null, reason: 'wrong_tenant' }
    }
    if (payment.refunds.length > 0) {
      return { removed: false, paymentId, invoice: null, reason: 'has_refunds' }
    }

    const invoiceId = payment.invoice.id
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`

    await tx.payment.delete({ where: { id: paymentId } })

    const remaining = await tx.payment.findMany({
      where: { invoiceId, status: 'COMPLETED' },
      select: { amount: true },
    })

    const total = round2(payment.invoice.total)
    const newPaidAmount = round2(
      remaining.reduce((sum, row) => sum + round2(row.amount), 0)
    )
    const newBalance = round2(Math.max(0, total - newPaidAmount))
    const fullyPaid = newBalance <= PAID_EPSILON

    const nextStatus: InvoiceStatusValue = fullyPaid
      ? 'PAID'
      : newPaidAmount > 0
        ? 'PARTIAL'
        : ['CANCELLED', 'REFUNDED'].includes(String(payment.invoice.status))
          ? (String(payment.invoice.status) as InvoiceStatusValue)
          : 'SENT'

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount: newPaidAmount,
        balance: fullyPaid ? 0 : newBalance,
        status: nextStatus,
        paidAt: fullyPaid ? payment.invoice.paidAt : null,
      },
      select: { paidAmount: true, balance: true, status: true },
    })

    if (payment.reference) {
      await tx.paymentTransaction.deleteMany({
        where: {
          tenantId,
          externalId: payment.reference,
        },
      })
    }

    return {
      removed: true,
      paymentId,
      invoice: {
        paidAmount: round2(updated.paidAmount),
        balance: round2(updated.balance),
        status: String(updated.status),
      },
    }
  })
}
