import { prisma } from '@/lib/prisma'
import { applyInvoicePayment } from '@/lib/payments/apply-payment'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'

function round2(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function creditMemoStatusFor(remaining: number, total: number): 'DRAFT' | 'SENT' | 'PARTIALLY_APPLIED' | 'APPLIED' | 'VOID' {
  if (remaining <= 0.005) return 'APPLIED'
  if (remaining < total - 0.005) return 'PARTIALLY_APPLIED'
  return 'SENT'
}

export interface ApplyCreditMemoInput {
  tenantId: string
  creditMemoId: string
  invoiceId: string
  amount?: number | null
  userId?: string | null
  notes?: string | null
}

export interface ApplyCreditMemoResult {
  applicationId: string
  paymentId: string
  amountApplied: number
  creditMemo: {
    appliedAmount: number
    remainingCredit: number
    status: string
  }
  invoice: {
    paidAmount: number
    balance: number
    status: string
  }
}

/**
 * Apply remaining credit memo balance to an open invoice.
 * Creates a CREDIT payment on the invoice and records CreditMemoApplication.
 */
export async function applyCreditMemoToInvoice(
  input: ApplyCreditMemoInput
): Promise<ApplyCreditMemoResult> {
  const creditMemo = await prisma.creditMemo.findFirst({
    where: { id: input.creditMemoId, tenantId: input.tenantId },
  })
  if (!creditMemo) throw new Error('Credit memo not found')
  if (creditMemo.status === 'VOID') throw new Error('Cannot apply a voided credit memo')
  // DRAFT is allowed — applying finalizes the credit against an invoice.

  const remaining = round2(creditMemo.remainingCredit)
  if (remaining <= 0) throw new Error('Credit memo has no remaining credit')

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, tenantId: input.tenantId },
  })
  if (!invoice) throw new Error('Invoice not found')
  if (invoice.clientId !== creditMemo.clientId) {
    throw new Error('Credit memo and invoice must belong to the same client')
  }
  if (['CANCELLED', 'REFUNDED'].includes(invoice.status)) {
    throw new Error('Cannot apply credit to a cancelled or refunded invoice')
  }

  const invoiceBalance = round2(invoice.balance)
  if (invoiceBalance <= 0) throw new Error('Invoice has no open balance')

  const requested =
    input.amount != null && Number.isFinite(Number(input.amount))
      ? round2(input.amount)
      : Math.min(remaining, invoiceBalance)
  const amountToApply = round2(Math.min(requested, remaining, invoiceBalance))
  if (amountToApply <= 0) throw new Error('Apply amount must be greater than zero')

  const reference = `CM-${creditMemo.creditMemoNumber}-${Date.now()}`

  const paymentResult = await applyInvoicePayment({
    invoiceId: invoice.id,
    tenantId: input.tenantId,
    amount: amountToApply,
    method: 'CREDIT',
    provider: 'credit_memo',
    providerPaymentId: `${creditMemo.id}:${invoice.id}:${amountToApply}:${Date.now()}`,
    reference,
    notes: input.notes || `Applied from credit memo ${creditMemo.creditMemoNumber}`,
    dedupeWhere: {
      invoiceId: invoice.id,
      reference,
    },
  })

  if (!paymentResult.created || !paymentResult.paymentId || !paymentResult.invoice) {
    throw new Error(
      paymentResult.reason === 'no_remaining_balance'
        ? 'Invoice has no remaining balance'
        : paymentResult.reason === 'duplicate'
          ? 'This credit application was already recorded'
          : 'Failed to apply credit payment to invoice'
    )
  }

  const newApplied = round2(Number(creditMemo.appliedAmount) + amountToApply)
  const newRemaining = round2(Number(creditMemo.total) - newApplied)
  const nextStatus = creditMemoStatusFor(newRemaining, Number(creditMemo.total))

  const [application, updatedCm] = await prisma.$transaction(async (tx) => {
    const app = await tx.creditMemoApplication.create({
      data: {
        creditMemoId: creditMemo.id,
        invoiceId: invoice.id,
        paymentId: paymentResult.paymentId,
        amount: amountToApply,
        notes: input.notes || null,
      },
    })

    const cm = await tx.creditMemo.update({
      where: { id: creditMemo.id },
      data: {
        appliedAmount: newApplied,
        remainingCredit: Math.max(0, newRemaining),
        status: nextStatus,
      },
    })

    await tx.activity.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId || null,
        type: 'OTHER',
        description: `Applied $${amountToApply.toFixed(2)} from ${creditMemo.creditMemoNumber} to invoice ${invoice.invoiceNumber}`,
        creditMemoId: creditMemo.id,
        invoiceId: invoice.id,
        paymentId: paymentResult.paymentId,
        clientId: creditMemo.clientId,
      },
    })

    return [app, cm]
  })

  try {
    await enqueueQboSync(input.tenantId, 'credit_memo', creditMemo.id)
  } catch (e) {
    console.error('QBO credit memo sync trigger error (apply):', e)
  }
  try {
    await enqueueQboSync(input.tenantId, 'payment', paymentResult.paymentId)
  } catch (e) {
    console.error('QBO payment sync trigger error (credit apply):', e)
  }

  return {
    applicationId: application.id,
    paymentId: paymentResult.paymentId,
    amountApplied: amountToApply,
    creditMemo: {
      appliedAmount: Number(updatedCm.appliedAmount),
      remainingCredit: Number(updatedCm.remainingCredit),
      status: updatedCm.status,
    },
    invoice: paymentResult.invoice,
  }
}

export interface ApplyCreditMemoBatchInput {
  tenantId: string
  creditMemoId: string
  applications: Array<{ invoiceId: string; amount: number }>
  userId?: string | null
  notes?: string | null
}

/**
 * Apply one credit memo across multiple invoices with per-invoice amounts.
 * Applies sequentially so remaining credit stays accurate between invoices.
 */
export async function applyCreditMemoToInvoices(input: ApplyCreditMemoBatchInput) {
  const lines = (input.applications || [])
    .map((row) => ({
      invoiceId: String(row.invoiceId || '').trim(),
      amount: round2(row.amount),
    }))
    .filter((row) => row.invoiceId && row.amount > 0)

  if (!lines.length) {
    throw new Error('Select at least one invoice with an amount greater than zero')
  }

  const seen = new Set<string>()
  for (const row of lines) {
    if (seen.has(row.invoiceId)) {
      throw new Error('Each invoice can only appear once in an apply request')
    }
    seen.add(row.invoiceId)
  }

  const creditMemo = await prisma.creditMemo.findFirst({
    where: { id: input.creditMemoId, tenantId: input.tenantId },
    select: { id: true, remainingCredit: true, status: true },
  })
  if (!creditMemo) throw new Error('Credit memo not found')
  if (creditMemo.status === 'VOID') throw new Error('Cannot apply a voided credit memo')

  const totalRequested = round2(lines.reduce((sum, row) => sum + row.amount, 0))
  const remaining = round2(creditMemo.remainingCredit)
  if (totalRequested > remaining + 0.001) {
    throw new Error(
      `Total apply amount $${totalRequested.toFixed(2)} exceeds remaining credit $${remaining.toFixed(2)}`
    )
  }

  const results: ApplyCreditMemoResult[] = []
  for (const row of lines) {
    const result = await applyCreditMemoToInvoice({
      tenantId: input.tenantId,
      creditMemoId: input.creditMemoId,
      invoiceId: row.invoiceId,
      amount: row.amount,
      userId: input.userId,
      notes: input.notes,
    })
    results.push(result)
  }

  const last = results[results.length - 1]
  return {
    message: 'Credit applied successfully',
    amountApplied: round2(results.reduce((sum, r) => sum + r.amountApplied, 0)),
    applications: results.map((r) => ({
      applicationId: r.applicationId,
      paymentId: r.paymentId,
      amountApplied: r.amountApplied,
      invoice: r.invoice,
    })),
    creditMemo: last.creditMemo,
  }
}

export function computeCreditMemoTotals(
  lineItems: Array<{ quantity: number; unitPrice: number; taxable?: boolean }>,
  taxRate = 0
) {
  const subtotal = round2(
    lineItems.reduce((sum, li) => sum + round2(li.quantity) * round2(li.unitPrice), 0)
  )
  const taxableSubtotal = round2(
    lineItems.reduce((sum, li) => {
      if (li.taxable === false) return sum
      return sum + round2(li.quantity) * round2(li.unitPrice)
    }, 0)
  )
  const rate = round2(taxRate)
  const taxAmount = round2(taxableSubtotal * rate)
  const total = round2(subtotal + taxAmount)
  return { subtotal, taxAmount, total, remainingCredit: total }
}
