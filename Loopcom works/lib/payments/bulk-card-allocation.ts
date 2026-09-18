export type InvoiceAllocationRow = {
  id: string
  balance: unknown
  dueDate?: Date | string | null
  invoiceDate?: Date | string | null
  invoiceNumber?: string | null
}

export function parsePublicPaymentAmount(value: unknown): number | null {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const normalized = raw.replace(/[^0-9.]/g, '')
  if (!normalized) return null
  const n = Number(normalized)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function dateMs(value: Date | string | null | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/** Dominant (current) invoice first, then remaining by due date / invoice date ascending. */
export function orderInvoicesDominantFirst<T extends InvoiceAllocationRow>(
  dominantInvoiceId: string,
  invoices: T[]
): T[] {
  const dominant = invoices.find((inv) => String(inv.id) === String(dominantInvoiceId))
  const rest = invoices.filter((inv) => String(inv.id) !== String(dominantInvoiceId))
  rest.sort((a, b) => {
    const dueDiff = dateMs(a.dueDate) - dateMs(b.dueDate)
    if (dueDiff !== 0) return dueDiff
    return dateMs(a.invoiceDate) - dateMs(b.invoiceDate)
  })
  return dominant ? [dominant, ...rest] : rest
}

/** Re-sort fetched invoice rows to match the order stored on the payment intent. */
export function orderInvoicesByStoredIds<T extends { id: string }>(invoiceIds: string[], invoices: T[]): T[] {
  const order = new Map(invoiceIds.map((id, index) => [String(id), index]))
  return [...invoices].sort(
    (a, b) => (order.get(String(a.id)) ?? 9999) - (order.get(String(b.id)) ?? 9999)
  )
}

export function buildWaterfallPlannedAmounts<T extends InvoiceAllocationRow>(
  invoices: T[],
  maxTotalAmount: number
): Record<string, number> {
  let remaining = Math.max(0, maxTotalAmount)
  const planned: Record<string, number> = {}
  for (const inv of invoices) {
    if (remaining <= 0) break
    const balance = Math.max(0, Number(inv.balance || 0))
    if (balance <= 0) continue
    const apply = Math.min(balance, remaining)
    planned[String(inv.id)] = apply
    remaining -= apply
  }
  return planned
}

export type PublicPaymentPlanMode = 'full' | 'planned' | 'waterfall'

export type PublicPaymentPlanResult<T extends InvoiceAllocationRow> = {
  mode: PublicPaymentPlanMode
  invoices: T[]
  plannedAmountsByInvoice: Record<string, number> | null
  maxTotalAmount: number | null
  total: number
}

export function parsePerInvoiceAmountMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [invoiceId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(invoiceId || '').trim()
    const amount = parsePublicPaymentAmount(value)
    if (!id || amount == null) continue
    out[id] = amount
  }
  return out
}

/**
 * Resolve how a card payment should apply across selected invoices.
 * - No custom amounts: pay full balance on each selected invoice.
 * - Per-invoice amounts only: charge the sum of those explicit amounts (partial allowed).
 * - Global amount only: waterfall from dominant/current invoice downward; last invoice may be partial.
 * - Global + per-invoice overrides: explicit amounts first, then waterfall the remainder.
 */
export function resolvePublicPaymentPlan<T extends InvoiceAllocationRow>(
  dominantInvoiceId: string,
  selectedInvoices: T[],
  options: {
    perInvoiceAmounts?: Record<string, number>
    globalAmount?: number | null
  } = {}
): PublicPaymentPlanResult<T> | { error: string } {
  const ordered = orderInvoicesDominantFirst(dominantInvoiceId, selectedInvoices.filter((inv) => Number(inv.balance || 0) > 0))
  if (ordered.length === 0) {
    return { error: 'Select at least one invoice with a balance due.' }
  }

  const perInvoice = options.perInvoiceAmounts || {}
  const globalAmount = options.globalAmount ?? null
  const hasGlobal = globalAmount != null && globalAmount > 0
  const explicitIds = ordered
    .map((inv) => String(inv.id))
    .filter((id) => (perInvoice[id] ?? 0) > 0)

  if (explicitIds.length === 0 && !hasGlobal) {
    const total = ordered.reduce((sum, inv) => sum + Math.max(0, Number(inv.balance || 0)), 0)
    return {
      mode: 'full',
      invoices: ordered,
      plannedAmountsByInvoice: null,
      maxTotalAmount: null,
      total,
    }
  }

  const planned: Record<string, number> = {}

  const applyExplicit = (poolCap: number) => {
    let remaining = poolCap
    for (const inv of ordered) {
      if (remaining <= 0) break
      const id = String(inv.id)
      const requested = perInvoice[id]
      if (requested == null || requested <= 0) continue
      const balance = Math.max(0, Number(inv.balance || 0))
      const apply = Math.min(requested, balance, remaining)
      if (apply <= 0) continue
      planned[id] = (planned[id] || 0) + apply
      remaining -= apply
    }
    return remaining
  }

  if (hasGlobal) {
    let poolRemaining = applyExplicit(globalAmount!)
    const withoutOverride = ordered.filter((inv) => {
      const id = String(inv.id)
      return (perInvoice[id] ?? 0) <= 0
    })
    const waterfallPlanned = buildWaterfallPlannedAmounts(withoutOverride, poolRemaining)
    for (const [id, amount] of Object.entries(waterfallPlanned)) {
      planned[id] = (planned[id] || 0) + amount
    }
  } else {
    applyExplicit(Number.MAX_SAFE_INTEGER)
  }

  const invoices = ordered.filter((inv) => (planned[String(inv.id)] || 0) > 0)
  const total = invoices.reduce((sum, inv) => sum + (planned[String(inv.id)] || 0), 0)
  if (total <= 0) {
    return { error: 'Enter a valid payment amount for at least one invoice.' }
  }

  for (const inv of invoices) {
    const id = String(inv.id)
    const balance = Math.max(0, Number(inv.balance || 0))
    if ((planned[id] || 0) > balance) {
      return { error: `Payment amount for ${inv.invoiceNumber || id} exceeds its balance.` }
    }
  }

  return {
    mode: hasGlobal && explicitIds.length === 0 ? 'waterfall' : 'planned',
    invoices,
    plannedAmountsByInvoice: planned,
    maxTotalAmount: hasGlobal ? globalAmount : total,
    total,
  }
}
