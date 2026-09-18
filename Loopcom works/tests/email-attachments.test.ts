import test from 'node:test'
import assert from 'node:assert/strict'
import { sendEmailWithAttachments } from '../lib/integrations/providers/email'

test('sendEmailWithAttachments includes PDF attachments for all recipients', async () => {
  const previousAdminCc = process.env.ADMIN_CC_EMAIL
  const originalFetch = globalThis.fetch
  let sentBody: any = null

  process.env.ADMIN_CC_EMAIL = ''
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body || '{}'))
    return new Response(null, { status: 202 })
  }) as typeof fetch

  try {
    const pdf = Buffer.from('%PDF-1.4 test attachment')
    const result = await sendEmailWithAttachments({
      secrets: {
        provider: 'sendgrid',
        apiKey: 'test-key',
        fromEmail: 'sender@example.com',
        fromName: 'TrimPro',
      },
      to: ['first@example.com', 'second@example.com'],
      subject: 'Invoice INV-1001',
      html: '<p>Please review.</p>',
      attachments: [
        {
          filename: 'Invoice-INV-1001.pdf',
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
    })

    assert.equal(result.success, true)
    assert.deepEqual(sentBody.personalizations[0].to, [
      { email: 'first@example.com' },
      { email: 'second@example.com' },
    ])
    assert.equal(sentBody.attachments[0].filename, 'Invoice-INV-1001.pdf')
    assert.equal(sentBody.attachments[0].type, 'application/pdf')
    assert.equal(sentBody.attachments[0].disposition, 'attachment')
    assert.equal(sentBody.attachments[0].content, pdf.toString('base64'))
  } finally {
    if (previousAdminCc === undefined) delete process.env.ADMIN_CC_EMAIL
    else process.env.ADMIN_CC_EMAIL = previousAdminCc
    globalThis.fetch = originalFetch
  }
})
