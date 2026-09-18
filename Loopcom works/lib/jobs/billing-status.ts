export type JobBillingStatusValue = string

export type JobBillingAmountsInput = {
  estimateAmount?: string | number | null
  actualAmount?: string | number | null
  totalInvoicedAmount?: string | number | null
  invoices?: Array<{
    status?: string | null
    total?: string | number | null
  }> | null
}

function toNumber(value: string | number | null | undefined) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '0'))
  return Number.isFinite(n) ? n : 0
}

function isInactiveInvoiceStatus(status: string) {
  return status === 'CANCELLED' || status === 'REFUNDED'
}

function sumInvoicedTotal(invoices: JobBillingAmountsInput['invoices']) {
  return (invoices || [])
    .filter((invoice) => {
      const status = String(invoice.status || '').toUpperCase()
      return status && !isInactiveInvoiceStatus(status)
    })
    .reduce((sum, invoice) => sum + Math.max(0, toNumber(invoice.total)), 0)
}

/**
 * Progress billed vs job estimate (or actual amount fallback).
 * Returns 0–100 (rounded).
 */
export function getJobBilledPercent(input: JobBillingAmountsInput): number {
  const basis = toNumber(input.estimateAmount) || toNumber(input.actualAmount)
  const invoiced =
    input.totalInvoicedAmount != null && input.totalInvoicedAmount !== ''
      ? Math.max(0, toNumber(input.totalInvoicedAmount))
      : sumInvoicedTotal(input.invoices)

  if (basis <= 0) {
    return invoiced > 0 ? 100 : 0
  }

  return Math.max(0, Math.min(100, Math.round((invoiced / basis) * 100)))
}

/** e.g. "Unbilled", "50% billed", "100% billed" */
export function formatJobBillingStatus(percentOrStatus: number | string | null | undefined): string {
  if (typeof percentOrStatus === 'string') {
    const trimmed = percentOrStatus.trim()
    if (!trimmed || trimmed.toUpperCase() === 'UNBILLED') return 'Unbilled'
    if (/%\s*billed/i.test(trimmed) || /^unbilled$/i.test(trimmed)) return trimmed
    const parsed = parseInt(trimmed, 10)
    if (Number.isFinite(parsed)) return formatJobBillingStatus(parsed)
    return trimmed
  }

  const percent = Math.max(0, Math.min(100, Math.round(Number(percentOrStatus) || 0)))
  if (percent <= 0) return 'Unbilled'
  return `${percent}% billed`
}

export function getJobBillingStatus(input: JobBillingAmountsInput): string {
  return formatJobBillingStatus(getJobBilledPercent(input))
}

export function jobBillingStatusColorClass(statusOrPercent?: string | number | null): string {
  const percent =
    typeof statusOrPercent === 'number'
      ? statusOrPercent
      : parseBillingPercent(statusOrPercent)

  if (percent >= 100) return 'bg-green-100 text-green-800'
  if (percent >= 85) return 'bg-emerald-100 text-emerald-800'
  if (percent >= 65) return 'bg-yellow-100 text-yellow-800'
  if (percent >= 50) return 'bg-blue-100 text-blue-800'
  if (percent > 0) return 'bg-slate-100 text-slate-800'
  return 'bg-gray-100 text-gray-700'
}

export function parseBillingPercent(status?: string | null): number {
  if (!status) return 0
  if (/^unbilled$/i.test(status.trim())) return 0
  const match = String(status).match(/(\d+)\s*%/)
  if (match) return Math.max(0, Math.min(100, parseInt(match[1], 10)))
  return 0
}

/** @deprecated kept for any old color map lookups */
export const jobBillingStatusColors: Record<string, string> = {
  UNBILLED: 'bg-gray-100 text-gray-700',
}
