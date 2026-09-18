/**
 * Run with: npx tsx --test tests/custom-payment.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isCustomPayment,
  isGatewayPayment,
  getCustomPaymentUiMethod,
  getCustomPaymentLabel,
  mapCustomPaymentMethodToDb,
} from '../lib/payments/custom-payment'

test('isGatewayPayment: ACH quickbooks reconcile', () => {
  assert.equal(
    isGatewayPayment({
      method: 'ACH',
      status: 'COMPLETED',
      provider: 'quickbooks',
      reference: 'qbo_reconcile_28332_1790.00',
    }),
    true
  )
})

test('isGatewayPayment: SOLA card', () => {
  assert.equal(
    isGatewayPayment({
      method: 'CARD',
      status: 'COMPLETED',
      provider: 'sola',
      solaTransactionId: 'tx-123',
    }),
    true
  )
})

test('isCustomPayment: legacy OTHER with custom provider slug', () => {
  const payment = {
    method: 'OTHER',
    status: 'COMPLETED',
    provider: 'zelle',
    notes: 'Manually marked as paid — Zelle',
  }
  assert.equal(isCustomPayment(payment), true)
  assert.equal(getCustomPaymentUiMethod(payment), 'OTHER')
  assert.equal(getCustomPaymentLabel(payment), 'Zelle')
})

test('isCustomPayment: legacy BANK_TRANSFER manual entry', () => {
  assert.equal(
    isCustomPayment({
      method: 'BANK_TRANSFER',
      status: 'COMPLETED',
      provider: 'wire_transfer',
      notes: null,
    }),
    true
  )
})

test('isCustomPayment: check and quick pay remain editable', () => {
  assert.equal(
    isCustomPayment({ method: 'CHECK', status: 'COMPLETED', provider: 'manual' }),
    true
  )
  assert.equal(
    isCustomPayment({ method: 'CASH', status: 'COMPLETED', provider: 'quick_pay' }),
    true
  )
})

test('isCustomPayment: non-completed payments are not editable', () => {
  assert.equal(
    isCustomPayment({ method: 'CHECK', status: 'PENDING', provider: 'manual' }),
    false
  )
})

test('mapCustomPaymentMethodToDb: OTHER custom label', () => {
  assert.deepEqual(mapCustomPaymentMethodToDb('OTHER', 'Venmo'), {
    method: 'OTHER',
    provider: 'venmo',
  })
})
