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

export interface StaffNotificationEmailOptions {
  recipientName?: string | null
  title: string
  message?: string | null
  actionUrl?: string | null
  companyName?: string
  logoUrl?: string | null
}

export function buildStaffNotificationEmail(opts: StaffNotificationEmailOptions): {
  subject: string
  html: string
  text: string
} {
  const companyName = opts.companyName || 'TrimPro'
  const greeting = opts.recipientName?.trim()
    ? `Hi ${escapeHtml(opts.recipientName.trim())},`
    : 'Hi,'
  const message = opts.message?.trim() || 'Open TrimPro to review this update.'
  const actionUrl = opts.actionUrl?.trim() || null

  const bodyParts = [
    buildEmailParagraph(greeting, { marginBottom: 12 }),
    buildEmailParagraph(escapeHtml(message), { marginBottom: 20 }),
  ]

  if (actionUrl) {
    bodyParts.push(
      buildEmailButtonGroup([{ label: 'Open in TrimPro', href: actionUrl }])
    )
  }

  const html = buildEmailShell({
    title: opts.title,
    preheader: opts.message || opts.title,
    headerHtml: buildEmailHeaderBlock({
      logoUrl: opts.logoUrl,
      companyName,
      eyebrow: 'Notification',
    }),
    bodyHtml:
      buildEmailHeroBlock({
        badge: 'TrimPro Alert',
        headline: opts.title,
      }) + buildEmailBodySection(bodyParts.join('')),
    footerHtml: buildEmailFooterBlock({
      companyName,
      lines: ['You received this because notification emails are enabled on your TrimPro account.'],
    }),
  })

  const textLines = [
    opts.recipientName?.trim() ? `Hi ${opts.recipientName.trim()},` : 'Hi,',
    '',
    opts.title,
    message,
  ]
  if (actionUrl) {
    textLines.push('', `Open in TrimPro: ${actionUrl}`)
  }

  return {
    subject: opts.title,
    html,
    text: textLines.join('\n'),
  }
}
