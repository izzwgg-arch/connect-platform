import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQboPaymentRefNum,
  extractGatewayTransactionId,
  QBO_PAYMENT_REF_NUM_MAX,
} from '../lib/qbo/payment-ref-num'

test('extractGatewayTransactionId strips bulk suffixes', () => {
  assert.equal(extractGatewayTransactionId('1092359186123456789:cmpabc123'), '1092359186123456789')
  assert.equal(
    extractGatewayTransactionId('1092359186123456789 - Invoice INV-000329'),
    '1092359186123456789'
  )
})

test('buildQboPaymentRefNum truncates long gateway refs to 21 chars', () => {
  const ref = buildQboPaymentRefNum({
    providerPaymentId: '109235918612345678901234567890123',
    invoiceNumber: 'INV-000329',
  })
  assert.ok(ref)
  assert.equal(ref!.length, QBO_PAYMENT_REF_NUM_MAX)
})

test('buildQboPaymentRefNum keeps short refs with invoice suffix when it fits', () => {
  const ref = buildQboPaymentRefNum({
    providerPaymentId: '1234567890',
    invoiceNumber: 'INV-000329',
  })
  assert.equal(ref, '1234567890-000329')
})
