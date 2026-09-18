/**
 * Shared branding resolver for server-side PDF and HTML document generation.
 * Reads from the canonical branding store (DB → JSON file fallback).
 * All PDF/estimate/invoice routes must use this instead of env vars or hardcoded values.
 */
import { getBrandingSettingsForTenant } from './settings'
import { embedLogoAsDataUri } from '@/lib/email/embed-logo'

export interface PdfBranding {
  /** Logo URL to embed in the document header — may be an absolute URL or data URI. */
  logoUrl: string
  /** Accent / primary color for header band, buttons, totals row. */
  accentColor: string
  /** Accent contrast text color (text on top of accentColor buttons/bands). */
  accentTextColor: string
  /** Business / company name shown in the header "From" block. */
  businessName: string
  /** Optional phone number. */
  businessPhone: string | null
  /** Optional email address. */
  businessEmail: string | null
  /** Optional mailing address. */
  businessAddress: string | null
  /** Optional footer text printed at the bottom of the document. */
  footerText: string | null
}

const DEFAULT_ACCENT = '#2e4a59'
const DEFAULT_ACCENT_TEXT = '#ffffff'
const DEFAULT_BUSINESS_NAME = 'Trim Pro'

/**
 * Fallback SVG logo data URI — only used when no logo URL is set in branding
 * and no PDF_LOGO_URL env var is configured. Uses dynamic accent color.
 */
function buildDefaultLogoDataUri(accentColor: string, textColor: string): string {
  const bg = accentColor.replace('#', '')
  const txt = textColor.replace('#', '')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360">` +
    `<rect width="1200" height="360" fill="#${bg}"/>` +
    `<g fill="#${txt}" font-family="Inter,Arial,Helvetica,sans-serif">` +
    `<text x="78" y="238" font-size="182" font-weight="700" letter-spacing="1">TrimPro</text>` +
    `</g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * Resolve all PDF branding values for a tenant.
 * Falls back through: branding DB/file → PDF_LOGO_URL env var → generated SVG.
 */
export async function getPdfBranding(tenantId: string): Promise<PdfBranding> {
  const branding = await getBrandingSettingsForTenant(tenantId)

  const accentColor =
    (branding?.primaryColor as string | null) ||
    (branding?.buttonColor as string | null) ||
    process.env.PDF_ACCENT_COLOR ||
    DEFAULT_ACCENT

  const accentTextColor =
    (branding?.buttonTextColor as string | null) ||
    DEFAULT_ACCENT_TEXT

  const rawLogoUrl =
    (branding?.invoiceLogoUrl as string | null) ||
    (branding?.webLogoUrl as string | null) ||
    process.env.PDF_LOGO_URL ||
    process.env.NEXT_PUBLIC_PDF_LOGO_URL ||
    null

  let logoUrl: string
  if (rawLogoUrl) {
    // Normalize: strip /api/public prefix that older uploads may have
    const normalizedUrl = rawLogoUrl.replace(/^\/api\/public(\/uploads\/)/, '$1')
    const embedded = await embedLogoAsDataUri(normalizedUrl)
    // Never emit a non-embedded (relative/unreachable) URL into a PDF — puppeteer
    // renders those as a broken image. Fall back to a branded data-URI logo so
    // every document still shows branding instead of a broken image icon.
    logoUrl = embedded || buildDefaultLogoDataUri(accentColor, accentTextColor)
  } else {
    logoUrl = buildDefaultLogoDataUri(accentColor, accentTextColor)
  }

  return {
    logoUrl,
    accentColor,
    accentTextColor,
    businessName: (branding?.invoiceBusinessName as string | null) || DEFAULT_BUSINESS_NAME,
    businessPhone: (branding?.invoicePhone as string | null) || null,
    businessEmail: (branding?.invoiceEmail as string | null) || null,
    businessAddress: (branding?.invoiceAddress as string | null) || null,
    footerText: (branding?.invoiceFooterText as string | null) || null,
  }
}
