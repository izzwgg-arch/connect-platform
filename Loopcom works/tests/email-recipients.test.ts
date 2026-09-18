import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dedupeRecipients,
  mergeConfiguredGlobalCc,
  normalizeEmail,
  parseEmailList,
} from '../lib/email/recipients'

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail(' Test@Email.com '), 'test@email.com')
})

test('parseEmailList dedupes casing and whitespace variants', () => {
  assert.deepEqual(
    parseEmailList(['Test@Email.com', ' test@email.com ', 'other@email.com;OTHER@email.com']),
    ['test@email.com', 'other@email.com']
  )
})

test('mergeConfiguredGlobalCc adds global CC once', () => {
  const previous = process.env.ADMIN_CC_EMAIL
  process.env.ADMIN_CC_EMAIL = 'Audit@TrimPro.com'

  try {
    const recipients = mergeConfiguredGlobalCc({
      to: 'customer@example.com',
      cc: ['audit@trimpro.com', ' AUDIT@TRIMPRO.COM '],
    })

    assert.deepEqual(recipients.to, ['customer@example.com'])
    assert.deepEqual(recipients.cc, ['audit@trimpro.com'])
    assert.deepEqual(recipients.bcc, [])
  } finally {
    if (previous === undefined) delete process.env.ADMIN_CC_EMAIL
    else process.env.ADMIN_CC_EMAIL = previous
  }
})

test('dedupeRecipients removes duplicate CC and prevents TO from also appearing in CC/BCC', () => {
  const recipients = dedupeRecipients({
    to: ['Customer@Example.com', 'customer@example.com'],
    cc: ['customer@example.com', 'audit@example.com', ' Audit@Example.com '],
    bcc: ['audit@example.com', 'other@example.com'],
  })

  assert.deepEqual(recipients.to, ['customer@example.com'])
  assert.deepEqual(recipients.cc, ['audit@example.com'])
  assert.deepEqual(recipients.bcc, ['other@example.com'])
})

