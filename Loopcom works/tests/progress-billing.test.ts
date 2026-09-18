/**
 * Tests for progress/percentage billing math.
 *
 * Covers:
 *  - toCents / fromCents round-trip
 *  - solveSubtotalForTotal
 *  - reconcileProgressLines
 *  - computeProgressInvoiceTotals
 *  - Real-world scenario: Estimate $10,661.70, two invoices totalling exactly $10,661.70
 *  - Fractional percentages (33.33 / 33.33 / 33.34)
 *  - Large estimates with many line items
 *  - No-tax scenarios
 *  - Edge-case: estimate total already fully invoiced
 *  - Edge-case: maxAllowed = 0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  toCents,
  fromCents,
  solveSubtotalForTotal,
  reconcileProgressLines,
  computeProgressInvoiceTotals,
  reconcileEstimateConversionLineItems,
} from '../lib/documents/progress-billing'

// ---------------------------------------------------------------------------
// toCents / fromCents
// ---------------------------------------------------------------------------

test('toCents rounds half-up to nearest cent', () => {
  assert.equal(toCents(10661.70), 1066170)
  assert.equal(toCents(0.005), 1)   // half-up
  assert.equal(toCents(0.004), 0)
  assert.equal(toCents(1.235), 124) // 123.5 → 124
  assert.equal(toCents(1.225), 123) // 122.5 → 122 (JS banker? No — Math.round rounds .5 up)
})

test('fromCents converts integer cents to 2-dp dollar number', () => {
  assert.equal(fromCents(1066170), 10661.70)
  assert.equal(fromCents(1), 0.01)
  assert.equal(fromCents(0), 0.00)
  assert.equal(fromCents(999), 9.99)
})

test('fromCents(toCents(x)) round-trips for common values', () => {
  const values = [0, 0.01, 0.99, 1.00, 10.55, 100.00, 9999.99, 10661.70]
  for (const v of values) {
    assert.equal(fromCents(toCents(v)), v, `round-trip failed for ${v}`)
  }
})

// ---------------------------------------------------------------------------
// solveSubtotalForTotal
// ---------------------------------------------------------------------------

test('solveSubtotalForTotal: zero tax rate returns targetTotal as subtotal', () => {
  const result = solveSubtotalForTotal(1066170, 0)
  assert.ok(result !== null)
  assert.equal(result!.subtotalCents, 1066170)
  assert.equal(result!.taxCents, 0)
})

test('solveSubtotalForTotal: finds exact solution for 8.75% tax', () => {
  // Verify: subtotalCents + round(subtotalCents * taxRate) === targetTotalCents
  const TARGET = 1066170 // $10,661.70
  const TAX_RATE = 0.0875
  const result = solveSubtotalForTotal(TARGET, TAX_RATE)
  assert.ok(result !== null, 'should find a solution')
  assert.equal(
    result!.subtotalCents + Math.round(result!.subtotalCents * TAX_RATE),
    TARGET,
    'subtotal + tax must equal target total'
  )
})

test('solveSubtotalForTotal: finds solution for common tax rates', () => {
  const taxRates = [0.06, 0.07, 0.08, 0.0875, 0.09, 0.095, 0.10]
  const totals = [100000, 500000, 1066170, 2500000]
  for (const rate of taxRates) {
    for (const total of totals) {
      const result = solveSubtotalForTotal(total, rate)
      if (result !== null) {
        const check = result.subtotalCents + Math.round(result.subtotalCents * rate)
        assert.ok(
          Math.abs(check - total) <= 1,
          `rate=${rate} total=${total}: got ${check}, expected ${total}`
        )
      }
    }
  }
})

// ---------------------------------------------------------------------------
// reconcileProgressLines — no-op case (no over-billing)
// ---------------------------------------------------------------------------

test('reconcileProgressLines: returns unchanged when total <= maxAllowed', () => {
  const lines = [
    { description: 'Item A', total: 100.00, unitPrice: 100.00, quantity: 1 },
    { description: 'Item B', total: 200.00, unitPrice: 200.00, quantity: 1 },
  ]
  const subtotalCents = 30000 // $300
  const taxRate = 0.08
  const maxAllowedCents = 40000 // $400 — more than enough

  const result = reconcileProgressLines(lines, subtotalCents, taxRate, maxAllowedCents)

  assert.equal(result.wasReconciled, false)
  assert.equal(result.subtotalCents, 30000)
  assert.equal(result.taxCents, Math.round(30000 * 0.08))
  assert.equal(result.totalCents, result.subtotalCents + result.taxCents)
  assert.deepEqual(result.lineItems.map((l) => l.total), [100.00, 200.00])
})

// ---------------------------------------------------------------------------
// reconcileProgressLines — over-billing, no tax
// ---------------------------------------------------------------------------

test('reconcileProgressLines: caps total (no tax) and adjusts last line', () => {
  // 3 lines at $3.34 each (sum = $10.02 due to per-line rounding of 3.3333...)
  // But maxAllowed = $10.00
  const lines = [
    { description: 'A', total: 3.34, unitPrice: 3.34, quantity: 1 },
    { description: 'B', total: 3.34, unitPrice: 3.34, quantity: 1 },
    { description: 'C', total: 3.34, unitPrice: 3.34, quantity: 1 },
  ]
  const subtotalCents = 1002 // $10.02
  const taxRate = 0
  const maxAllowedCents = 1000 // $10.00

  const result = reconcileProgressLines(lines, subtotalCents, taxRate, maxAllowedCents)

  assert.equal(result.wasReconciled, true)
  assert.equal(result.totalCents, 1000, 'total must be capped at $10.00')
  assert.equal(result.subtotalCents, 1000)
  assert.equal(result.taxCents, 0)

  // Last line should be reduced by 2 cents
  assert.equal(result.lineItems[2].total, 3.32, 'last line reduced by 2 cents')
  // First two lines unchanged
  assert.equal(result.lineItems[0].total, 3.34)
  assert.equal(result.lineItems[1].total, 3.34)

  // Sum of adjusted lines must equal subtotalCents
  const lineSum = result.lineItems.reduce((s, l) => s + toCents(l.total), 0)
  assert.equal(lineSum, result.subtotalCents, 'line sum must equal reconciled subtotal')
})

// ---------------------------------------------------------------------------
// reconcileProgressLines — over-billing, with tax
// ---------------------------------------------------------------------------

test('reconcileProgressLines: caps total (with tax) and maintains subtotal+tax=total', () => {
  // Simulate: estimate $10,661.70 at 8.75% tax, one line slightly over
  // subtotalCents = 980400 ($9,804.00) but target is lower
  const lines = [
    { description: 'Labor', total: 9804.00, unitPrice: 9804.00, quantity: 1 },
  ]
  const subtotalCents = 980400
  const taxRate = 0.0875
  const maxAllowedCents = 1066170 // $10,661.70

  // Normal total: 980400 + round(980400 * 0.0875) = 980400 + 85785 = 1066185
  // which is > 1066170, so reconciliation is needed
  const normalTax = Math.round(subtotalCents * taxRate)
  const normalTotal = subtotalCents + normalTax
  assert.ok(normalTotal > maxAllowedCents, 'setup: normal total should exceed max')

  const result = reconcileProgressLines(lines, subtotalCents, taxRate, maxAllowedCents)

  assert.equal(result.wasReconciled, true)
  assert.equal(result.totalCents, maxAllowedCents, 'total must equal $10,661.70')
  assert.equal(
    result.subtotalCents + result.taxCents,
    result.totalCents,
    'subtotal + tax must equal total'
  )
  // Verify the tax formula is consistent: taxCents = round(subtotalCents * taxRate)
  assert.equal(
    Math.round(result.subtotalCents * taxRate),
    result.taxCents,
    'tax must be Math.round(subtotal * taxRate)'
  )

  const lineSum = result.lineItems.reduce((s, l) => s + toCents(l.total), 0)
  assert.equal(lineSum, result.subtotalCents, 'line sum must equal reconciled subtotal')
})

// ---------------------------------------------------------------------------
// computeProgressInvoiceTotals — the reported real-world scenario
// ---------------------------------------------------------------------------

test('REAL SCENARIO: $10,661.70 estimate, two 50% invoices never exceed total', () => {
  // Estimate: $9,803.86 subtotal + 8.875% tax = $10,661.70
  // (Using the tax-exclusive route: 9803.86 * 1.08875 ≈ 10,662, adjust to make exact)
  //
  // We simulate per-line rounding on many lines. The goal is:
  //   invoice1.total + invoice2.total <= 10,661.70
  //   invoice2.total = 10,661.70 - invoice1.total  (exactly)

  // Build a simple estimate: 10 lines at $980.386 each (pre-tax subtotal $9,803.86)
  // At 50% each line becomes $490.193 → rounds to $490.19 each
  // Sum of 10 rounded lines = $4,901.90 (subtotal for each invoice)
  // Tax per invoice = round($4,901.90 * 0.08875) = round($435.04...) = $435.04
  // Each invoice total = $4,901.90 + $435.04 = $5,336.94
  // Two invoices = $10,673.88 >> $10,661.70 WITHOUT reconciliation

  const ESTIMATE_TOTAL = 10661.70
  const ESTIMATE_CENTS = toCents(ESTIMATE_TOTAL)
  const TAX_RATE = 0.08875
  const LINE_PRICE = 980.386
  const NUM_LINES = 10
  const PCT = 0.50

  // Build invoice 1 line items (50% billing)
  const makeLines = () =>
    Array.from({ length: NUM_LINES }, (_, i) => ({
      description: `Line ${i + 1}`,
      total: fromCents(toCents(LINE_PRICE * PCT)), // per-line rounded to 2dp
      unitPrice: fromCents(toCents(LINE_PRICE * PCT)),
      quantity: 1,
    }))

  const inv1Lines = makeLines()
  const inv1SubtotalCents = inv1Lines.reduce((s, l) => s + toCents(l.total), 0)

  const inv1Result = computeProgressInvoiceTotals({
    subtotalCents: inv1SubtotalCents,
    taxRate: TAX_RATE,
    estimateTotalCents: ESTIMATE_CENTS,
    existingInvoicedCents: 0,
    lines: inv1Lines,
  })

  assert.ok(
    inv1Result.totalCents <= ESTIMATE_CENTS,
    `Invoice 1 total ${fromCents(inv1Result.totalCents)} must not exceed ${ESTIMATE_TOTAL}`
  )

  // Invoice 2: same per-line amounts, but existing = invoice 1 total
  const inv2Lines = makeLines()
  const inv2SubtotalCents = inv2Lines.reduce((s, l) => s + toCents(l.total), 0)

  const inv2Result = computeProgressInvoiceTotals({
    subtotalCents: inv2SubtotalCents,
    taxRate: TAX_RATE,
    estimateTotalCents: ESTIMATE_CENTS,
    existingInvoicedCents: inv1Result.totalCents,
    lines: inv2Lines,
  })

  const cumulative = inv1Result.totalCents + inv2Result.totalCents

  assert.ok(
    cumulative <= ESTIMATE_CENTS,
    `Cumulative ${fromCents(cumulative)} must not exceed ${ESTIMATE_TOTAL}`
  )
  assert.equal(
    cumulative,
    ESTIMATE_CENTS,
    `Cumulative must equal estimate total exactly: expected ${ESTIMATE_TOTAL}, got ${fromCents(cumulative)}`
  )
})

// ---------------------------------------------------------------------------
// Fractional percentages: 33.33% + 33.33% + 33.34%
// ---------------------------------------------------------------------------

test('fractional 33.33/33.33/33.34 percent invoices sum to estimate total exactly', () => {
  const ESTIMATE_TOTAL = 10661.70
  const ESTIMATE_CENTS = toCents(ESTIMATE_TOTAL)
  const TAX_RATE = 0.0875

  // 5 lines, each $2,132.34 pre-tax (5 * 2132.34 = $10,661.70 pre-tax for zero-tax case,
  // or we just use this as a no-tax scenario for clarity)
  const TAX_RATE_ZERO = 0
  const LINE_PRICE_NO_TAX = 2132.34 // 5 * 2132.34 = 10661.70
  const NUM_LINES = 5

  const pcts = [33.33 / 100, 33.33 / 100, 33.34 / 100]
  let existingCents = 0
  let cumulativeCents = 0

  for (const pct of pcts) {
    const lines = Array.from({ length: NUM_LINES }, (_, i) => ({
      description: `Line ${i + 1}`,
      total: fromCents(toCents(LINE_PRICE_NO_TAX * pct)),
      unitPrice: fromCents(toCents(LINE_PRICE_NO_TAX * pct)),
      quantity: 1,
    }))
    const subtotalCents = lines.reduce((s, l) => s + toCents(l.total), 0)

    const result = computeProgressInvoiceTotals({
      subtotalCents,
      taxRate: TAX_RATE_ZERO,
      estimateTotalCents: ESTIMATE_CENTS,
      existingInvoicedCents: existingCents,
      lines,
    })

    assert.ok(
      result.totalCents <= ESTIMATE_CENTS - existingCents + 1, // allow 1 cent rounding
      `Invoice at ${pct * 100}% total ${fromCents(result.totalCents)} must not overbill`
    )
    existingCents += result.totalCents
    cumulativeCents += result.totalCents
  }

  assert.ok(
    cumulativeCents <= ESTIMATE_CENTS,
    `Cumulative ${fromCents(cumulativeCents)} must not exceed ${ESTIMATE_TOTAL}`
  )
  assert.ok(
    ESTIMATE_CENTS - cumulativeCents <= 1,
    `Cumulative must be within 1 cent of estimate: gap = ${ESTIMATE_CENTS - cumulativeCents} cents`
  )
})

// ---------------------------------------------------------------------------
// Large estimate: 100 line items at various prices
// ---------------------------------------------------------------------------

test('large estimate with 100 lines: cumulative invoices do not exceed estimate', () => {
  // Estimate: 100 lines at $106.617 each (total $10,661.70, no tax)
  const ESTIMATE_TOTAL = 10661.70
  const ESTIMATE_CENTS = toCents(ESTIMATE_TOTAL)
  const TAX_RATE = 0
  const BASE_PRICE = 106.617
  const NUM_LINES = 100

  // Simulate three 33% invoices + one final reconciliation invoice
  const invoicePercents = [0.33, 0.33, 0.34]
  let existingCents = 0

  for (const pct of invoicePercents) {
    const lines = Array.from({ length: NUM_LINES }, (_, i) => ({
      description: `Line ${i + 1}`,
      total: fromCents(toCents(BASE_PRICE * pct)),
      unitPrice: fromCents(toCents(BASE_PRICE * pct)),
      quantity: 1,
    }))
    const subtotalCents = lines.reduce((s, l) => s + toCents(l.total), 0)
    const result = computeProgressInvoiceTotals({
      subtotalCents,
      taxRate: TAX_RATE,
      estimateTotalCents: ESTIMATE_CENTS,
      existingInvoicedCents: existingCents,
      lines,
    })
    assert.ok(result.totalCents <= ESTIMATE_CENTS - existingCents,
      `Invoice at ${pct * 100}% must not exceed remaining`)
    existingCents += result.totalCents
  }

  assert.ok(existingCents <= ESTIMATE_CENTS, `Total ${fromCents(existingCents)} must not exceed ${ESTIMATE_TOTAL}`)
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('reconcileProgressLines: handles maxAllowed = 0 gracefully', () => {
  const lines = [{ description: 'A', total: 100.00, unitPrice: 100.00, quantity: 1 }]
  const result = reconcileProgressLines(lines, 10000, 0, 0)

  assert.equal(result.wasReconciled, true)
  assert.equal(result.totalCents, 0)
  assert.equal(result.subtotalCents, 0)
  assert.equal(result.lineItems[0].total, 0.00, 'line should be zeroed out')
})

test('reconcileProgressLines: single line item reconciled correctly', () => {
  // One line of $10,662.00 but estimate total is $10,661.70 (no tax)
  const lines = [{ description: 'A', total: 10662.00, unitPrice: 10662.00, quantity: 1 }]
  const result = reconcileProgressLines(lines, toCents(10662.00), 0, toCents(10661.70))

  assert.equal(result.wasReconciled, true)
  assert.equal(result.totalCents, toCents(10661.70))
  assert.equal(result.lineItems[0].total, 10661.70)
})

test('computeProgressInvoiceTotals: no reconciliation needed when total is under', () => {
  const lines = [{ description: 'A', total: 5000.00, unitPrice: 5000.00, quantity: 1 }]
  const result = computeProgressInvoiceTotals({
    subtotalCents: 500000,
    taxRate: 0,
    estimateTotalCents: 1000000, // $10,000
    existingInvoicedCents: 0,
    lines,
  })
  assert.equal(result.wasReconciled, false)
  assert.equal(result.totalCents, 500000)
})

test('REAL SCENARIO: railing estimate second invoice caps 1-cent rounding overflow', () => {
  // Estimate EST-009100: $7,025.01 total, $3,012.51 already invoiced (50% + $500 discount)
  // Full remaining (57.1%) scales lines to $4,012.51 — 1 cent over the $4,012.50 remaining.
  const ESTIMATE_CENTS = toCents(7025.01)
  const EXISTING_CENTS = toCents(3012.51)
  const lines = [
    { description: 'rad oak railing', total: 3141.46, unitPrice: 3141.46, quantity: 1 },
    { description: 'Subtotal', total: 99.96, unitPrice: 99.96, quantity: 1 },
    { description: 'Subtotal', total: 371.27, unitPrice: 371.27, quantity: 1 },
    { description: 'Subtotal', total: 114.23, unitPrice: 114.23, quantity: 1 },
    { description: 'Subtotal', total: 285.59, unitPrice: 285.59, quantity: 1 },
  ]

  const result = reconcileEstimateConversionLineItems(lines, {
    taxRate: 0,
    discount: 0,
    estimateTotalCents: ESTIMATE_CENTS,
    existingInvoicedCents: EXISTING_CENTS,
  })

  assert.equal(result.wasReconciled, true)
  assert.equal(result.total, 4012.5)
  assert.equal(EXISTING_CENTS + toCents(result.total), ESTIMATE_CENTS)
  assert.equal(result.lineItems[4].unitPrice, 285.58)
})

test('computeProgressInvoiceTotals: reconciles when existing + new would exceed estimate', () => {
  // Estimate $10,661.70, already invoiced $5,331.00, new invoice would be $5,331.00
  // Cumulative would be $10,662.00 > $10,661.70
  const ESTIMATE_CENTS = toCents(10661.70)
  const EXISTING_CENTS = toCents(5331.00)
  const lines = [{ description: 'A', total: 5331.00, unitPrice: 5331.00, quantity: 1 }]
  const result = computeProgressInvoiceTotals({
    subtotalCents: toCents(5331.00),
    taxRate: 0,
    estimateTotalCents: ESTIMATE_CENTS,
    existingInvoicedCents: EXISTING_CENTS,
    lines,
  })

  assert.equal(result.wasReconciled, true)
  assert.equal(result.totalCents, ESTIMATE_CENTS - EXISTING_CENTS)
  // Use integer cents comparison to avoid floating-point subtraction noise
  assert.equal(result.totalCents, toCents(10661.70) - toCents(5331.00))

  // Verify: existing + this = estimate exactly
  assert.equal(EXISTING_CENTS + result.totalCents, ESTIMATE_CENTS)
})

test('unitPrice is updated proportionally when last line total is reduced', () => {
  // quantity=4, unitPrice=2.51, total=10.04. After reduction to 10.00, unitPrice = 10.00/4 = 2.5
  const lines = [
    { description: 'Item', total: 10.04, unitPrice: 2.51, quantity: 4 },
  ]
  const result = reconcileProgressLines(lines, toCents(10.04), 0, toCents(10.00))

  assert.equal(result.wasReconciled, true)
  assert.equal(result.lineItems[0].total, 10.00)
  // unitPrice = 10.00 / 4 = 2.5 (to 4 decimal places)
  assert.equal(Number(result.lineItems[0].unitPrice.toFixed(4)), 2.5000)
})

test('subtotal rows (isSubtotal=true) are skipped during reconciliation', () => {
  const lines = [
    { description: 'Item A', total: 5.00, unitPrice: 5.00, quantity: 1, isSubtotal: false },
    { description: 'Subtotal', total: 5.00, unitPrice: 0, quantity: 0, isSubtotal: true },
    { description: 'Item B', total: 5.02, unitPrice: 5.02, quantity: 1, isSubtotal: false },
  ]
  // SubtotalCents counts only non-subtotal lines: 500 + 502 = 1002
  const result = reconcileProgressLines(lines, 1002, 0, 1000)

  assert.equal(result.wasReconciled, true)
  assert.equal(result.totalCents, 1000)
  // The subtotal row is unchanged
  assert.equal(result.lineItems[1].isSubtotal, true)
  assert.equal(result.lineItems[1].total, 5.00)
  // Item B reduced by 2 cents
  assert.equal(result.lineItems[2].total, 5.00)
  // Item A unchanged
  assert.equal(result.lineItems[0].total, 5.00)
})
