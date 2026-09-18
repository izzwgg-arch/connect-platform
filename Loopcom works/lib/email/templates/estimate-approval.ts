import {
  buildEmailAlertBanner,
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

export interface EstimateApprovalEmailOptions {
  recipientName: string
  customerName: string
  estimateNumber: string
  total: string
  sentDisplay: string
  approveUrl: string
  viewUrl: string
  message?: string
  validUntil?: string
  logoUrl?: string
  companyName?: string
  supportEmail?: string
  primaryColor?: string
  accentColor?: string
}

export function buildEstimateApprovalEmail(opts: EstimateApprovalEmailOptions): string {
  const {
    recipientName,
    customerName,
    estimateNumber,
    total,
    sentDisplay,
    approveUrl,
    viewUrl,
    message,
    validUntil,
    logoUrl,
    companyName = 'TrimPro',
    supportEmail = 'support@trimpro.app',
  } = opts

  const bodyInner = [
    buildEmailParagraph(`Hi ${escapeHtml(recipientName)},`, { marginBottom: 4, bold: true }),
    buildEmailParagraph(
      `Please review the estimate prepared for <strong style="color:#e2e8f0;">${escapeHtml(customerName)}</strong> (${escapeHtml(estimateNumber)}). Once approved, we&rsquo;ll get started right away.`,
      { marginBottom: 20 }
    ),
    message
      ? buildEmailParagraph(escapeHtml(message).replace(/\n/g, '<br />'), { marginBottom: 18, fontSize: 14 })
      : '',
    validUntil ? buildEmailAlertBanner(`This estimate expires on ${escapeHtml(validUntil)}`) : '',
    buildEmailDetailsCard({
      title: 'Estimate Details',
      rows: [
        { label: 'Estimate ID', value: estimateNumber },
        { label: 'Customer', value: customerName },
        { label: 'Prepared for', value: recipientName },
        { label: 'Date', value: sentDisplay },
      ],
      featuredLabel: 'Total Amount',
      featuredValue: total,
    }),
    buildEmailButtonGroup([
      { label: 'Approve Estimate', href: approveUrl },
      { label: 'View Estimate', href: viewUrl },
    ]),
    buildEmailSupportNote(
      'Questions or need changes? <strong style="color:#ffffff;">Just reply to this email</strong> &mdash; we&rsquo;re happy to assist.'
    ),
  ].join('')

  return buildEmailShell({
    title: `Estimate ${estimateNumber} — ${companyName}`,
    preheader: `${estimateNumber} • ${total} ready for review.`,
    headerHtml: buildEmailHeaderBlock({
      logoUrl,
      companyName,
      eyebrow: 'Estimate Approval',
    }),
    bodyHtml: [
      buildEmailHeroBlock({
        badge: 'Awaiting Your Approval',
        headline: 'Review Your Estimate',
        meta: `Estimate <strong style="color:#e7f1ff;">${escapeHtml(estimateNumber)}</strong> &bull; ${escapeHtml(sentDisplay)}`,
      }),
      buildEmailBodySection(bodyInner),
    ].join(''),
    footerHtml: buildEmailFooterBlock({
      companyName,
      supportEmail,
      lines: [
        `Estimate ${escapeHtml(estimateNumber)} &bull; Sent to ${escapeHtml(customerName)}`,
      ],
    }),
  })
}
