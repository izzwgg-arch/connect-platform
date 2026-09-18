import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUrgentUpdateData } from '../lib/requests/urgent'

test('buildUrgentUpdateData sets urgent metadata when enabling urgent', () => {
  const now = new Date('2026-03-01T10:00:00.000Z')
  const result = buildUrgentUpdateData(true, 'user_123', now)
  assert.equal(result.isUrgent, true)
  assert.equal(result.urgentByUserId, 'user_123')
  assert.equal(result.urgentAt?.toISOString(), '2026-03-01T10:00:00.000Z')
})

test('buildUrgentUpdateData clears urgent metadata when disabling urgent', () => {
  const result = buildUrgentUpdateData(false, 'user_123')
  assert.equal(result.isUrgent, false)
  assert.equal(result.urgentByUserId, null)
  assert.equal(result.urgentAt, null)
})
