import {
  buildEmailBodySection,
  buildEmailDetailsCard,
  buildEmailFooterBlock,
  buildEmailHeaderBlock,
  buildEmailHeroBlock,
  buildEmailParagraph,
  buildEmailShell,
  buildEmailSupportNote,
  escapeHtml,
} from '@/lib/email/shell'

export interface CreditMemoEmailOptions {
  creditMemoNumber: string
  clientName: string
  total: string
  remaining: string
  message?: string
  logoUrl?: string
  companyName?: string
}

export function buildCreditMemoEmail(opts: CreditMemoEmailOptions): string {
  const {
    creditMemoNumber,
    clientName,
    total,
    remaining,
    message,
    logoUrl,
    companyName = 'TrimPro',
  } = opts

  const bodyInner = [
    buildEmailParagraph(`${escapeHtml(clientName)},`, { marginBottom: 4, bold: true }),
    buildEmailParagraph('A credit memo has been issued to your account.', { marginBottom: 18 }),
    message
      ? buildEmailParagraph(escapeHtml(message).replace(/\n/g, '<br />'), {
          marginBottom: 18,
          fontSize: 14,
        })
      : '',
    buildEmailDetailsCard({
      title: 'Credit Memo Summary',
      rows: [
        { label: 'Credit Memo', value: creditMemoNumber },
        { label: 'Remaining Credit', value: `$${remaining}` },
      ],
      featuredLabel: 'Credit Total',
      featuredValue: `$${total}`,
    }),
    buildEmailSupportNote(
      'Questions about this credit? <strong style="color:#ffffff;">Reply to this email</strong>.'
    ),
  ].join('')

  return buildEmailShell({
    title: `Credit Memo ${creditMemoNumber}`,
    preheader: `Credit memo ${creditMemoNumber} — $${total}.`,
    headerHtml: buildEmailHeaderBlock({ logoUrl, companyName, eyebrow: 'Credit Memo' }),
    bodyHtml: [
      buildEmailHeroBlock({
        badge: 'Credit Issued',
        title: `Credit Memo ${escapeHtml(creditMemoNumber)}`,
        subtitle: `Total credit $${escapeHtml(total)}`,
      }),
      buildEmailBodySection(bodyInner),
    ].join(''),
    footerHtml: buildEmailFooterBlock({
      companyName,
      lines: [`Credit memo ${escapeHtml(creditMemoNumber)} sent to ${escapeHtml(clientName)}.`],
    }),
  })
}
