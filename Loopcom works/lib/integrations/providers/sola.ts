/**
 * Sola Payments Integration
 */

import { IntegrationTestResult } from '../types'

export async function testSola(secrets: Record<string, any>): Promise<IntegrationTestResult> {
  try {
    const secretKey = secrets.secretKey
    const apiSecret = secrets.secret || secrets.apiSecret || undefined
    const mode = secrets.mode || 'production'

    if (!secretKey) {
      return {
        success: false,
        message: 'Sola credentials not configured',
        error: 'Missing secretKey',
      }
    }

    // TrimPro uses Cardknox endpoints for SOLA. There's no guaranteed "ping" endpoint,
    // so we validate credentials by calling an authenticated endpoint with an
    // intentionally invalid payload and checking we do NOT get 401/403.
    const apiBase =
      process.env.SOLA_API_URL ||
      process.env.SOLA_API_BASE_URL ||
      process.env.CARDKNOX_API_BASE_URL ||
      'https://api.cardknox.com/v2'

    const url = `${String(apiBase).replace(/\/+$/, '')}/payment-links`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secretKey}`,
        'X-API-Key': secretKey,
        'X-API-Secret': apiSecret || '',
      },
      body: JSON.stringify({}),
    })

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: 'Sola authentication failed',
        error: 'Invalid SOLA secret key',
      }
    }

    // Any other status means we could reach the API and credentials were accepted,
    // even if payload is rejected (400/422).
    return {
      success: true,
      message: `Sola reachable (${mode}). API responded: ${response.status}`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'Sola test failed',
      error: error.message || 'Unknown error',
    }
  }
}

/**
 * Verify webhook signature from Sola
 */
export function verifySolaWebhookSignature(
  payload: string,
  signature: string,
  webhookSecret: string
): boolean {
  try {
    // Sola webhook signature verification (adjust based on Sola's method)
    // Common methods: HMAC-SHA256, SHA256, etc.
    const crypto = require('crypto')
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex')

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )
  } catch (error) {
    console.error('Sola webhook signature verification failed:', error)
    return false
  }
}
