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

export interface InvoiceEmailOptions {
  invoiceNumber: string
  clientName: string
  title?: string
  dueDate?: string
  total: string
  balance: string
  sentDisplay: string
  pdfUrl: string
  paymentLink?: string
  message?: string
  logoUrl?: string
  companyName?: string
}

export function buildInvoiceEmail(opts: InvoiceEmailOptions): string {
  const {
    invoiceNumber,
    clientName,
    title,
    dueDate,
    total,
    balance,
    sentDisplay,
    pdfUrl,
    paymentLink,
    message,
    logoUrl,
    companyName = 'TrimPro',
  } = opts

  const buttons = [
    ...(paymentLink ? [{ label: 'Pay Now', href: paymentLink }] : []),
    { label: 'View / Download Invoice', href: pdfUrl },
  ]

  const bodyInner = [
    buildEmailParagraph(`${escapeHtml(clientName)},`, { marginBottom: 4, bold: true }),
    buildEmailParagraph(
      `${escapeHtml(title || 'Your invoice is now available.')}${dueDate ? ` Due date ${escapeHtml(dueDate)}.` : ''}`,
      { marginBottom: 18 }
    ),
    message
      ? buildEmailParagraph(escapeHtml(message).replace(/\n/g, '<br />'), { marginBottom: 18, fontSize: 14 })
      : '',
    buildEmailDetailsCard({
      title: 'Invoice Details',
      rows: [
        { label: 'Invoice', value: invoiceNumber },
        { label: 'Balance', value: `$${balance}` },
      ],
      featuredLabel: 'Total Amount',
      featuredValue: `$${total}`,
    }),
    buildEmailButtonGroup(buttons),
    buildEmailSupportNote(
      'Questions about this invoice? <strong style="color:#ffffff;">Reply to this email</strong>.'
    ),
  ].join('')

  return buildEmailShell({
    title: `Invoice ${invoiceNumber}`,
    preheader: `Invoice ${invoiceNumber} — ${total} due.`,
    headerHtml: buildEmailHeaderBlock({ logoUrl, companyName, eyebrow: 'Invoice Delivery' }),
    bodyHtml: [
      buildEmailHeroBlock({
        badge: 'Invoice Ready',
        headline: 'Your Invoice Is Ready',
        meta: `Invoice ${escapeHtml(invoiceNumber)} &bull; ${escapeHtml(sentDisplay)}`,
      }),
      buildEmailBodySection(bodyInner),
    ].join(''),
    footerHtml: buildEmailFooterBlock({
      companyName,
      lines: [`Invoice ${escapeHtml(invoiceNumber)} sent to ${escapeHtml(clientName)}.`],
    }),
  })
}
