import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveScheduleScope } from '@/lib/schedule/scope'

test('user without view_all cannot force all scope', () => {
  const result = resolveScheduleScope({
    requestedScope: 'all',
    requestedUserId: 'all',
    currentUserId: 'user-1',
    canViewAll: false,
  })

  assert.equal(result.scope, 'self')
  assert.equal(result.effectiveUserId, 'user-1')
})

test('user with view_all can fetch all scope', () => {
  const result = resolveScheduleScope({
    requestedScope: 'all',
    requestedUserId: 'all',
    currentUserId: 'user-1',
    canViewAll: true,
  })

  assert.equal(result.scope, 'all')
  assert.equal(result.effectiveUserId, undefined)
})

test('user without view_all cannot fetch other user schedules', () => {
  const result = resolveScheduleScope({
    requestedScope: 'self',
    requestedUserId: 'user-2',
    currentUserId: 'user-1',
    canViewAll: false,
  })

  assert.equal(result.scope, 'self')
  assert.equal(result.effectiveUserId, 'user-1')
})

test('user with view_all can fetch specific user schedules', () => {
  const result = resolveScheduleScope({
    requestedScope: 'self',
    requestedUserId: 'user-2',
    currentUserId: 'user-1',
    canViewAll: true,
  })

  assert.equal(result.scope, 'all')
  assert.equal(result.effectiveUserId, 'user-2')
})
