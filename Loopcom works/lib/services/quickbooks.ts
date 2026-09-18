// QuickBooks Online API Integration
// OAuth 2.0 with refresh token support

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || 'http://localhost:3000/api/qbo/callback'
const QBO_BASE_URL = 'https://appcenter.intuit.com/connect/oauth2'
// Intuit token endpoint (OAuth 2.0) — this is the recommended host for bearer token exchanges.
// Using appcenter for token exchange may return HTML "shell" responses in some environments.
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const QBO_ENV = String(process.env.QBO_ENV || 'production').toLowerCase()
// Default to production unless explicitly set to sandbox.
const QBO_API_BASE =
  QBO_ENV === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com'

interface QBOAccessTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  realmId: string
}

interface QBOCompanyInfo {
  CompanyName: string
  CompanyAddr: any
  LegalAddr: any
  SupportedLanguages: string
}

export type QuickBooksRequestContext = {
  tenantId?: string | null
  entityType?: string | null
  entityId?: string | null
  triggerSource?: string | null
  retryCount?: number | null
}

export type QuickBooksReferenceField =
  | 'CustomerRef'
  | 'ItemRef'
  | 'AccountRef'
  | 'VendorRef'
  | 'EmployeeRef'
  | 'TaxCodeRef'
  | 'ClassRef'
  | 'DepartmentRef'
  | 'PaymentTermRef'

export type QuickBooksFaultReference = {
  field: QuickBooksReferenceField
  value?: string | null
  name?: string | null
  source: 'fault_element' | 'fault_text'
}

export type QuickBooksFaultEntry = {
  code: string | null
  type: string | null
  message: string | null
  detail: string | null
  element: string | null
  references: QuickBooksFaultReference[]
}

type QuickBooksUsageLog = {
  tenantId: string | null
  realmId: string | null
  endpoint: string
  method: string
  entityType: string | null
  entityId: string | null
  triggerSource: string | null
  httpStatus: number | null
  success: boolean
  retryCount: number | null
  durationMs: number
  timestamp: string
  intuitTid: string | null
}

function shouldLogQuickBooksUsage(): boolean {
  return String(process.env.QBO_METERING_MODE || 'log').toLowerCase() !== 'off'
}

export function logQuickBooksApiUsage(entry: QuickBooksUsageLog) {
  if (!shouldLogQuickBooksUsage()) return
  console.info(
    JSON.stringify({
      area: 'qbo_api_usage',
      ...entry,
    })
  )
}

const KNOWN_REF_FIELDS: QuickBooksReferenceField[] = [
  'CustomerRef',
  'ItemRef',
  'AccountRef',
  'VendorRef',
  'EmployeeRef',
  'TaxCodeRef',
  'ClassRef',
  'DepartmentRef',
  'PaymentTermRef',
]

function normalizeFieldName(field: string | null | undefined): QuickBooksReferenceField | null {
  const clean = String(field || '').trim()
  if (!clean) return null
  const found = KNOWN_REF_FIELDS.find((name) => name.toLowerCase() === clean.toLowerCase())
  return found || null
}

function extractRefFieldFromText(text: string): QuickBooksReferenceField | null {
  const lower = String(text || '').toLowerCase()
  for (const field of KNOWN_REF_FIELDS) {
    if (lower.includes(field.toLowerCase())) return field
  }
  return null
}

function extractReferencesFromFaultText(text: string): QuickBooksFaultReference[] {
  const refs: QuickBooksFaultReference[] = []
  const seen = new Set<string>()
  const sourceText = String(text || '')
  for (const field of KNOWN_REF_FIELDS) {
    const regex = new RegExp(`${field}\\s*(?:[:=]\\s*|\\s+)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))`, 'gi')
    let match: RegExpExecArray | null = regex.exec(sourceText)
    while (match) {
      const value = String(match[1] || match[2] || match[3] || '').trim() || null
      const key = `${field}|${value || ''}`
      if (!seen.has(key)) {
        seen.add(key)
        refs.push({ field, value, source: 'fault_text' })
      }
      match = regex.exec(sourceText)
    }
  }
  return refs
}

function parseFaultEntries(payload: any): QuickBooksFaultEntry[] {
  const fault = payload?.fault || payload?.Fault
  const errors = fault?.error || fault?.Error
  const errorList = Array.isArray(errors) ? errors : errors ? [errors] : []
  const type = String(fault?.type || fault?.Type || '').trim() || null
  return errorList.map((entry: any) => {
    const code = String(entry?.code || entry?.Code || '').trim() || null
    const message = String(entry?.Message || entry?.message || '').trim() || null
    const detail = String(entry?.Detail || entry?.detail || '').trim() || null
    const element = String(entry?.element || entry?.Element || '').trim() || null

    const references: QuickBooksFaultReference[] = []
    const normalizedElement = normalizeFieldName(element)
    if (normalizedElement) {
      references.push({ field: normalizedElement, source: 'fault_element' })
    } else {
      const inferred = extractRefFieldFromText(`${message || ''} ${detail || ''}`.trim())
      if (inferred) references.push({ field: inferred, source: 'fault_text' })
    }
    for (const ref of extractReferencesFromFaultText(`${message || ''} ${detail || ''}`.trim())) {
      references.push(ref)
    }

    return { code, type, message, detail, element, references }
  })
}

export class QuickBooksApiError extends Error {
  status: number
  intuitTid: string | null
  payload: any
  faults: QuickBooksFaultEntry[]

  constructor(params: { status: number; intuitTid: string | null; payload: any; fallbackMessage: string }) {
    const faults = parseFaultEntries(params.payload)
    const firstFault = faults[0]
    const summaryParts = [
      firstFault?.detail,
      firstFault?.message,
      firstFault?.code ? `code=${firstFault.code}` : null,
      firstFault?.type ? `type=${firstFault.type}` : null,
    ].filter(Boolean)
    const msgBase = summaryParts.length
      ? summaryParts.join(' | ')
      : String(params.fallbackMessage || 'QuickBooks API error')
    const withStatus = `${msgBase} (status=${params.status})`
    super(params.intuitTid ? `${withStatus} (intuit_tid: ${params.intuitTid})` : withStatus)
    this.name = 'QuickBooksApiError'
    this.status = params.status
    this.intuitTid = params.intuitTid
    this.payload = params.payload
    this.faults = faults
  }

  hasFaultCode(code: string): boolean {
    return this.faults.some((fault) => String(fault.code || '') === String(code))
  }

  isValidationFault(): boolean {
    return this.faults.some((fault) => String(fault.type || '').toLowerCase() === 'validationfault')
  }
}

export class QuickBooksService {
  private extractIntuitTid(headers: Headers): string | null {
    // Intuit returns a trace id header used by their support team.
    // Header names are case-insensitive, but in practice they show as `intuit_tid`.
    return (
      headers.get('intuit_tid') ||
      headers.get('intuit-tid') ||
      headers.get('x-intuit-tid') ||
      null
    )
  }

  private logIntuitTid(intuitTid: string | null, details: { method: string; url: string; status?: number }) {
    if (!intuitTid) return
    // Avoid noisy logs unless explicitly enabled.
    if (process.env.QBO_LOG_INTUIT_TID !== '1') return
    const statusPart = typeof details.status === 'number' ? ` status=${details.status}` : ''
    console.info(`[QBO] intuit_tid=${intuitTid} ${details.method} ${details.url}${statusPart}`)
  }

  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: QBO_CLIENT_ID || '',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: QBO_REDIRECT_URI,
      response_type: 'code',
      access_type: 'offline',
      state: state || '',
    })

    return `${QBO_BASE_URL}?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string): Promise<QBOAccessTokenResponse> {
    const startedAt = Date.now()
    const response = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: QBO_REDIRECT_URI,
      }),
    })

    const intuitTid = this.extractIntuitTid(response.headers)
    this.logIntuitTid(intuitTid, { method: 'POST', url: `${QBO_BASE_URL}/v1/tokens/bearer`, status: response.status })
    logQuickBooksApiUsage({
      tenantId: null,
      realmId: null,
      endpoint: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      entityType: 'oauth_token',
      entityId: null,
      triggerSource: 'oauth_code_exchange',
      httpStatus: response.status,
      success: response.ok,
      retryCount: null,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      intuitTid,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }))
      const msg = error.error_description || error.message || 'Failed to exchange code for tokens'
      throw new Error(intuitTid ? `${msg} (intuit_tid: ${intuitTid})` : msg)
    }

    return response.json()
  }

  async refreshAccessToken(
    refreshToken: string,
    clientId?: string,
    clientSecret?: string,
    context?: QuickBooksRequestContext
  ): Promise<Omit<QBOAccessTokenResponse, 'realmId'>> {
    // Use provided credentials or fall back to env vars
    const cid = clientId || QBO_CLIENT_ID || ''
    const csecret = clientSecret || QBO_CLIENT_SECRET || ''
    
    if (!cid || !csecret) {
      throw new Error('QuickBooks OAuth credentials missing (clientId/clientSecret required)')
    }

    const startedAt = Date.now()
    const response = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${cid}:${csecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })

    const intuitTid = this.extractIntuitTid(response.headers)
    this.logIntuitTid(intuitTid, { method: 'POST', url: `${QBO_BASE_URL}/v1/tokens/bearer`, status: response.status })
    logQuickBooksApiUsage({
      tenantId: context?.tenantId ?? null,
      realmId: null,
      endpoint: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      entityType: context?.entityType ?? 'oauth_token',
      entityId: context?.entityId ?? null,
      triggerSource: context?.triggerSource ?? 'access_token_refresh',
      httpStatus: response.status,
      success: response.ok,
      retryCount: context?.retryCount ?? null,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      intuitTid,
    })

    if (!response.ok) {
      // Intuit sometimes returns non-JSON (or JSON with different fields). Capture a short snippet for debugging.
      const raw = await response.text().catch(() => '')
      let error: any = null
      try {
        error = raw ? JSON.parse(raw) : {}
      } catch {
        error = { message: raw ? raw.slice(0, 300) : 'Unknown error' }
      }
      const msgBase =
        error?.error_description ||
        error?.message ||
        error?.error ||
        (raw ? String(raw).slice(0, 200) : null) ||
        'Failed to refresh token'
      const msg = `${msgBase} (status=${response.status})`
      throw new Error(intuitTid ? `${msg} (intuit_tid: ${intuitTid})` : msg)
    }

    return response.json()
  }

  private summarizeQboError(payload: any): string {
    // QBO errors commonly come back as { Fault: { Error: [{ Message, Detail, code, element }], type }, time }
    const fault = payload?.fault || payload?.Fault
    const error0 = fault?.error?.[0] || fault?.Error?.[0]
    const detail = error0?.Detail || error0?.detail
    const message = error0?.Message || error0?.message
    const code = error0?.code || error0?.Code
    const type = fault?.type || fault?.Type

    const parts = [detail, message, code ? `code=${code}` : null, type ? `type=${type}` : null].filter(Boolean)
    if (parts.length) return String(parts.join(' | '))

    // Fallback: try top-level error fields
    return String(payload?.message || payload?.Message || 'QuickBooks API error')
  }

  async makeAPIRequest(
    accessToken: string,
    realmId: string,
    endpoint: string,
    method: string = 'GET',
    body?: any,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    const url = `${QBO_API_BASE}/v3/company/${realmId}${endpoint}`
    const startedAt = Date.now()
    
    const headers: HeadersInit = {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    }

    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    const intuitTid = this.extractIntuitTid(response.headers)
    this.logIntuitTid(intuitTid, { method, url, status: response.status })
    logQuickBooksApiUsage({
      tenantId: context?.tenantId ?? null,
      realmId,
      endpoint,
      method,
      entityType: context?.entityType ?? null,
      entityId: context?.entityId ?? null,
      triggerSource: context?.triggerSource ?? null,
      httpStatus: response.status,
      success: response.ok,
      retryCount: context?.retryCount ?? null,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      intuitTid,
    })

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      let errorPayload: any = null
      try {
        errorPayload = raw ? JSON.parse(raw) : {}
      } catch {
        errorPayload = { message: raw ? raw.slice(0, 300) : 'Unknown error' }
      }

      const msgBase = this.summarizeQboError(errorPayload)
      throw new QuickBooksApiError({
        status: response.status,
        intuitTid,
        payload: errorPayload,
        fallbackMessage: msgBase,
      })
    }

    return response.json()
  }

  async getCompanyInfo(
    accessToken: string,
    realmId: string,
    context?: QuickBooksRequestContext
  ): Promise<QBOCompanyInfo> {
    const response = await this.makeAPIRequest(accessToken, realmId, `/companyinfo/${realmId}`, 'GET', undefined, context)
    return response.QueryResponse?.CompanyInfo?.[0] || response.CompanyInfo
  }

  async createCustomer(
    accessToken: string,
    realmId: string,
    customerData: any,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    return this.makeAPIRequest(accessToken, realmId, '/customer', 'POST', customerData, context)
  }

  async updateCustomer(
    accessToken: string,
    realmId: string,
    customerId: string,
    customerData: any,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    return this.makeAPIRequest(accessToken, realmId, `/customer?operation=update`, 'POST', {
      ...customerData,
      Id: customerId,
      SyncToken: customerData.SyncToken || '0',
    }, context)
  }

  async createInvoice(
    accessToken: string,
    realmId: string,
    invoiceData: any,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    return this.makeAPIRequest(accessToken, realmId, '/invoice', 'POST', invoiceData, context)
  }

  async createCreditMemo(
    accessToken: string,
    realmId: string,
    creditMemoData: any,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    return this.makeAPIRequest(accessToken, realmId, '/creditmemo', 'POST', creditMemoData, context)
  }

  async createPayment(
    accessToken: string,
    realmId: string,
    paymentData: any,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    return this.makeAPIRequest(accessToken, realmId, '/payment', 'POST', paymentData, context)
  }

  async createItem(
    accessToken: string,
    realmId: string,
    itemData: any,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    return this.makeAPIRequest(accessToken, realmId, '/item', 'POST', itemData, context)
  }

  async query(
    accessToken: string,
    realmId: string,
    query: string,
    context?: QuickBooksRequestContext
  ): Promise<any> {
    return this.makeAPIRequest(accessToken, realmId, `/query?query=${encodeURIComponent(query)}`, 'GET', undefined, context)
  }
}

export const quickBooksService = new QuickBooksService()
