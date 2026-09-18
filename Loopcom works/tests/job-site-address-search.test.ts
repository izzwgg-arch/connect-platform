import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateJobSiteAddressSearchClauses,
  invoiceJobSiteAddressSearchClauses,
  jobRecordJobSiteAddressSearchClauses,
  leadJobSiteAddressSearchClauses,
  purchaseOrderJobSiteAddressSearchClauses,
} from '../lib/search/job-site-address'

const SEARCH = 'Brooklyn'

test('job record search matches all job_site address parts', () => {
  const clauses = jobRecordJobSiteAddressSearchClauses(SEARCH)
  assert.equal(clauses.length, 1)
  assert.deepEqual(clauses[0].addresses.some.type, 'job_site')
  const fields = clauses[0].addresses.some.OR.map((part: Record<string, unknown>) => Object.keys(part)[0])
  assert.deepEqual(fields.sort(), ['city', 'state', 'street', 'zipCode'])
  for (const part of clauses[0].addresses.some.OR) {
    const key = Object.keys(part)[0]
    assert.equal(part[key].contains, SEARCH)
    assert.equal(part[key].mode, 'insensitive')
  }
})

test('estimate search covers text field, lead fallback, and job address', () => {
  const clauses = estimateJobSiteAddressSearchClauses('11230')
  assert.ok(clauses.some((c) => c.jobSiteAddress?.contains === '11230'))
  assert.ok(clauses.some((c) => c.lead?.jobSiteAddress?.contains === '11230'))
  assert.ok(clauses.some((c) => c.job?.addresses?.some?.type === 'job_site'))
})

test('invoice search covers estimate text and job address', () => {
  const clauses = invoiceJobSiteAddressSearchClauses('Main')
  assert.ok(clauses.some((c) => c.estimate?.jobSiteAddress?.contains === 'Main'))
  assert.ok(clauses.some((c) => c.job?.addresses?.some?.type === 'job_site'))
})

test('purchase order search covers linked job address', () => {
  const clauses = purchaseOrderJobSiteAddressSearchClauses('123')
  assert.equal(clauses.length, 1)
  assert.equal(clauses[0].job.addresses.some.type, 'job_site')
})

test('lead/request search covers jobSiteAddress text field', () => {
  const clauses = leadJobSiteAddressSearchClauses('Main Street')
  assert.deepEqual(clauses, [{ jobSiteAddress: { contains: 'Main Street', mode: 'insensitive' } }])
})
