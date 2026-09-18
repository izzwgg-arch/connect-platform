import { colors } from '../theme/tokens'

const explicitApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim()
const PROD_FALLBACK_URL = 'https://app.trimprony.com'
const DEV_FALLBACK_URL = 'http://10.0.2.2:3000'

const isLocalOrIpHost = (hostname: string): boolean => {
  const host = String(hostname || '').toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host === '127.0.0.1') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  if (host.startsWith('10.')) return true
  if (host.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true
  return false
}

const resolveApiBaseUrl = (): string => {
  if (__DEV__) {
    return (explicitApiUrl || DEV_FALLBACK_URL).replace(/\/+$/, '')
  }
  if (!explicitApiUrl) return PROD_FALLBACK_URL
  try {
    const parsed = new URL(explicitApiUrl)
    if (isLocalOrIpHost(parsed.hostname)) return PROD_FALLBACK_URL
    // In production, enforce HTTPS and remove custom ports to avoid bad/misconfigured endpoints.
    return `https://${parsed.hostname}`.replace(/\/+$/, '')
  } catch {
    return PROD_FALLBACK_URL
  }
}

export const API_BASE_URL = resolveApiBaseUrl()

export const BRAND = {
  primary: colors.brandPrimary,
  accent: '#E6C98B',
  bg: colors.background,
  white: colors.surface,
  text: colors.textPrimary,
  muted: colors.textSecondary,
}

