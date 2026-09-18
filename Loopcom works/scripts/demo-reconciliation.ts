/**
 * Before/after demonstration of the progress billing reconciliation fix.
 * Scenario: $10,661.70 estimate, two 50% invoices, 8.875% tax, 10 lines.
 *
 * Run: npx tsx scripts/demo-reconciliation.ts
 */
import { toCents, fromCents, computeProgressInvoiceTotals } from '../lib/documents/progress-billing'

const ESTIMATE_TOTAL = 10661.70
const TAX_RATE = 0.08875
const BASE_PRICE = 980.386 // pre-tax unit price per line
const NUM_LINES = 10
const PCT = 0.50

// ─────────────────────────────────────────────
// BEFORE: old behaviour (no reconciliation)
// ─────────────────────────────────────────────
function buildSubtotalCentsOld(): number {
  let sub = 0
  for (let i = 0; i < NUM_LINES; i++) {
    sub += fromCents(toCents(BASE_PRICE * PCT)) // each line rounded independently
  }
  return toCents(sub)
}

const old1 = buildSubtotalCentsOld()
const oldTax1 = Math.round(old1 * TAX_RATE)
const oldInv1 = fromCents(old1 + oldTax1)

const old2 = buildSubtotalCentsOld()
const oldTax2 = Math.round(old2 * TAX_RATE)
const oldInv2 = fromCents(old2 + oldTax2)

const oldCumulative = oldInv1 + oldInv2

console.log('╔══════════════════════════════════════════════════╗')
console.log('║           BEFORE FIX (old behaviour)            ║')
console.log('╠══════════════════════════════════════════════════╣')
console.log(`║  Estimate Total:    $${ESTIMATE_TOTAL.toFixed(2).padStart(10)}                ║`)
console.log(`║  Invoice 1 Total:   $${oldInv1.toFixed(2).padStart(10)}                ║`)
console.log(`║  Invoice 2 Total:   $${oldInv2.toFixed(2).padStart(10)}                ║`)
console.log(`║  Cumulative:        $${oldCumulative.toFixed(2).padStart(10)}                ║`)
console.log(`║  Remaining:         $${Math.max(0, ESTIMATE_TOTAL - oldCumulative).toFixed(2).padStart(10)}                ║`)
console.log(`║  OVER-BILLING:      $${(oldCumulative - ESTIMATE_TOTAL).toFixed(2).padStart(10)} ← BUG          ║`)
console.log('╚══════════════════════════════════════════════════╝')
console.log()

// ─────────────────────────────────────────────
// AFTER: with reconciliation
// ─────────────────────────────────────────────
const makeLines = () =>
  Array.from({ length: NUM_LINES }, (_, i) => ({
    description: `Line ${i + 1}`,
    total: fromCents(toCents(BASE_PRICE * PCT)),
    unitPrice: fromCents(toCents(BASE_PRICE * PCT)),
    quantity: 1,
  }))

const estimateCents = toCents(ESTIMATE_TOTAL)

const inv1Lines = makeLines()
const inv1SubC = inv1Lines.reduce((s, l) => s + toCents(l.total), 0)
const r1 = computeProgressInvoiceTotals({
  subtotalCents: inv1SubC,
  taxRate: TAX_RATE,
  estimateTotalCents: estimateCents,
  existingInvoicedCents: 0,
  lines: inv1Lines,
})

const inv2Lines = makeLines()
const inv2SubC = inv2Lines.reduce((s, l) => s + toCents(l.total), 0)
const r2 = computeProgressInvoiceTotals({
  subtotalCents: inv2SubC,
  taxRate: TAX_RATE,
  estimateTotalCents: estimateCents,
  existingInvoicedCents: r1.totalCents,
  lines: inv2Lines,
})

const newCumulative = r1.totalCents + r2.totalCents
const newRemaining = estimateCents - newCumulative
const exact = newCumulative === estimateCents

console.log('╔══════════════════════════════════════════════════╗')
console.log('║          AFTER FIX (with reconciliation)        ║')
console.log('╠══════════════════════════════════════════════════╣')
console.log(`║  Estimate Total:    $${ESTIMATE_TOTAL.toFixed(2).padStart(10)}                ║`)
console.log(`║  Invoice 1 Total:   $${fromCents(r1.totalCents).toFixed(2).padStart(10)}${r1.wasReconciled ? ' ← reconciled' : '              '}  ║`)
console.log(`║  Invoice 2 Total:   $${fromCents(r2.totalCents).toFixed(2).padStart(10)}${r2.wasReconciled ? ' ← reconciled' : '              '}  ║`)
console.log(`║  Cumulative:        $${fromCents(newCumulative).toFixed(2).padStart(10)}                ║`)
console.log(`║  Remaining:         $${fromCents(newRemaining).toFixed(2).padStart(10)}                ║`)
console.log(`║  Status:            ${exact ? 'EXACT MATCH ✓               ' : 'MISMATCH ✗                  '}║`)
console.log('╚══════════════════════════════════════════════════╝')

process.exit(exact ? 0 : 1)
