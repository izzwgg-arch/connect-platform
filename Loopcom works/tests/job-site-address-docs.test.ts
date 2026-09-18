import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoicePdfHtml, buildPurchaseOrderPdfHtml } from '../lib/documents/pdf-templates'

const brand = {
  businessName: 'Trim Pro',
  logoUrl: null,
  accentColor: '#12344d',
  accentTextColor: '#f5e7b8',
  footerText: null,
  businessPhone: null,
  businessEmail: null,
  businessAddress: null,
}

test('invoice PDF includes Job Site Address label and multiline content', () => {
  const html = buildInvoicePdfHtml(
    {
      invoiceNumber: 'INV-100',
      title: 'Invoice',
      status: 'DRAFT',
      invoiceDate: new Date().toISOString(),
      dueDate: null,
      discount: 0,
      taxAmount: 0,
      total: 100,
      balance: 100,
      paidAmount: 0,
      lineItems: [{ description: 'Line', quantity: 1, unitPrice: 100, total: 100 }],
      optionalItems: [],
      client: { name: 'Client', email: null, contacts: [] },
      job: null,
      estimate: { jobSiteAddress: '123 Main St\nSpringfield, IL 62701' },
    },
    brand
  )

  assert.ok(html.includes('Job Site Address'))
  assert.ok(html.includes('123 Main St<br/>Springfield, IL 62701'))
})

test('purchase order PDF includes Delivery Address and multiline content', () => {
  const html = buildPurchaseOrderPdfHtml(
    {
      poNumber: 'PO-100',
      total: 150,
      lineItems: [{ description: 'Material', quantity: 3, unitPrice: 50, total: 150 }],
      vendor: 'Vendor',
      vendorRef: null,
      job: {
        jobNumber: 'JOB-1',
        title: 'Cabinet Install',
        client: { name: 'Client' },
        addresses: [
          {
            street: '45 Oak Ave\nSuite 200',
            city: 'Denver',
            state: 'CO',
            zipCode: '80202',
          },
        ],
      },
    },
    { logoUrl: null, businessName: 'Trim Pro' }
  )

  assert.ok(html.includes('Delivery Address'))
  assert.ok(html.includes('45 Oak Ave<br/>Suite 200, Denver, CO 80202'))
  // Vendor-facing PO shows address only — not job name/number
  assert.equal(html.includes('JOB-1'), false)
  assert.equal(html.includes('Cabinet Install'), false)
})

test('documents omit Job Site Address section when missing', () => {
  const invoiceHtml = buildInvoicePdfHtml(
    {
      invoiceNumber: 'INV-101',
      title: 'Invoice',
      status: 'DRAFT',
      invoiceDate: new Date().toISOString(),
      dueDate: null,
      discount: 0,
      taxAmount: 0,
      total: 100,
      balance: 100,
      paidAmount: 0,
      lineItems: [{ description: 'Line', quantity: 1, unitPrice: 100, total: 100 }],
      optionalItems: [],
      client: { name: 'Client', email: null, contacts: [] },
      job: null,
      estimate: { jobSiteAddress: null },
    },
    brand
  )
  const poHtml = buildPurchaseOrderPdfHtml(
    {
      poNumber: 'PO-101',
      total: 150,
      lineItems: [{ description: 'Material', quantity: 3, unitPrice: 50, total: 150 }],
      vendor: 'Vendor',
      vendorRef: null,
      job: {
        jobNumber: 'JOB-2',
        title: 'No Address Job',
        client: { name: 'Client' },
        addresses: [],
      },
    },
    { logoUrl: null, businessName: 'Trim Pro' }
  )

  assert.equal(invoiceHtml.includes('Job Site Address'), false)
  assert.equal(poHtml.includes('Job Site Address'), false)
})
