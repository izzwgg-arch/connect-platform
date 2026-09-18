/**
 * Outlook-safe email layout primitives.
 * Table-based structure, inline CSS, no flex/grid/div spacers.
 */

export const EMAIL_WIDTH = 600
export const EMAIL_OUTER_BG = '#0f172a'
export const EMAIL_CARD_BG = '#243f53'
export const EMAIL_ACCENT = '#f8dea4'
export const EMAIL_BUTTON_BG = '#f0c974'
export const EMAIL_BUTTON_TEXT = '#1e2937'

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const TABLE_RESET =
  'border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;'

export interface EmailShellOptions {
  title: string
  preheader?: string
  headerHtml: string
  bodyHtml: string
  footerHtml?: string
  lockColors?: boolean
}

/** Full document wrapper — centered 600px card on dark background. */
export function buildEmailShell(opts: EmailShellOptions): string {
  const lockAttr = opts.lockColors !== false ? ' data-tp-lock-colors="1"' : ''
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_OUTER_BG};opacity:0;">${escapeHtml(opts.preheader)}</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"${lockAttr}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${escapeHtml(opts.title)}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style type="text/css">
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; display:block; }
    @media only screen and (max-width:620px) {
      .tp-email-container { width:100% !important; max-width:100% !important; }
      .tp-pad-body { padding:22px 18px !important; }
      .tp-pad-hero { padding:24px 18px 18px !important; }
      .tp-pad-header { padding:26px 18px 20px !important; }
      .tp-pad-footer { padding:18px 18px 20px !important; }
      .tp-headline { font-size:24px !important; line-height:30px !important; }
      .tp-btn-full { display:block !important; width:100% !important; }
    }
    @media (prefers-color-scheme: light) {
      .tp-email-body { background-color:#f8f9fc !important; }
      .tp-email-card { background-color:#ffffff !important; }
      .tp-headline { color:#1f2937 !important; }
      .tp-hero-meta { color:#475569 !important; }
      .tp-body-text { color:#1f2937 !important; }
      .tp-foot-copy { color:#475569 !important; }
    }
  </style>
</head>
<body class="tp-email-body" style="margin:0;padding:0;width:100%;background-color:${EMAIL_OUTER_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  ${preheader}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${TABLE_RESET}background-color:${EMAIL_OUTER_BG};">
    <tr>
      <td align="center" valign="top" style="padding:20px 12px 28px;">
        <table role="presentation" class="tp-email-container tp-email-card" cellpadding="0" cellspacing="0" border="0" width="${EMAIL_WIDTH}" style="${TABLE_RESET}width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;background-color:${EMAIL_CARD_BG};">
          ${opts.headerHtml}
          ${opts.bodyHtml}
          ${opts.footerHtml || ''}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function buildEmailHeaderBlock(opts: {
  logoUrl?: string | null
  companyName?: string
  eyebrow?: string
}): string {
  const company = escapeHtml(opts.companyName || 'TrimPro')
  const eyebrow = opts.eyebrow
    ? `<p style="margin:8px 0 0;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#f5e3aa;line-height:16px;">${escapeHtml(opts.eyebrow)}</p>`
    : ''

  const logo = opts.logoUrl
    ? `<img src="${escapeHtml(opts.logoUrl)}" alt="${company}" width="200" height="72" style="display:block;margin:0 auto 8px;max-width:220px;width:auto;height:auto;border:0;" />`
    : `<p style="margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-0.3px;color:${EMAIL_ACCENT};line-height:28px;">${company}</p>`

  return `<tr>
    <td class="tp-pad-header" align="center" valign="top" style="padding:30px 32px 22px;background-color:${EMAIL_CARD_BG};border-bottom:1px solid #3d5a73;text-align:center;">
      ${logo}
      ${eyebrow}
    </td>
  </tr>`
}

export function buildEmailHeroBlock(opts: {
  badge?: string
  headline: string
  meta?: string
}): string {
  const badge = opts.badge
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="${TABLE_RESET}margin:0 auto 14px;">
        <tr>
          <td align="center" bgcolor="#334155" style="background-color:#334155;border:1px solid ${EMAIL_ACCENT};padding:5px 16px;font-size:12px;font-weight:700;letter-spacing:0.3px;color:#ffffff;line-height:18px;mso-line-height-rule:exactly;">
            ${escapeHtml(opts.badge)}
          </td>
        </tr>
      </table>`
    : ''

  const meta = opts.meta
    ? `<p class="tp-hero-meta" style="margin:0;font-size:13px;font-weight:600;color:#c4d5e9;line-height:20px;mso-line-height-rule:exactly;">${opts.meta}</p>`
    : ''

  return `<tr>
    <td class="tp-pad-hero" align="center" valign="top" style="padding:26px 32px 20px;border-bottom:1px solid #3d5a73;text-align:center;">
      ${badge}
      <p class="tp-headline" style="margin:0 0 8px;font-size:28px;font-weight:800;line-height:34px;letter-spacing:-0.4px;color:${EMAIL_ACCENT};mso-line-height-rule:exactly;">${escapeHtml(opts.headline)}</p>
      ${meta}
    </td>
  </tr>`
}

export function buildEmailBodySection(innerHtml: string): string {
  return `<tr>
    <td class="tp-pad-body" valign="top" style="padding:24px 32px;background-color:${EMAIL_CARD_BG};">
      ${innerHtml}
    </td>
  </tr>`
}

export function buildEmailParagraph(
  html: string,
  opts?: { marginBottom?: number; fontSize?: number; bold?: boolean }
): string {
  const mb = opts?.marginBottom ?? 16
  const fs = opts?.fontSize ?? 15
  const weight = opts?.bold ? 'font-weight:600;' : ''
  return `<p class="tp-body-text" style="margin:0 0 ${mb}px;font-size:${fs}px;line-height:24px;color:#d5e1f1;mso-line-height-rule:exactly;${weight}">${html}</p>`
}

export function buildEmailDetailsCard(opts: {
  title: string
  rows: Array<{ label: string; value: string }>
  featuredLabel?: string
  featuredValue?: string
}): string {
  const divider = `<tr><td colspan="2" style="border-top:1px solid #46627f;font-size:0;line-height:0;mso-line-height-rule:exactly;height:0;padding:0;">&nbsp;</td></tr>`

  const detailRows = opts.rows
    .map(
      (row, i) => `${i > 0 ? divider : ''}
      <tr>
        <td width="44%" valign="top" style="padding:10px 0 10px;font-size:13px;color:#c2d1e3;font-weight:600;line-height:20px;mso-line-height-rule:exactly;">${escapeHtml(row.label)}</td>
        <td align="right" valign="top" style="padding:10px 0 10px;font-size:13px;color:#eff6ff;font-weight:700;line-height:20px;mso-line-height-rule:exactly;">${escapeHtml(row.value)}</td>
      </tr>`
    )
    .join('')

  const featured =
    opts.featuredLabel && opts.featuredValue
      ? `${divider}
      <tr>
        <td colspan="2" bgcolor="#30495f" style="background-color:#30495f;padding:14px 0 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${TABLE_RESET}">
            <tr>
              <td valign="middle" style="font-size:11px;color:#cdd9e8;font-weight:700;letter-spacing:1px;text-transform:uppercase;line-height:16px;mso-line-height-rule:exactly;">${escapeHtml(opts.featuredLabel)}</td>
              <td align="right" valign="middle" style="font-size:32px;font-weight:800;color:#ffffff;line-height:38px;mso-line-height-rule:exactly;letter-spacing:-1px;">${escapeHtml(opts.featuredValue)}</td>
            </tr>
          </table>
        </td>
      </tr>`
      : ''

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${TABLE_RESET}background-color:#1e3345;border:1px solid #46627f;margin-bottom:20px;">
    <tr>
      <td colspan="2" style="padding:10px 16px;border-bottom:1px solid #46627f;background-color:#1e3345;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#c2d1e3;line-height:14px;mso-line-height-rule:exactly;">${escapeHtml(opts.title)}</p>
      </td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 16px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${TABLE_RESET}">
          ${detailRows}
          ${featured}
        </table>
      </td>
    </tr>
  </table>`
}

export function buildEmailAlertBanner(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${TABLE_RESET}background-color:#2f475f;border:1px solid #9f7a2f;margin-bottom:18px;">
    <tr>
      <td align="center" style="padding:10px 14px;font-size:13px;font-weight:700;color:#ffd27a;line-height:20px;mso-line-height-rule:exactly;">${escapeHtml(text)}</td>
    </tr>
  </table>`
}

export interface EmailButtonSpec {
  label: string
  href: string
}

/** Bulletproof CTA — solid bgcolor for Outlook; stacked on narrow screens via full-width tables. */
export function buildEmailButtonGroup(buttons: EmailButtonSpec[]): string {
  if (!buttons.length) return ''

  const cells = buttons
    .map(
      (btn) => `<tr>
        <td align="center" class="tp-btn-full" style="padding:0 0 10px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="${TABLE_RESET}">
            <tr>
              <td align="center" bgcolor="${EMAIL_BUTTON_BG}" style="background-color:${EMAIL_BUTTON_BG};border-radius:10px;mso-padding-alt:0;">
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${escapeHtml(btn.href)}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="12%" strokecolor="${EMAIL_BUTTON_BG}" fillcolor="${EMAIL_BUTTON_BG}">
                  <w:anchorlock/>
                  <center style="color:${EMAIL_BUTTON_TEXT};font-family:Segoe UI, Arial, sans-serif;font-size:16px;font-weight:700;">${escapeHtml(btn.label)}</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-->
                <a href="${escapeHtml(btn.href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 36px;font-size:16px;font-weight:700;line-height:20px;text-decoration:none;text-align:center;color:${EMAIL_BUTTON_TEXT};background-color:${EMAIL_BUTTON_BG};border-radius:10px;mso-line-height-rule:exactly;">${escapeHtml(btn.label)}</a>
                <!--<![endif]-->
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    )
    .join('')

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${TABLE_RESET}margin-bottom:18px;">
    ${cells}
  </table>`
}

export function buildEmailSupportNote(html: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${TABLE_RESET}background-color:#263f56;border:1px solid #46627f;">
    <tr>
      <td align="center" style="padding:12px 16px;">
        <p style="margin:0;font-size:13px;line-height:20px;color:#d6e3f2;mso-line-height-rule:exactly;">${html}</p>
      </td>
    </tr>
  </table>`
}

export function buildEmailFooterBlock(opts: {
  companyName: string
  lines: string[]
  supportEmail?: string
}): string {
  const support = opts.supportEmail
    ? `<p style="margin:0 0 8px;font-size:12px;line-height:18px;mso-line-height-rule:exactly;"><a href="mailto:${escapeHtml(opts.supportEmail)}" style="color:#9eb3cf;text-decoration:none;">${escapeHtml(opts.supportEmail)}</a></p>`
    : ''

  const lines = opts.lines
    .map(
      (line) =>
        `<p class="tp-foot-copy" style="margin:0 0 4px;font-size:11px;line-height:16px;color:#93a9c2;mso-line-height-rule:exactly;">${line}</p>`
    )
    .join('')

  return `<tr>
    <td class="tp-pad-footer" align="center" valign="top" style="padding:20px 32px 22px;background-color:#223347;border-top:1px solid #46627f;text-align:center;">
      <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:${EMAIL_ACCENT};line-height:18px;mso-line-height-rule:exactly;">${escapeHtml(opts.companyName)}</p>
      ${support}
      ${lines}
    </td>
  </tr>`
}
