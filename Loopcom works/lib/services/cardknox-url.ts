/**
 * Cardknox hosted payment form URLs must stay below IIS query-string limits
 * (~2048). URLs around 2177 chars 404 on secure.cardknox.com/trimprony; ~819 works.
 */

export const CARDKNOX_HOSTED_FORM_URL =
  process.env.CARDKNOX_HOSTED_FORM_URL || 'https://secure.cardknox.com/trimprony'

/** Safe max for the full payment URL (path + query). */
export const CARDKNOX_MAX_URL_LENGTH = 1800

/** Threshold for flagging stored URLs that need repair (compact-links, scripts). */
export const CARDKNOX_LONG_URL_THRESHOLD = CARDKNOX_MAX_URL_LENGTH

const ESSENTIAL_PARAM_KEYS = [
  'xInvoice',
  'xAmount',
  'xReturnURL',
  'xRedirectURL',
  'xWebhookURL',
  'xCustom1',
  'xEmail',
  'xName',
] as const

/** Dropped in order when the URL exceeds CARDKNOX_MAX_URL_LENGTH. */
const OPTIONAL_DROP_ORDER = [
  'xDescription',
  'xBillStreet',
  'xBillCity',
  'xBillState',
  'xBillZip',
  'xBillCountry',
  'xBillPhone',
  'xPhone',
  'xAddress',
  'xCity',
  'xState',
  'xZip',
  'xCountry',
] as const

const LEGACY_EMAIL_KEYS = ['xEmail', 'customer_email'] as const

const LEGACY_ADDRESS_FALLBACK: Record<string, string[]> = {
  xBillStreet: ['xBillStreet', 'xAddress'],
  xBillCity: ['xBillCity', 'xCity'],
  xBillState: ['xBillState', 'xState'],
  xBillZip: ['xBillZip', 'xZip'],
  xBillCountry: ['xBillCountry', 'xCountry'],
}

export type CardknoxUrlContext = {
  invoiceId?: string
  invoiceNumber?: string
}

export function primaryCardknoxEmail(email?: string | null): string {
  return (
    String(email || '')
      .split(/[;,]/)
      .map((part) => part.trim())
      .find(Boolean) || ''
  )
}

function isCardknoxHostedFormUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const base = new URL(CARDKNOX_HOSTED_FORM_URL)
    return parsed.origin === base.origin && parsed.pathname === base.pathname
  } catch {
    return false
  }
}

function readParam(source: URLSearchParams, keys: string[]): string {
  for (const key of keys) {
    const value = source.get(key)
    if (value) return value
  }
  return ''
}

/** Rebuild a hosted-form URL using canonical params (no duplicate aliases). */
export function compactCardknoxUrl(sourceUrl: string): string {
  const source = new URL(sourceUrl)
  const target = new URL(CARDKNOX_HOSTED_FORM_URL)

  for (const key of ESSENTIAL_PARAM_KEYS) {
    const value = source.searchParams.get(key)
    if (value) target.searchParams.set(key, value)
  }

  const email = primaryCardknoxEmail(
    readParam(source.searchParams, [...LEGACY_EMAIL_KEYS])
  )
  if (email) target.searchParams.set('xEmail', email)

  for (const key of OPTIONAL_DROP_ORDER) {
    if (key === 'xDescription') {
      const value = source.searchParams.get('xDescription')
      if (value) target.searchParams.set(key, value)
      continue
    }
    const fallbacks = LEGACY_ADDRESS_FALLBACK[key]
    const value = fallbacks ? readParam(source.searchParams, fallbacks) : source.searchParams.get(key)
    if (value) target.searchParams.set(key, value)
  }

  return target.toString()
}

function truncateDescription(url: URL, maxUrlLength: number): boolean {
  const description = url.searchParams.get('xDescription')
  if (!description) return false

  let truncated = description
  while (truncated.length > 0) {
    url.searchParams.set('xDescription', truncated)
    if (url.toString().length <= maxUrlLength) {
      return truncated.length < description.length
    }
    truncated = truncated.slice(0, Math.max(0, truncated.length - 32))
  }

  url.searchParams.delete('xDescription')
  return true
}

/**
 * Progressively drop optional prefill params, then truncate xDescription.
 * Throws if essential params cannot fit within the limit (fail closed).
 */
export function enforceCardknoxUrlLength(
  inputUrl: string,
  context: CardknoxUrlContext = {}
): string {
  if (!isCardknoxHostedFormUrl(inputUrl)) {
    if (inputUrl.length > CARDKNOX_MAX_URL_LENGTH) {
      throw new Error(
        `Payment URL exceeds ${CARDKNOX_MAX_URL_LENGTH} characters (${inputUrl.length}). ` +
          `Invoice ${context.invoiceNumber || context.invoiceId || 'unknown'}.`
      )
    }
    return inputUrl
  }

  const beforeLength = inputUrl.length
  let url = new URL(compactCardknoxUrl(inputUrl))
  let compacted = beforeLength > url.toString().length
  const dropped: string[] = []

  if (url.toString().length <= CARDKNOX_MAX_URL_LENGTH) {
    if (compacted || beforeLength !== url.toString().length) {
      logCardknoxUrlAdjustment(context, beforeLength, url.toString().length, {
        action: compacted ? 'compacted' : 'normalized',
        dropped,
      })
    }
    return url.toString()
  }

  for (const key of OPTIONAL_DROP_ORDER) {
    if (!url.searchParams.has(key)) continue
    url.searchParams.delete(key)
    dropped.push(key)
    if (url.toString().length <= CARDKNOX_MAX_URL_LENGTH) {
      logCardknoxUrlAdjustment(context, beforeLength, url.toString().length, {
        action: 'dropped optional params',
        dropped,
      })
      return url.toString()
    }
  }

  if (truncateDescription(url, CARDKNOX_MAX_URL_LENGTH)) {
    logCardknoxUrlAdjustment(context, beforeLength, url.toString().length, {
      action: 'truncated xDescription',
      dropped,
    })
    return url.toString()
  }

  const afterLength = url.toString().length
  throw new Error(
    `Cardknox payment URL cannot be reduced below ${CARDKNOX_MAX_URL_LENGTH} characters ` +
      `(still ${afterLength} after removing optional fields). ` +
      `Invoice ${context.invoiceNumber || context.invoiceId || 'unknown'}. ` +
      'Essential payment params (amount, invoice, return/webhook URLs) are too long.'
  )
}

function logCardknoxUrlAdjustment(
  context: CardknoxUrlContext,
  beforeLength: number,
  afterLength: number,
  detail: { action: string; dropped: string[] }
) {
  const label = context.invoiceNumber || context.invoiceId || 'unknown'
  console.warn(
    `[Cardknox URL] ${detail.action} for invoice ${label}: ${beforeLength} -> ${afterLength} chars` +
      (detail.dropped.length ? ` (dropped: ${detail.dropped.join(', ')})` : '')
  )
}

/** Validate any payment URL before persisting solaPaymentUrl. */
export function validatePaymentUrlForStorage(
  url: string,
  context: CardknoxUrlContext = {}
): string {
  if (!url) {
    throw new Error('Payment URL is empty')
  }
  return enforceCardknoxUrlLength(url, context)
}

export type CardknoxFallbackParams = {
  invoiceRef: string
  amountStr: string
  description?: string
  intentRef?: string
  clientName?: string
  clientEmail?: string
  clientPhone?: string
  billingStreet?: string
  billingCity?: string
  billingState?: string
  billingZip?: string
  billingCountry?: string
  returnUrl?: string
  webhookUrl?: string
}

export function buildCardknoxFallbackUrl(
  params: CardknoxFallbackParams,
  context: CardknoxUrlContext = {}
): string {
  const url = new URL(CARDKNOX_HOSTED_FORM_URL)
  const email = primaryCardknoxEmail(params.clientEmail)

  url.searchParams.set('xInvoice', params.invoiceRef)
  url.searchParams.set('xAmount', params.amountStr)
  if (params.intentRef) url.searchParams.set('xCustom1', params.intentRef)
  if (params.clientName) url.searchParams.set('xName', params.clientName)
  if (email) url.searchParams.set('xEmail', email)

  const optionalEntries: Array<[string, string | undefined]> = [
    ['xDescription', params.description || ''],
    ['xPhone', params.clientPhone || ''],
    ['xBillStreet', params.billingStreet || ''],
    ['xBillCity', params.billingCity || ''],
    ['xBillState', params.billingState || ''],
    ['xBillZip', params.billingZip || ''],
    ['xBillCountry', params.billingCountry || ''],
  ]

  for (const [key, value] of optionalEntries) {
    if (value) url.searchParams.set(key, value)
  }

  if (params.returnUrl) {
    url.searchParams.set('xReturnURL', params.returnUrl)
    url.searchParams.set('xRedirectURL', params.returnUrl)
  }
  if (params.webhookUrl) {
    url.searchParams.set('xWebhookURL', params.webhookUrl)
  }

  return enforceCardknoxUrlLength(url.toString(), context)
}
