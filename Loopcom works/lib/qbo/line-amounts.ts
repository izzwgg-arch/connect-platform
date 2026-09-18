/** Round to 2 decimal places (USD). */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function toQboNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'object' && value && 'toNumber' in value && typeof (value as any).toNumber === 'function') {
    const num = (value as any).toNumber()
    return Number.isFinite(num) ? num : 0
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/**
 * QuickBooks requires Amount === Qty * UnitPrice (fault 6070).
 * Trimpro stores line `total` separately; return a consistent triple for QBO payloads.
 */
export function normalizeQboSalesItemLineAmounts(params: {
  quantity: unknown
  unitPrice: unknown
  total?: unknown
}): { qty: number; unitPrice: number; amount: number } {
  const qty = toQboNumber(params.quantity)
  const unitPriceIn = toQboNumber(params.unitPrice)

  if (qty === 0) {
    return {
      qty: 0,
      unitPrice: unitPriceIn,
      amount: roundMoney(params.total !== undefined ? toQboNumber(params.total) : 0),
    }
  }

  const hasExplicitTotal =
    params.total !== undefined && params.total !== null && String(params.total).trim() !== ''
  const explicitTotal = hasExplicitTotal ? roundMoney(toQboNumber(params.total)) : null

  const targetAmount =
    explicitTotal !== null && explicitTotal !== 0
      ? explicitTotal
      : roundMoney(qty * unitPriceIn)

  const rawUnitPrice = targetAmount / qty
  for (const decimals of [2, 3, 4, 5, 6, 7, 8, 10, 12]) {
    const candidate = roundToDecimals(rawUnitPrice, decimals)
    if (roundMoney(qty * candidate) === targetAmount) {
      return { qty, unitPrice: candidate, amount: targetAmount }
    }
  }

  const amount = roundMoney(qty * unitPriceIn)
  return { qty, unitPrice: amount / qty, amount }
}
