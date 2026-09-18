type MaybeString = string | null | undefined

export interface BrandingUiTheme {
  primaryColor: MaybeString
  secondaryColor: MaybeString
  backgroundColor: MaybeString
  sidebarColor: MaybeString
  menuColor: MaybeString
  buttonColor: MaybeString
  buttonTextColor: MaybeString
  textPrimaryColor: MaybeString
  textSecondaryColor: MaybeString
  linkColor: MaybeString
  borderColor: MaybeString
  successColor: MaybeString
  warningColor: MaybeString
  dangerColor: MaybeString
}

export interface BrandingEmailTheme {
  emailPrimaryColor: MaybeString
  emailButtonColor: MaybeString
  emailButtonTextColor: MaybeString
  emailBackgroundColor: MaybeString
  emailCardBackgroundColor: MaybeString
  emailHeaderBackgroundColor: MaybeString
  emailFooterBackgroundColor: MaybeString
  emailTextPrimaryColor: MaybeString
  emailTextSecondaryColor: MaybeString
  emailLinkColor: MaybeString
  emailBorderColor: MaybeString
}

export const defaultEmailTheme = {
  primary: '#12344d',
  button: '#12344d',
  buttonText: '#ffffff',
  background: '#ffffff',
  cardBackground: '#111827',
  headerBackground: '#111827',
  footerBackground: '#111827',
  textPrimary: 'rgba(255,255,255,0.92)',
  textSecondary: 'rgba(255,255,255,0.68)',
  link: '#93c5fd',
  border: 'rgba(255,255,255,0.12)',
}

export function mergeUiTheme(defaults: Record<string, string>, branding: Partial<BrandingUiTheme> | null | undefined) {
  if (!branding) return { ...defaults }
  return {
    ...defaults,
    primaryColor: branding.primaryColor ?? defaults.primaryColor,
    secondaryColor: branding.secondaryColor ?? defaults.secondaryColor,
    backgroundColor: branding.backgroundColor ?? defaults.backgroundColor,
    sidebarColor: branding.sidebarColor ?? defaults.sidebarColor,
    menuColor: branding.menuColor ?? defaults.menuColor,
    buttonColor: branding.buttonColor ?? defaults.buttonColor,
    buttonTextColor: branding.buttonTextColor ?? defaults.buttonTextColor,
    textPrimaryColor: branding.textPrimaryColor ?? defaults.textPrimaryColor,
    textSecondaryColor: branding.textSecondaryColor ?? defaults.textSecondaryColor,
    linkColor: branding.linkColor ?? defaults.linkColor,
    borderColor: branding.borderColor ?? defaults.borderColor,
    successColor: branding.successColor ?? defaults.successColor,
    warningColor: branding.warningColor ?? defaults.warningColor,
    dangerColor: branding.dangerColor ?? defaults.dangerColor,
  }
}

export function resolveEmailTheme(branding: Partial<BrandingEmailTheme> | null | undefined) {
  return {
    ...defaultEmailTheme,
    primary: branding?.emailPrimaryColor ?? defaultEmailTheme.primary,
    button: branding?.emailButtonColor ?? defaultEmailTheme.button,
    buttonText: branding?.emailButtonTextColor ?? defaultEmailTheme.buttonText,
    background: branding?.emailBackgroundColor ?? defaultEmailTheme.background,
    cardBackground: branding?.emailCardBackgroundColor ?? defaultEmailTheme.cardBackground,
    headerBackground: branding?.emailHeaderBackgroundColor ?? defaultEmailTheme.headerBackground,
    footerBackground: branding?.emailFooterBackgroundColor ?? defaultEmailTheme.footerBackground,
    textPrimary: branding?.emailTextPrimaryColor ?? defaultEmailTheme.textPrimary,
    textSecondary: branding?.emailTextSecondaryColor ?? defaultEmailTheme.textSecondary,
    link: branding?.emailLinkColor ?? defaultEmailTheme.link,
    border: branding?.emailBorderColor ?? defaultEmailTheme.border,
  }
}

export function hexToHslCssValue(hex: string): string | null {
  const normalized = hex.replace('#', '').trim()
  if (!(normalized.length === 3 || normalized.length === 6)) return null
  const expanded =
    normalized.length === 3 ? normalized.split('').map((ch) => `${ch}${ch}`).join('') : normalized
  const r = parseInt(expanded.slice(0, 2), 16) / 255
  const g = parseInt(expanded.slice(2, 4), 16) / 255
  const b = parseInt(expanded.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
  }
  const hue = Math.round((h * 60 + 360) % 360)
  const sat = Math.round(s * 100)
  const light = Math.round(l * 100)
  return `${hue} ${sat}% ${light}%`
}

