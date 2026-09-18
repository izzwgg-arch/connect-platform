/**
 * VoIP.ms SMS & MMS Integration
 */

import { IntegrationTestResult } from '../types'

const VOIPMS_API_BASE = 'https://voip.ms/api/v1/rest.php'

function normalizeNanpDigits(input: string): string {
  const digits = input.replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
}

function isUnicodeMessage(text: string): boolean {
  // Emoji / non-ASCII should force unicode=1 for VoIP.ms
  return /[^\x00-\x7F]/.test(text)
}

export async function testVoipMsSms(
  secrets: Record<string, any>,
  to: string,
  message: string
): Promise<IntegrationTestResult> {
  try {
    // Trim whitespace from credentials (common issue)
    const username = typeof secrets.username === 'string' ? secrets.username.trim() : secrets.username
    const apiPassword = typeof secrets.apiPassword === 'string' ? secrets.apiPassword.trim() : secrets.apiPassword
    const fromDid = typeof secrets.defaultDid === 'string' ? secrets.defaultDid.trim() : secrets.defaultDid

    if (!username || !apiPassword || !fromDid) {
      return {
        success: false,
        message: 'VoIP.ms credentials not configured',
        error: 'Missing username, apiPassword, or defaultDid',
      }
    }

    // VoIP.ms expects a valid DID on your account.
    // Normalize to 10-digit NANP by stripping leading "1" if present.
    const cleanDid = normalizeNanpDigits(fromDid)

    // Validate DID format (10 digits after normalization)
    if (cleanDid.length !== 10) {
      return {
        success: false,
        message: 'VoIP.ms SMS test failed',
        error: `Invalid DID format. Expected 10 digits (NANP). Got ${cleanDid.length} digits after normalization.`,
      }
    }
    
    const params = new URLSearchParams({
      api_username: username,
      api_password: apiPassword,
      method: 'sendSMS',
      did: cleanDid,
      dst: normalizeNanpDigits(to),
      message,
      unicode: isUnicodeMessage(message) ? '1' : '0',
    })

    const url = `${VOIPMS_API_BASE}?${params.toString()}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      return {
        success: false,
        message: 'VoIP.ms SMS test failed',
        error: `HTTP ${response.status}`,
      }
    }

    const data = await response.json()

    if (data.status === 'success') {
      return {
        success: true,
        message: `Test SMS sent successfully to ${to} via VoIP.ms`,
      }
    } else {
      // Provide more detailed error message
      const errorMsg = data.message || data.error || 'Unknown error from VoIP.ms'
      
      // Provide helpful guidance for common errors
      let helpfulError = errorMsg
      if (errorMsg.includes('Username or Password') || errorMsg.includes('incorrect')) {
        helpfulError = `${errorMsg}. Note: VoIP.ms requires an API Password (not your login password). Get it from: VoIP.ms Dashboard → Settings → API → Generate API Password`
      } else if (errorMsg.includes('DID') || errorMsg.includes('not a valid')) {
        helpfulError = `${errorMsg} (DID used: ${cleanDid})`
      }
      
      return {
        success: false,
        message: 'VoIP.ms SMS test failed',
        error: helpfulError,
      }
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'VoIP.ms SMS test failed',
      error: error.message || 'Unknown error',
    }
  }
}

/**
 * Send SMS via VoIP.ms
 */
export async function sendVoipMsSms(
  secrets: Record<string, any>,
  to: string,
  message: string,
  fromDid?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    // Trim whitespace from credentials (common issue)
    const username = typeof secrets.username === 'string' ? secrets.username.trim() : secrets.username
    const apiPassword = typeof secrets.apiPassword === 'string' ? secrets.apiPassword.trim() : secrets.apiPassword
    const did = fromDid || secrets.defaultDid
    const cleanDidInput = typeof did === 'string' ? did.trim() : did

    if (!username || !apiPassword || !cleanDidInput) {
      throw new Error('VoIP.ms credentials not configured')
    }

    const cleanDid = normalizeNanpDigits(String(cleanDidInput))

    const safeMessage = message ?? ''
    const params = new URLSearchParams({
      api_username: username,
      api_password: apiPassword,
      method: 'sendSMS',
      did: cleanDid,
      dst: normalizeNanpDigits(to),
      message: safeMessage,
      unicode: isUnicodeMessage(safeMessage) ? '1' : '0',
    })

    const url = `${VOIPMS_API_BASE}?${params.toString()}`
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    })

    const data = await response.json()

    if (data.status === 'success') {
      return {
        success: true,
        messageId: data.sms?.id || data.id || undefined,
      }
    } else {
      return {
        success: false,
        error: data.message || data.error || 'Unknown error',
      }
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown error',
    }
  }
}

/**
 * Send MMS via VoIP.ms
 */
export async function sendVoipMsMms(
  secrets: Record<string, any>,
  to: string,
  message: string,
  mediaUrls: string[],
  fromDid?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    // Trim whitespace from credentials (common issue)
    const username = typeof secrets.username === 'string' ? secrets.username.trim() : secrets.username
    const apiPassword = typeof secrets.apiPassword === 'string' ? secrets.apiPassword.trim() : secrets.apiPassword
    const did = fromDid || secrets.defaultDid
    const cleanDidInput = typeof did === 'string' ? did.trim() : did

    if (!username || !apiPassword || !cleanDidInput) {
      throw new Error('VoIP.ms credentials not configured')
    }

    if (!mediaUrls || mediaUrls.length === 0) {
      throw new Error('MMS requires at least one media URL')
    }

    // VoIP.ms often requires a non-empty message body for MMS sends.
    // If user didn't provide text, send a minimal body to avoid recipients seeing "MMS message".
    const safeMessage = message && message.trim() ? message.trim() : '.'

    const cleanDid = normalizeNanpDigits(String(cleanDidInput))
    const cleanDst = normalizeNanpDigits(to)
    // NOTE: Some MMS gateways (and some VoIP.ms backends) fail to fetch HTTPS URLs.
    // We serve /uploads over BOTH HTTP + HTTPS; for VoIP.ms, prefer HTTP for media URLs.
    const urls = (mediaUrls || [])
      .filter(Boolean)
      .map((u) =>
        typeof u === 'string' && u.startsWith('https://app.trimprony.com/')
          ? u.replace('https://', 'http://')
          : u
      )
      .slice(0, 5)

    // Different VoIP.ms accounts/docs use different MMS conventions.
    // Try: (1) sendMMS + media1..media5, then (2) sendSMS + media_url1..media_url5.
    const baseParams = {
      api_username: username,
      api_password: apiPassword,
      did: cleanDid,
      dst: cleanDst,
      message: safeMessage,
      unicode: isUnicodeMessage(safeMessage) ? '1' : '0',
    }

    const attempts: Array<{ label: string; params: URLSearchParams }> = []

    const p1 = new URLSearchParams({ ...baseParams, method: 'sendMMS' })
    urls.forEach((u, i) => p1.append(`media${i + 1}`, u))
    attempts.push({ label: 'sendMMS(media1..)', params: p1 })

    const p2 = new URLSearchParams({ ...baseParams, method: 'sendSMS' })
    urls.forEach((u, i) => p2.append(`media_url${i + 1}`, u))
    attempts.push({ label: 'sendSMS(media_url1..)', params: p2 })

    let lastError: string | undefined
    for (const attempt of attempts) {
      const requestUrl = `${VOIPMS_API_BASE}?${attempt.params.toString()}`

      console.log('VoIP.ms MMS attempt:', {
        attempt: attempt.label,
        did: cleanDid,
        to: cleanDst,
        mediaCount: urls.length,
        hasText: !!(message && message.trim()),
      })
      console.log('VoIP.ms MMS request URL (sanitized):', requestUrl.replace(/api_password=[^&]+/, 'api_password=***'))

      const response = await fetch(requestUrl, { method: 'GET', headers: { Accept: 'application/json' } })
      const responseText = await response.text()

      let data: any = null
      try {
        data = JSON.parse(responseText)
      } catch {
        data = null
      }

      const status = String(data?.status || '').toLowerCase()
      const messageId = data?.sms?.id || data?.id || data?.message_id || undefined
      const errorMsg =
        data?.message ||
        data?.error ||
        (!response.ok ? `HTTP ${response.status}` : `VoIP.ms MMS failed (${attempt.label})`)

      console.log('VoIP.ms MMS response:', {
        attempt: attempt.label,
        httpStatus: response.status,
        status: data?.status,
        message: data?.message,
        smsId: messageId,
        fullResponse: responseText.substring(0, 500),
      })

      if (status === 'success') {
        return { success: true, messageId }
      }

      lastError = errorMsg
    }

    return { success: false, error: lastError || 'VoIP.ms MMS failed' }
  } catch (error: any) {
    console.error('VoIP.ms MMS exception:', error)
    return {
      success: false,
      error: error.message || 'Unknown error',
    }
  }
}
