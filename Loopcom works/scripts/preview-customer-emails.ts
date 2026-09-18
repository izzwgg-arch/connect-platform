/**
 * Generate HTML samples for email client QA.
 * Run: npx tsx scripts/preview-customer-emails.ts
 */
import fs from 'fs'
import path from 'path'
import { buildEstimateApprovalEmail } from '../lib/email/templates/estimate-approval'
import { buildInvoiceEmail } from '../lib/email/templates/invoice'
import {
  buildBulkPaymentReceiptEmail,
  buildPaymentReceiptEmail,
} from '../lib/email/templates/payment-receipt'
import { buildStatementEmail } from '../lib/email/templates/statement'

const outDir = path.join(process.cwd(), 'lib', 'email', 'samples')

const samples: Record<string, string> = {
  'estimate-approval.html': buildEstimateApprovalEmail({
    recipientName: 'Jane Client',
    customerName: 'Acme Trim Co',
    estimateNumber: 'EST-1042',
    total: '$4,250.00',
    sentDisplay: 'May 25, 2026 • 2:30 PM',
    approveUrl: 'https://app.trimprony.com/approve/example',
    pdfUrl: 'https://app.trimprony.com/api/public/estimates/example/pdf',
    validUntil: 'Jun 25, 2026',
    message: 'Please review line 3 — we adjusted crown molding qty.',
    companyName: 'TrimPro Demo',
  }),
  'invoice.html': buildInvoiceEmail({
    invoiceNumber: 'INV-2201',
    clientName: 'Jane Client',
    title: 'Kitchen crown and base install',
    dueDate: 'Jun 15, 2026',
    total: '1250.00',
    balance: '1250.00',
    sentDisplay: 'May 25, 2026 • 2:30 PM',
    pdfUrl: 'https://app.trimprony.com/api/public/invoices/example/pdf',
    paymentLink: 'https://app.trimprony.com/portal/pay/example',
    companyName: 'TrimPro Demo',
  }),
  'payment-receipt.html': buildPaymentReceiptEmail({
    recipientName: 'Jane Client',
    amountPaid: '$1,250.00',
    paidAt: new Date('2026-05-25T14:30:00'),
    transactionId: 'pay_abc123xyz',
    invoiceNumber: 'INV-2201',
    description: 'Invoice INV-2201 (Card)',
    receiptUrl: 'https://app.trimprony.com/pay/receipt/example-token',
    invoiceUrl: 'https://app.trimprony.com/portal/pay/example?token=example',
    companyName: 'TrimPro Demo',
    hasPdfAttachment: true,
  }),
  'payment-receipt-webhook.html': buildPaymentReceiptEmail({
    recipientName: 'Jane Client',
    amountPaid: '$500.00',
    paidAt: new Date('2026-05-25T14:30:00'),
    transactionId: 'txn_998877',
    invoiceNumber: 'INV-2201',
    description: 'Invoice INV-2201 (Card)',
    receiptUrl: 'https://app.trimprony.com/pay/receipt/example-token',
    invoiceUrl: 'https://app.trimprony.com/portal/pay/example?token=example',
    companyName: 'TrimPro Demo',
    hasPdfAttachment: true,
  }),
  'payment-receipt-bulk.html': buildBulkPaymentReceiptEmail({
    clientName: 'Jane Client',
    amountPaid: '$2,100.00',
    appliedCount: 3,
    transactionId: 'txn_bulk_001',
    portalUrl: 'https://app.trimprony.com/portal',
    companyName: 'TrimPro Demo',
  }),
  'statement.html': buildStatementEmail({
    clientName: 'Jane Client',
    recipientEmail: 'jane@example.com',
    openCount: 2,
    totalOutstanding: '$1,875.00',
    viewUrl: 'https://app.trimprony.com/portal/statement/example',
    hasPdf: true,
    companyName: 'TrimPro Demo',
  }),
}

fs.mkdirSync(outDir, { recursive: true })

for (const [filename, html] of Object.entries(samples)) {
  const filePath = path.join(outDir, filename)
  fs.writeFileSync(filePath, html, 'utf8')
  const hasOutlookRisks =
    /display:\s*inline-block|display:\s*inline-table|height:\s*1px.*<\/div>|line-height:\s*1;|min-height:|min-width:\s*100%/.test(
      html
    )
  console.log(`${filename}: ${(html.length / 1024).toFixed(1)} KB${hasOutlookRisks ? ' ⚠ check patterns' : ' ✓'}`)
}

console.log(`\nWrote ${Object.keys(samples).length} files to ${outDir}`)
console.log('Open in browser, then paste HTML into Litmus/Email on Acid or send test messages to Outlook/Gmail.')
