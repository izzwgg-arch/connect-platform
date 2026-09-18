import test from 'node:test'
import assert from 'node:assert/strict'
import { INVOICE_TEMPLATES } from '../lib/invoices/templates/registry'
import { renderInvoicePdfTemplate } from '../lib/invoices/pdf/templates'

const baseData = {
  logoUrl: null,
  businessName: 'Sample Business',
  businessDetails: '555-555-5555 • hello@example.com',
  clientName: 'Sample Client',
  clientEmail: 'client@example.com',
  invoiceNumber: 'INV-1001',
  title: 'Sample Invoice',
  status: 'DRAFT',
  invoiceDate: '03/01/2026',
  dueDate: '03/15/2026',
  generatedAt: '03/01/2026 12:00 PM',
  accentColor: '#12344d',
  lineItems: [
    { description: 'Line A', notes: 'Desc A', quantity: 1, unitPrice: 100, total: 100 },
    { description: 'Line B', notes: 'Desc B', quantity: 2, unitPrice: 50, total: 100 },
  ],
  optionalItems: [{ description: 'Optional A', notes: 'Optional', quantity: 1, unitPrice: 25, total: 25 }],
  subtotal: 200,
  optionalSubtotal: 25,
  discount: 10,
  tax: 15.2,
  paid: 0,
  total: 205.2,
  balance: 205.2,
  notes: 'Sample notes',
  footerText: 'Sample footer',
  paymentLink: 'https://example.com/pay',
}

test('all invoice PDF templates render non-empty HTML', () => {
  for (const template of INVOICE_TEMPLATES) {
    const html = renderInvoicePdfTemplate({
      ...baseData,
      templateId: template.id,
    })
    assert.ok(html, `Template ${template.id} did not render HTML`)
    assert.ok(html!.includes('<!doctype html>'), `Template ${template.id} missing doctype`)
    assert.ok(html!.includes(baseData.invoiceNumber), `Template ${template.id} missing invoice number`)
  }
})

test('invalid template id returns null', () => {
  const html = renderInvoicePdfTemplate({
    ...baseData,
    templateId: 'does-not-exist',
  })
  assert.equal(html, null)
})
