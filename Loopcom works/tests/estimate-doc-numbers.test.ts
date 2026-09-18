import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EstimateDocNumberError,
  ESTIMATE_NUMBER_QBO_CONFLICT_MESSAGE,
  buildSequentialEstimateNumber,
  mapEstimateDocNumberErrorToResponse,
  normalizeEstimateNumber,
  queryQboEstimateDocNumberExists,
  tenantRequiresQboEstimateDocNumberCheck,
} from '../lib/qbo/doc-numbers'

test('normalizeEstimateNumber pads numeric and EST-* forms', () => {
  assert.equal(normalizeEstimateNumber('1234'), 'EST-001234')
  assert.equal(normalizeEstimateNumber('EST-42'), 'EST-000042')
  assert.equal(normalizeEstimateNumber('  custom-1 '), 'custom-1')
})

test('buildSequentialEstimateNumber increments from base', () => {
  assert.equal(buildSequentialEstimateNumber(10, 1), 'EST-000011')
  assert.equal(buildSequentialEstimateNumber(0, 3), 'EST-000003')
})

test('mapEstimateDocNumberErrorToResponse maps QBO conflict to 409', () => {
  const err = new EstimateDocNumberError(
    'ESTIMATE_NUMBER_QBO_CONFLICT',
    `${ESTIMATE_NUMBER_QBO_CONFLICT_MESSAGE} (EST-001234)`,
    'EST-001234'
  )
  const mapped = mapEstimateDocNumberErrorToResponse(err)
  assert.ok(mapped)
  assert.equal(mapped!.status, 409)
  assert.equal(mapped!.body.code, 'ESTIMATE_NUMBER_QBO_CONFLICT')
  assert.equal(mapped!.body.estimateNumber, 'EST-001234')
})

test('mapEstimateDocNumberErrorToResponse maps QBO unavailable to 503', () => {
  const err = new EstimateDocNumberError('QBO_UNAVAILABLE', 'QuickBooks unavailable', 'EST-000001')
  const mapped = mapEstimateDocNumberErrorToResponse(err)
  assert.ok(mapped)
  assert.equal(mapped!.status, 503)
})

test('queryQboEstimateDocNumberExists uses exact DocNumber query', async () => {
  let capturedQuery = ''
  const exists = await queryQboEstimateDocNumberExists(
    { accessToken: 'tok', realmId: 'realm' },
    'tenant-1',
    'EST-009999',
    async (_token, _realm, query) => {
      capturedQuery = query
      return { QueryResponse: { Estimate: [{ Id: '1', DocNumber: 'EST-009999' }] } }
    }
  )
  assert.equal(exists, true)
  assert.match(capturedQuery, /DocNumber = 'EST-009999'/)
  assert.match(capturedQuery, /maxresults 1/)
})

test('queryQboEstimateDocNumberExists returns false when QBO has no match', async () => {
  const exists = await queryQboEstimateDocNumberExists(
    { accessToken: 'tok', realmId: 'realm' },
    'tenant-1',
    'EST-000001',
    async () => ({ QueryResponse: { Estimate: [] } })
  )
  assert.equal(exists, false)
})

test('tenantRequiresQboEstimateDocNumberCheck is false without integration', async () => {
  const required = await tenantRequiresQboEstimateDocNumberCheck('nonexistent-tenant-id-xyz')
  assert.equal(required, false)
})
