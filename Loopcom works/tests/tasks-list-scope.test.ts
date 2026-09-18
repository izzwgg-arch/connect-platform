import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canViewAllTasksList,
  defaultTasksListFilter,
  resolveTasksListFilter,
} from '@/lib/tasks/list-scope'

test('defaults to personal inbox', () => {
  assert.equal(defaultTasksListFilter(), 'my')
})

test('allows admins to view all tasks', () => {
  assert.equal(canViewAllTasksList({ role: 'ADMIN', permissions: [] }), true)
})

test('blocks non-managers from all-tasks filter', () => {
  assert.equal(
    resolveTasksListFilter('all', { role: 'FIELD', permissions: ['tasks.view'] }),
    'my'
  )
})

test('keeps assigned filter for regular users', () => {
  assert.equal(
    resolveTasksListFilter('assigned', { role: 'FIELD', permissions: ['tasks.view'] }),
    'assigned'
  )
})
