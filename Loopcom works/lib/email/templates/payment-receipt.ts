import {
  buildEmailBodySection,
  buildEmailButtonGroup,
  buildEmailDetailsCard,
  buildEmailFooterBlock,
  buildEmailHeaderBlock,
  buildEmailHeroBlock,
  buildEmailParagraph,
  buildEmailShell,
  buildEmailSupportNote,
  escapeHtml,
} from '@/lib/email/shell'

export interface PaymentReceiptEmailOptions {
  recipientName: string
  amountPaid: string
  paidAt: Date | string
  transactionId: string
  description?: string
  logoUrl?: string
  companyName?: string
  supportEmail?: string
  companyAddress?: string
  receiptUrl?: string
  invoiceUrl?: string
  invoiceNumber?: string
  hasPdfAttachment?: boolean
}

function formatDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d)
}

export interface InvoicePaymentReceiptEmailOptions {
  clientName: string
  invoiceNumber: string
  amountPaid: string
  paidToDate: string
  balance: string
  transactionId?: string
  receiptUrl: string
  logoUrl?: string
  companyName?: string
}

export function buildInvoicePaymentReceiptEmail(opts: InvoicePaymentReceiptEmailOptions): string {
  const {
    clientName,
    invoiceNumber,
    amountPaid,
    paidToDate,
    balance,
    transactionId,
    receiptUrl,
    logoUrl,
    companyName = 'TrimPro',
  } = opts

  const rows = [
    { label: 'Paid to Date', value: paidToDate },
    { label: 'Balance', value: balance },
    ...(transactionId ? [{ label: 'Transaction ID', value: transactionId }] : []),
  ]

  const bodyInner = [
    buildEmailParagraph(
      `Hi ${escapeHtml(clientName || 'there')}, we received your payment and applied it to your invoice.`,
      { marginBottom: 20 }
    ),
    buildEmailDetailsCard({
      title: 'Receipt Details',
      rows,
      featuredLabel: 'Amount Paid',
      featuredValue: amountPaid,
    }),
    buildEmailButtonGroup([{ label: 'View Receipt', href: receiptUrl }]),
    buildEmailSupportNote(
      'Questions? <strong style="color:#ffffff;">Reply to this email</strong> and we will help.'
    ),
  ].join('')

  return buildEmailShell({
    title: `Payment Receipt — Invoice ${invoiceNumber}`,
    preheader: `Payment received for invoice ${invoiceNumber}: ${amountPaid}`,
    headerHtml: buildEmailHeaderBlock({ logoUrl, companyName, eyebrow: 'Payment Receipt' }),
    bodyHtml: [
      buildEmailHeroBlock({
        badge: 'Payment Confirmed',
        headline: 'Payment Received',
        meta: `Invoice ${escapeHtml(invoiceNumber)}`,
      }),
      buildEmailBodySection(bodyInner),
    ].join(''),
    footerHtml: buildEmailFooterBlock({
      companyName,
      lines: [`Invoice ${escapeHtml(invoiceNumber)}`],
    }),
  })
}

export function buildBulkPaymentReceiptEmail(opts: {
  clientName: string
  amountPaid: string
  appliedCount: number
  transactionId?: string
  portalUrl: string
  logoUrl?: string
  companyName?: string
}): string {
  const rows = [
    { label: 'Invoices Applied', value: String(opts.appliedCount) },
    ...(opts.transactionId ? [{ label: 'Transaction ID', value: opts.transactionId }] : []),
  ]

  const bodyInner = [
    buildEmailParagraph(
      `Hi ${escapeHtml(opts.clientName || 'there')}, your payment was applied to multiple outstanding invoices.`,
      { marginBottom: 20 }
    ),
    buildEmailDetailsCard({
      title: 'Receipt Details',
      rows,
      featuredLabel: 'Amount Paid',
      featuredValue: opts.amountPaid,
    }),
    buildEmailButtonGroup([{ label: 'View Account', href: opts.portalUrl }]),
    buildEmailSupportNote(
      'Questions? <strong style="color:#ffffff;">Reply to this email</strong> and we will help.'
    ),
  ].join('')

  return buildEmailShell({
    title: 'Bulk Payment Receipt',
    preheader: `Payment received: ${opts.amountPaid}`,
    headerHtml: buildEmailHeaderBlock({
      logoUrl: opts.logoUrl,
      companyName: opts.companyName || 'TrimPro',
      eyebrow: 'Payment Receipt',
    }),
    bodyHtml: [
      buildEmailHeroBlock({
        badge: 'Payment Applied',
        headline: 'Bulk Payment Received',
        meta: `${opts.appliedCount} invoice(s)`,
      }),
      buildEmailBodySection(bodyInner),
    ].join(''),
    footerHtml: buildEmailFooterBlock({
      companyName: opts.companyName || 'TrimPro',
      lines: ['Thank you for your payment.'],
    }),
  })
}

export function buildPaymentReceiptEmail(opts: PaymentReceiptEmailOptions): string {
  const {
    recipientName,
    amountPaid,
    paidAt,
    transactionId,
    description = 'Outstanding invoices payment',
    logoUrl,
    companyName = 'TrimPro',
    supportEmail = 'support@trimprony.com',
    companyAddress = '',
    receiptUrl,
    invoiceUrl,
    invoiceNumber,
    hasPdfAttachment = false,
  } = opts

  const dateString = formatDate(paidAt)
  const buttons = [
    ...(receiptUrl ? [{ label: 'View Receipt', href: receiptUrl }] : []),
    ...(invoiceUrl ? [{ label: 'View Invoice', href: invoiceUrl }] : []),
  ]

  const bodyInner = [
    buildEmailParagraph(`Hi ${escapeHtml(recipientName)},`, { marginBottom: 6 }),
    buildEmailParagraph(
      'Thank you for your payment. We&rsquo;ve received and applied it to your outstanding invoice(s).',
      { marginBottom: hasPdfAttachment ? 12 : 22 }
    ),
    ...(hasPdfAttachment
      ? [
          buildEmailParagraph(
            'A PDF copy of your receipt is attached to this email.',
            { marginBottom: 22 }
          ),
        ]
      : []),
    buildEmailDetailsCard({
      title: 'Receipt Details',
      rows: [
        { label: 'Date', value: dateString },
        { label: 'Transaction ID', value: transactionId },
        { label: 'Description', value: description },
      ],
      featuredLabel: 'Amount Paid',
      featuredValue: amountPaid,
    }),
    buildEmailButtonGroup(buttons),
    buildEmailSupportNote(
      'If you have any questions, <strong style="color:#ffffff;">reply to this email</strong> &mdash; we&rsquo;re here to help.'
    ),
  ].join('')

  const metaParts = [
    invoiceNumber ? `Invoice ${escapeHtml(invoiceNumber)}` : '',
    escapeHtml(dateString),
  ].filter(Boolean)

  return buildEmailShell({
    title: `Payment Receipt — ${companyName}`,
    preheader: `Payment received: ${amountPaid}`,
    headerHtml: buildEmailHeaderBlock({ logoUrl, companyName, eyebrow: 'Payment Receipt' }),
    bodyHtml: [
      buildEmailHeroBlock({
        badge: 'Payment Confirmed',
        headline: 'Payment Received',
        meta: metaParts.join(' &bull; '),
      }),
      buildEmailBodySection(bodyInner),
    ].join(''),
    footerHtml: buildEmailFooterBlock({
      companyName,
      supportEmail,
      lines: [
        companyAddress ? escapeHtml(companyAddress) : 'Thank you for your business.',
      ],
    }),
  })
}
