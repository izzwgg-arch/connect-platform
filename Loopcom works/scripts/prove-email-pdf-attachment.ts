/**
 * End-to-end proof that invoice + estimate emails carry a real PDF attachment.
 *
 * This exercises the EXACT helpers the send routes call:
 *   - renderInvoiceEmailPdfAttachment / renderEstimateEmailPdfAttachment  (real puppeteer render)
 *   - sendEmailWithAttachments                                            (real provider serialization)
 *
 * It stubs only the outbound network call so we can capture and inspect the
 * provider request body, then verifies the attachment decodes to real PDF bytes.
 *
 * Run: npx tsx scripts/prove-email-pdf-attachment.ts
 */
import assert from 'node:assert/strict'
import {
  renderInvoiceEmailPdfAttachment,
  renderEstimateEmailPdfAttachment,
} from '../lib/documents/email-pdf-attachments'
import { sendEmailWithAttachments } from '../lib/integrations/providers/email'

const brand = {
  businessName: 'Trim Pro NY',
  businessPhone: '555-123-4567',
  businessEmail: 'hello@trimprony.com',
  businessAddress: '123 Main St, Brooklyn, NY',
  logoUrl: null,
  accentColor: '#12344d',
  accentTextColor: '#ffffff',
}

const invoice = {
  invoiceNumber: 'INV-9001',
  status: 'SENT',
  invoiceDate: new Date('2026-06-25'),
  subtotal: 200,
  taxAmount: 16,
  total: 216,
  balance: 216,
  client: { name: 'Acme Builders', companyName: 'Acme Builders LLC', email: 'acme@example.com' },
  lineItems: [
    { description: 'Crown molding', notes: 'Living room', quantity: 2, unitPrice: 50, total: 100, isVisibleToClient: true },
    { description: 'Baseboard', notes: 'Hallway', quantity: 2, unitPrice: 50, total: 100, isVisibleToClient: true },
  ],
  optionalItems: [],
}

const estimate = {
  estimateNumber: 'EST-7001',
  status: 'SENT',
  validUntil: new Date('2026-07-25'),
  subtotal: 300,
  discount: 0,
  taxRate: 0.08,
  total: 324,
  client: { name: 'Acme Builders', companyName: 'Acme Builders LLC', email: 'acme@example.com' },
  lineItems: [
    { id: 'li1', description: 'Trim package', notes: 'Whole house', quantity: 1, unitPrice: 300, total: 300, isVisibleToClient: true },
  ],
  optionalItems: [],
}

type Capture = { provider: string; body: any }

async function runOne(label: string, attachment: { filename: string; content: Buffer; contentType: string }) {
  const captures: Capture[] = []
  const originalFetch = globalThis.fetch
  const prevAdminCc = process.env.ADMIN_CC_EMAIL
  process.env.ADMIN_CC_EMAIL = ''

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    captures.push({ provider: String(url), body: init?.body })
    return new Response(null, { status: 202 })
  }) as typeof fetch

  try {
    // Prove the attachment itself is a real PDF.
    assert.ok(Buffer.isBuffer(attachment.content), `${label}: attachment content is not a Buffer`)
    const head = attachment.content.subarray(0, 5).toString('latin1')
    assert.equal(head, '%PDF-', `${label}: rendered bytes are not a PDF (got "${head}")`)
    assert.ok(attachment.content.length > 1000, `${label}: PDF suspiciously small (${attachment.content.length} bytes)`)
    assert.equal(attachment.contentType, 'application/pdf', `${label}: wrong content type`)

    // Prove it survives serialization into the provider request, for every provider.
    for (const provider of ['sendgrid', 'resend', 'mailgun'] as const) {
      captures.length = 0
      const result = await sendEmailWithAttachments({
        secrets: { provider, apiKey: 'test-key', mailgunDomain: 'mg.example.com', fromEmail: 'send@example.com', fromName: 'Trim Pro' },
        to: ['first@example.com', 'second@example.com'],
        subject: `${label} ${attachment.filename}`,
        html: '<p>See attached.</p>',
        attachments: [attachment],
      })
      assert.equal(result.success, true, `${label}/${provider}: send failed: ${result.error || result.message}`)
      assert.equal(captures.length, 1, `${label}/${provider}: expected exactly one outbound request`)

      const { body } = captures[0]
      if (provider === 'mailgun') {
        // FormData body — inspect entries.
        assert.ok(body instanceof FormData, `${label}/${provider}: expected FormData body`)
        const tos = (body as FormData).getAll('to')
        assert.deepEqual(tos, ['first@example.com', 'second@example.com'], `${label}/${provider}: recipients lost`)
        const att = (body as FormData).get('attachment')
        assert.ok(att, `${label}/${provider}: no attachment in form data`)
        const buf = Buffer.from(await (att as Blob).arrayBuffer())
        assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-', `${label}/${provider}: attachment is not a PDF`)
      } else {
        const json = JSON.parse(String(body))
        const atts = json.attachments
        assert.ok(Array.isArray(atts) && atts.length === 1, `${label}/${provider}: attachment array missing`)
        const decoded = Buffer.from(atts[0].content, 'base64')
        assert.equal(decoded.subarray(0, 5).toString('latin1'), '%PDF-', `${label}/${provider}: base64 payload is not a PDF`)
        assert.equal(decoded.toString('latin1'), attachment.content.toString('latin1'), `${label}/${provider}: PDF bytes altered in transit`)
        if (provider === 'sendgrid') {
          assert.deepEqual(json.personalizations[0].to, [{ email: 'first@example.com' }, { email: 'second@example.com' }], `${label}/sendgrid: recipients lost`)
        } else {
          assert.deepEqual(json.to, ['first@example.com', 'second@example.com'], `${label}/resend: recipients lost`)
        }
      }
      console.log(`  PASS  ${label} -> ${provider}: PDF "${attachment.filename}" (${attachment.content.length} bytes) attached for 2 recipients`)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (prevAdminCc === undefined) delete process.env.ADMIN_CC_EMAIL
    else process.env.ADMIN_CC_EMAIL = prevAdminCc
  }
}

async function main() {
  console.log('Rendering real PDFs via puppeteer...')
  const invoiceAttachment = await renderInvoiceEmailPdfAttachment(invoice, brand)
  const estimateAttachment = await renderEstimateEmailPdfAttachment(estimate, brand, new Set())

  console.log('\nInvoice email proof:')
  await runOne('invoice', invoiceAttachment)
  console.log('\nEstimate email proof:')
  await runOne('estimate', estimateAttachment)

  console.log('\nALL CHECKS PASSED: invoice + estimate emails serialize a real PDF attachment across SendGrid, Resend, and Mailgun.')
  process.exit(0)
}

main().catch((err) => {
  console.error('\nPROOF FAILED:', err)
  process.exit(1)
})
