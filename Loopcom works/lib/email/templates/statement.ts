import {
  buildEmailBodySection,
  buildEmailButtonGroup,
  buildEmailFooterBlock,
  buildEmailHeaderBlock,
  buildEmailHeroBlock,
  buildEmailParagraph,
  buildEmailShell,
  escapeHtml,
} from '@/lib/email/shell'

export interface StatementEmailOptions {
  clientName: string
  recipientEmail: string
  openCount: number
  totalOutstanding: string
  viewUrl: string
  hasPdf?: boolean
  companyName?: string
}

export function buildStatementEmail(opts: StatementEmailOptions): string {
  const {
    clientName,
    recipientEmail,
    openCount,
    totalOutstanding,
    viewUrl,
    hasPdf,
    companyName = 'TrimPro',
  } = opts

  const bodyInner = [
    buildEmailParagraph(`Hi ${escapeHtml(clientName)},`, { marginBottom: 10, bold: true }),
    `<p class="tp-body-text" style="margin:0 0 22px;font-size:15px;line-height:24px;color:#d5e1f1;mso-line-height-rule:exactly;">Please find your account statement${
      hasPdf ? ' <strong style="color:#f0c974;">attached as a PDF</strong>' : ''
    }. You currently have <strong style="color:#f0c974;">${openCount} open invoice${
      openCount !== 1 ? 's' : ''
    }</strong> with a total outstanding balance of <strong style="color:#f0c974;">${escapeHtml(totalOutstanding)}</strong>.</p>`,
    buildEmailButtonGroup([{ label: 'View Statement', href: viewUrl }]),
    buildEmailParagraph(
      'If you have any questions about your account or would like to arrange payment, please contact us.',
      { marginBottom: 0, fontSize: 13 }
    ),
  ].join('')

  return buildEmailShell({
    title: 'Account Statement',
    preheader: `Account statement — ${totalOutstanding} outstanding.`,
    headerHtml: buildEmailHeaderBlock({ companyName, eyebrow: 'Account Statement' }),
    bodyHtml: [
      buildEmailHeroBlock({
        headline: 'Your balance with us',
        meta: escapeHtml(clientName),
      }),
      buildEmailBodySection(bodyInner),
    ].join(''),
    footerHtml: buildEmailFooterBlock({
      companyName,
      lines: [
        `This statement was sent to ${escapeHtml(recipientEmail)}. If you received this in error, please disregard.`,
      ],
    }),
  })
}
