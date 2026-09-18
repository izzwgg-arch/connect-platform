import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWaterfallPlannedAmounts,
  orderInvoicesByStoredIds,
  orderInvoicesDominantFirst,
  parsePublicPaymentAmount,
  resolvePublicPaymentPlan,
} from '../lib/payments/bulk-card-allocation'

test('parsePublicPaymentAmount accepts formatted currency input', () => {
  assert.equal(parsePublicPaymentAmount('2500'), 2500)
  assert.equal(parsePublicPaymentAmount('$2,500.50'), 2500.5)
  assert.equal(parsePublicPaymentAmount(''), null)
  assert.equal(parsePublicPaymentAmount('abc'), null)
})

test('orderInvoicesDominantFirst puts dominant invoice first', () => {
  const rows = [
    { id: 'old', balance: 100, dueDate: '2026-01-01', invoiceDate: '2026-01-01' },
    { id: 'current', balance: 200, dueDate: '2026-06-01', invoiceDate: '2026-06-01' },
    { id: 'mid', balance: 50, dueDate: '2026-03-01', invoiceDate: '2026-03-01' },
  ]
  const ordered = orderInvoicesDominantFirst('current', rows)
  assert.deepEqual(ordered.map((r) => r.id), ['current', 'old', 'mid'])
})

test('buildWaterfallPlannedAmounts pays dominant first then cascades', () => {
  const rows = [
    { id: 'a', balance: 200 },
    { id: 'b', balance: 100 },
    { id: 'c', balance: 100 },
  ]
  assert.deepEqual(buildWaterfallPlannedAmounts(rows, 250), { a: 200, b: 50 })
  assert.deepEqual(buildWaterfallPlannedAmounts(rows, 400), { a: 200, b: 100, c: 100 })
})

test('orderInvoicesByStoredIds preserves intent order', () => {
  const rows = [
    { id: 'b', balance: 1 },
    { id: 'a', balance: 2 },
    { id: 'c', balance: 3 },
  ]
  const ordered = orderInvoicesByStoredIds(['a', 'c', 'b'], rows)
  assert.deepEqual(ordered.map((r) => r.id), ['a', 'c', 'b'])
})

test('resolvePublicPaymentPlan supports explicit per-invoice amounts', () => {
  const rows = [
    { id: 'current', balance: 20000, invoiceNumber: 'INV-1' },
    { id: 'older', balance: 5000, invoiceNumber: 'INV-2' },
  ]
  const plan = resolvePublicPaymentPlan('current', rows, {
    perInvoiceAmounts: { current: 10000, older: 10000 },
  })
  assert.ok(!('error' in plan))
  if ('error' in plan) return
  assert.equal(plan.mode, 'planned')
  assert.equal(plan.total, 15000)
  assert.deepEqual(plan.plannedAmountsByInvoice, { current: 10000, older: 5000 })
})

test('resolvePublicPaymentPlan waterfalls a custom total from the dominant invoice down', () => {
  const rows = [
    { id: 'current', balance: 20000, invoiceNumber: 'INV-1' },
    { id: 'older', balance: 5000, invoiceNumber: 'INV-2' },
  ]
  const plan = resolvePublicPaymentPlan('current', rows, { globalAmount: 15000 })
  assert.ok(!('error' in plan))
  if ('error' in plan) return
  assert.equal(plan.mode, 'waterfall')
  assert.deepEqual(plan.plannedAmountsByInvoice, { current: 15000 })
  assert.equal(plan.total, 15000)
})
