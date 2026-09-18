import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateEstimateConversionSummary,
  getEstimateConversionProgress,
} from '../lib/documents/conversion'

test('estimate conversion percentage sums multiple linked invoice totals', () => {
  const summary = calculateEstimateConversionSummary('1000', ['500', '250'])

  assert.equal(summary.invoicedTotal, 750)
  assert.equal(summary.convertedPercent, 75)
})

test('estimate conversion percentage clamps at 100 for display', () => {
  const summary = calculateEstimateConversionSummary('1000', ['500', '600'])

  assert.equal(summary.invoicedTotal, 1100)
  assert.equal(summary.convertedPercent, 100)
})

test('getEstimateConversionProgress tracks remaining after partial invoices', () => {
  const p = getEstimateConversionProgress('10000', ['5000'])

  assert.equal(p.estimateTotal, 10000)
  assert.equal(p.invoicedTotal, 5000)
  assert.equal(p.remainingAmount, 5000)
  assert.ok(Math.abs(p.remainingPercent - 50) < 0.01)
  assert.equal(p.isFullyInvoiced, false)
})

test('getEstimateConversionProgress marks fully invoiced within tolerance', () => {
  const p = getEstimateConversionProgress('10000', ['9999.99', '0.01'])

  assert.equal(p.isFullyInvoiced, true)
  assert.ok(p.remainingAmount <= 0.01)
})

