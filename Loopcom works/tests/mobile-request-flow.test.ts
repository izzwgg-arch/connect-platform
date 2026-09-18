import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCreatedRequestId,
  getRequestDetailsErrorCopy,
} from '../apps/mobile/src/screens/requests/request-utils'

test('create request success resolves request id for navigation', () => {
  const requestId = extractCreatedRequestId({
    lead: { id: 'req_123' },
  })
  assert.equal(requestId, 'req_123')
})

test('create request supports id-only payloads', () => {
  const requestId = extractCreatedRequestId({
    id: 'req_456',
  })
  assert.equal(requestId, 'req_456')
})

test('request details error copy handles forbidden/not-found as access error', () => {
  const forbidden = getRequestDetailsErrorCopy('Forbidden')
  const notFound = getRequestDetailsErrorCopy('Lead not found')

  assert.equal(forbidden.title, 'Access restricted')
  assert.equal(forbidden.description, "You don't have access to this request.")
  assert.equal(notFound.title, 'Access restricted')
  assert.equal(notFound.description, "You don't have access to this request.")
})
