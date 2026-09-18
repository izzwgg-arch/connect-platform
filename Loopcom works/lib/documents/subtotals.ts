export type SubtotalCapableLine = {
  isSubtotal?: boolean | null
  isGroupHeader?: boolean | null
  sortOrder?: unknown
  id?: unknown
  quantity?: unknown
  unitPrice?: unknown
  unitCost?: unknown
  total?: unknown
}

export function toDocumentNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'object' && value && 'toNumber' in value && typeof (value as any).toNumber === 'function') {
    const num = (value as any).toNumber()
    return Number.isFinite(num) ? num : 0
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

export function getLineExtendedTotal(line: SubtotalCapableLine): number {
  return toDocumentNumber(line.quantity) * toDocumentNumber(line.unitPrice)
}

export function getLineExtendedCost(line: SubtotalCapableLine): number {
  return toDocumentNumber(line.quantity) * toDocumentNumber(line.unitCost)
}

export function calculateOrderedSubtotalRows<T extends SubtotalCapableLine>(
  lines: readonly T[]
): Array<T & { calculatedSubtotalTotal: number; calculatedSubtotalQuantity: number; calculatedSubtotalCost: number }> {
  let runningTotal = 0
  let runningQuantity = 0
  let runningCost = 0

  return lines.map((line) => {
    if (line.isSubtotal) {
      const result = {
        ...line,
        calculatedSubtotalTotal: runningTotal,
        calculatedSubtotalQuantity: runningQuantity,
        calculatedSubtotalCost: runningCost,
      }
      runningTotal = 0
      runningQuantity = 0
      runningCost = 0
      return result
    }

    if (!line.isGroupHeader) {
      runningTotal += getLineExtendedTotal(line)
      runningQuantity += toDocumentNumber(line.quantity)
      runningCost += getLineExtendedCost(line)
    }

    return {
      ...line,
      calculatedSubtotalTotal: getLineExtendedTotal(line),
      calculatedSubtotalQuantity: toDocumentNumber(line.quantity),
      calculatedSubtotalCost: getLineExtendedCost(line),
    }
  })
}

export function mergeApprovedOptionalItemsForSubtotals<T extends SubtotalCapableLine>(
  lineItems: readonly T[],
  approvedOptionalItems: readonly T[]
): T[] {
  return [...lineItems, ...approvedOptionalItems].sort((a, b) => {
    const sortDiff = toDocumentNumber(a.sortOrder) - toDocumentNumber(b.sortOrder)
    if (sortDiff !== 0) return sortDiff
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
}


