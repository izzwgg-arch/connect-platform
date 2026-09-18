/**
 * Shared math for "PERCENT_OF_ABOVE" catalog items — a normal line item whose
 * price is calculated, at the moment it's added, as a percentage of the
 * dollar total of the real line items already listed above it in the same
 * document (estimate/invoice/purchase order).
 */

type PrecedingLine = {
  quantity?: string | number | null
  unitPrice?: string | number | null
  isSubtotal?: boolean
  isNote?: boolean
  isGroupHeader?: boolean
}

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const n = parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * Sums the real (non-divider) line items — the "items above" a percent line.
 *
 * A Subtotal row or a new bundle's group header acts as a reset point: only
 * items after the LAST such boundary are summed, not the whole document. So
 * a percent line placed after a Subtotal (or inside/after a newly-added
 * bundle) only picks up what's accumulated since that boundary — matching
 * how those markers already read visually as "start of a new section."
 * A Note row is just an annotation, not a section boundary, so it's skipped
 * but doesn't reset the running sum.
 */
export function sumPrecedingLineItems(lines: readonly PrecedingLine[]): number {
  let boundary = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].isSubtotal || lines[i].isGroupHeader) boundary = i
  }
  return lines.slice(boundary + 1).reduce((sum, li) => {
    if (li.isSubtotal || li.isNote || li.isGroupHeader) return sum
    return sum + toNumber(li.quantity) * toNumber(li.unitPrice)
  }, 0)
}

/** Computes the unit price for a PERCENT_OF_ABOVE item, given the lines above it. */
export function computePercentOfAbovePrice(lines: readonly PrecedingLine[], percentRate: number): number {
  const sum = sumPrecedingLineItems(lines)
  const rate = Number.isFinite(percentRate) ? percentRate : 0
  return Math.round(sum * (rate / 100) * 100) / 100
}
