import { toDocumentNumber } from '@/lib/documents/subtotals'
import { toCents } from '@/lib/documents/progress-billing'

const EXCLUDED_CONVERSION_INVOICE_STATUSES = ['CANCELLED', 'REFUNDED']
const OVER_CONVERSION_TOLERANCE = 0.01

export type EstimateConversionSummary = {
  invoicedTotal: number
  convertedPercent: number
}

/** UI / validation: remaining billable headroom against estimate total (incl. tax). */
export type EstimateConversionProgress = {
  estimateTotal: number
  invoicedTotal: number
  convertedPercent: number
  remainingAmount: number
  /** Approximate % of estimate total not yet invoiced (0–100). */
  remainingPercent: number
  isFullyInvoiced: boolean
}

export function calculateEstimateConversionSummary(
  estimateTotal: unknown,
  invoiceTotals: readonly unknown[]
): EstimateConversionSummary {
  const total = toDocumentNumber(estimateTotal)
  const invoicedTotal = invoiceTotals.reduce<number>((sum, value) => sum + toDocumentNumber(value), 0)
  const rawPercent = total > 0 ? (invoicedTotal / total) * 100 : 0

  return {
    invoicedTotal,
    convertedPercent: Math.max(0, Math.min(100, Math.round(rawPercent))),
  }
}

export function getEstimateConversionProgress(
  estimateTotal: unknown,
  invoiceTotals: readonly unknown[],
): EstimateConversionProgress {
  const est = toDocumentNumber(estimateTotal)
  const invoicedTotal = invoiceTotals.reduce<number>((sum, value) => sum + toDocumentNumber(value), 0)
  const remainingAmount = Math.max(0, est - invoicedTotal)
  const rawInvoicedPct = est > 0 ? (invoicedTotal / est) * 100 : 0
  const remainingPercent = est > 0 ? Math.max(0, Math.min(100, 100 - rawInvoicedPct)) : 0

  return {
    estimateTotal: est,
    invoicedTotal,
    convertedPercent: Math.max(0, Math.min(100, Math.round(rawInvoicedPct))),
    remainingAmount,
    remainingPercent: Number(remainingPercent.toFixed(4)),
    isFullyInvoiced: remainingAmount <= OVER_CONVERSION_TOLERANCE,
  }
}

export async function getEstimateConversionSummary(
  db: any,
  estimateId: string,
  estimateTotal: unknown,
  tenantId?: string,
  excludeInvoiceId?: string
): Promise<EstimateConversionSummary> {
  const invoices = await db.invoice.findMany({
    where: {
      estimateId,
      ...(tenantId ? { tenantId } : {}),
      ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
      status: { notIn: EXCLUDED_CONVERSION_INVOICE_STATUSES },
    },
    select: { total: true, originalTotalAtConversion: true },
  })

  // Use the immutable at-conversion snapshot when available, so a discount
  // applied to the invoice afterward doesn't change the estimate's tracked
  // conversion. Falls back to the live total for invoices created before
  // this snapshot existed (or from a code path that hasn't set it).
  return calculateEstimateConversionSummary(
    estimateTotal,
    invoices.map(
      (invoice: { total: unknown; originalTotalAtConversion: unknown }) =>
        invoice.originalTotalAtConversion ?? invoice.total
    )
  )
}

export async function assertEstimateWillNotOverConvert(
  db: any,
  params: {
    estimateId: string
    tenantId?: string
    estimateTotal: unknown
    newInvoiceTotal: unknown
    excludeInvoiceId?: string
  }
) {
  const summary = await getEstimateConversionSummary(
    db,
    params.estimateId,
    params.estimateTotal,
    params.tenantId,
    params.excludeInvoiceId
  )
  const estimateCents = toCents(toDocumentNumber(params.estimateTotal))
  const projectedCents =
    toCents(summary.invoicedTotal) + toCents(toDocumentNumber(params.newInvoiceTotal))

  if (estimateCents > 0 && projectedCents > estimateCents) {
    const projectedPercent = Math.round((projectedCents / estimateCents) * 100)
    throw new Error(`This would invoice ${projectedPercent}% of the estimate. Total invoiced amount cannot exceed 100%.`)
  }
}

