import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateOrderedSubtotalRows, mergeApprovedOptionalItemsForSubtotals } from '../lib/documents/subtotals'

test('subtotal rows sum regular items since the previous subtotal', () => {
  const rows = calculateOrderedSubtotalRows([
    { description: 'A', quantity: '2', unitPrice: '10' },
    { description: 'B', quantity: '1', unitPrice: '5' },
    { description: 'Subtotal 1', isSubtotal: true },
    { description: 'C', quantity: '3', unitPrice: '7' },
    { description: 'Subtotal 2', isSubtotal: true },
  ])

  assert.equal(rows[2].calculatedSubtotalTotal, 25)
  assert.equal(rows[2].calculatedSubtotalQuantity, 3)
  assert.equal(rows[4].calculatedSubtotalTotal, 21)
  assert.equal(rows[4].calculatedSubtotalQuantity, 3)
})

test('subtotal rows ignore previous subtotals and group headers', () => {
  const rows = calculateOrderedSubtotalRows([
    { description: 'Group', isGroupHeader: true, quantity: '99', unitPrice: '99' },
    { description: 'A', quantity: '2', unitPrice: '10' },
    { description: 'Subtotal 1', isSubtotal: true, total: '999' },
    { description: 'Subtotal 2', isSubtotal: true, total: '999' },
  ])

  assert.equal(rows[2].calculatedSubtotalTotal, 20)
  assert.equal(rows[3].calculatedSubtotalTotal, 0)
})

test('approved optional items are merged before subtotal rows recalculate', () => {
  const mergedRows = mergeApprovedOptionalItemsForSubtotals(
    [
      { id: 'line-a', description: 'A', quantity: '2', unitPrice: '10', sortOrder: 10 },
      { id: 'subtotal-1', description: 'Subtotal 1', isSubtotal: true, sortOrder: 30 },
    ],
    [
      { id: 'optional-a', description: 'Approved optional', quantity: '1', unitPrice: '15', sortOrder: 20 },
    ]
  )
  const rows = calculateOrderedSubtotalRows(mergedRows)

  assert.equal(rows[2].calculatedSubtotalTotal, 35)
  assert.equal(rows[2].calculatedSubtotalQuantity, 3)
})

