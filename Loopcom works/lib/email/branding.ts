import { prisma } from '@/lib/prisma'
import { resolveEmailTheme } from '@/lib/branding/theme'
import { sanitizeOptionalHtmlBlock } from '@/lib/branding/sanitize'
import { getBrandingSettingsForTenant } from '@/lib/branding/settings'

function getPublicAppUrl() {
  return (
    String(process.env.NEXT_PUBLIC_APP_URL || '').trim() ||
    String(process.env.APP_URL || '').trim() ||
    'https://app.trimprony.com'
  )
}

export function resolveEmailAssetUrl(rawUrl: string | null | undefined): string | null {
  const value = String(rawUrl || '').trim()
  if (!value) return null
  if (/^(https?:)?\/\//i.test(value)) return value
  if (value.startsWith('data:') || value.startsWith('cid:')) return value

  const appUrl = getPublicAppUrl().replace(/\/$/, '')
  const normalizedPath = value.startsWith('/') ? value : `/${value}`
  return `${appUrl}${normalizedPath}`
}

function stripApiPublicPrefix(url: string | null | undefined): string | null {
  const v = String(url || '').trim()
  if (!v) return null
  return v.replace(/^\/api\/public(\/uploads\/)/, '$1')
}

export async function getEmailBranding(tenantId: string) {
  const model = (prisma as any)?.brandingSettings
  const branding = model && typeof model.findUnique === 'function'
    ? await model.findUnique({ where: { tenantId } })
    : await getBrandingSettingsForTenant(tenantId)
  if (!branding) return null
  return {
    ...branding,
    emailLogoUrl: resolveEmailAssetUrl(stripApiPublicPrefix((branding as any)?.emailLogoUrl)),
    webLogoUrl: resolveEmailAssetUrl(stripApiPublicPrefix((branding as any)?.webLogoUrl)),
  }
}

export function applyEmailBrandingHtml(
  html: string,
  branding: Record<string, any> | null | undefined
): string {
  if (!branding) return html
  const theme = resolveEmailTheme(branding)
  let next = html
  const lockTemplateColors = html.includes('data-tp-lock-colors="1"')

  // Legacy palette replacements (kept for older templates only).
  if (!lockTemplateColors) {
    next = next.replaceAll('#12344d', theme.button)
    next = next.replaceAll('#111827', theme.cardBackground)
    next = next.replaceAll('rgba(255,255,255,0.92)', theme.textPrimary)
    next = next.replaceAll('rgba(255,255,255,0.68)', theme.textSecondary)
    next = next.replaceAll('#ffffff', theme.background)
    next = next.replaceAll('rgba(255,255,255,0.12)', theme.border)
  }

  const logoUrl = resolveEmailAssetUrl(branding.emailLogoUrl) || resolveEmailAssetUrl(branding.webLogoUrl)
  if (logoUrl) {
    const logoImg = `<img src="${logoUrl}" alt="Brand logo" style="max-width:300px;height:auto;display:block;margin-bottom:12px;" />`
    next = next.replace(
      /<td style="padding:28px 28px 24px 28px;">/i,
      `<td style="padding:28px 28px 24px 28px;">${logoImg}`
    )
  }

  const customHeader = sanitizeOptionalHtmlBlock(branding.emailCustomHeaderHTML)
  const customFooter = sanitizeOptionalHtmlBlock(branding.emailCustomFooterHTML)
  if (customHeader) {
    next = next.replace(/<body[^>]*>/i, (match) => `${match}${customHeader}`)
  }
  if (customFooter) {
    next = next.replace(/<\/body>/i, `${customFooter}</body>`)
  }

  if (branding.emailFooterText || branding.emailSignature) {
    const footerText = [branding.emailFooterText, branding.emailSignature].filter(Boolean).join('<br />')
    next = next.replace(
      /<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/i,
      `<div style="padding:16px; font-size:12px; color:${theme.textSecondary};">${footerText}</div></table></td></tr></table></body>`
    )
  }

  return next
}

