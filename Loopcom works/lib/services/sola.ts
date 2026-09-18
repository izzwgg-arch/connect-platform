// SOLA/Cardknox Payment API Integration

import {
  buildCardknoxFallbackUrl,
  CARDKNOX_HOSTED_FORM_URL,
  validatePaymentUrlForStorage,
} from '@/lib/services/cardknox-url'

const SOLA_API_BASE =
  process.env.SOLA_API_URL ||
  process.env.SOLA_API_BASE_URL ||
  process.env.CARDKNOX_API_BASE_URL ||
  'https://api.cardknox.com/v2'
const SOLA_API_KEY = process.env.SOLA_API_KEY
const SOLA_API_SECRET = process.env.SOLA_API_SECRET

interface SolaPaymentLinkRequest {
  invoiceId: string
  invoiceNumber?: string
  /** Internal intent key (TPINTENT:xxx) — passed in a hidden field so xInvoice can show human-readable numbers */
  intentRef?: string
  amount: number
  description: string
  clientEmail?: string
  clientName?: string
  clientPhone?: string
  billingStreet?: string
  billingCity?: string
  billingState?: string
  billingZip?: string
  billingCountry?: string
  returnUrl?: string
  webhookUrl?: string
  apiKey?: string
  apiSecret?: string
}

interface SolaPaymentLinkResponse {
  id: string
  url: string
  expiresAt: string
}

interface SolaWebhookPayload {
  event: string
  paymentId: string
  invoiceId: string
  amount: number
  status: string
  transactionId: string
  timestamp: string
  signature: string
}

export class SolaService {
  private urlContext(request: SolaPaymentLinkRequest) {
    return {
      invoiceId: request.invoiceId,
      invoiceNumber: request.invoiceNumber,
    }
  }

  private buildCardknoxFallbackUrl(request: SolaPaymentLinkRequest): string {
    return buildCardknoxFallbackUrl(
      {
        invoiceRef: request.invoiceNumber || request.invoiceId,
        amountStr: Number(request.amount || 0).toFixed(2),
        description: request.description || '',
        intentRef: request.intentRef,
        clientName: request.clientName,
        clientEmail: request.clientEmail,
        clientPhone: request.clientPhone,
        billingStreet: request.billingStreet,
        billingCity: request.billingCity,
        billingState: request.billingState,
        billingZip: request.billingZip,
        billingCountry: request.billingCountry || 'US',
        returnUrl: request.returnUrl,
        webhookUrl: request.webhookUrl,
      },
      this.urlContext(request)
    )
  }

  private safePaymentUrl(url: string, request: SolaPaymentLinkRequest): string {
    return validatePaymentUrlForStorage(url, this.urlContext(request))
  }

  private async makeRequest(
    endpoint: string,
    method: string,
    body?: any,
    credentials?: { apiKey?: string; apiSecret?: string }
  ): Promise<any> {
    const url = `${SOLA_API_BASE}${endpoint}`
    const apiKey = credentials?.apiKey || SOLA_API_KEY
    const apiSecret = credentials?.apiSecret || SOLA_API_SECRET
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': apiKey ? `Bearer ${apiKey}` : '',
      'X-API-Key': apiKey || '',
      'X-API-Secret': apiSecret || '',
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }))
      throw new Error(error.message || `SOLA API error: ${response.statusText}`)
    }

    const json = await response.json()

    // Cardknox-style gateways return HTTP 200 even for a declined/errored
    // transaction — the real outcome is in the body (Result: "A" = approved,
    // anything else = failed), not the HTTP status. A refund we don't
    // catch here gets recorded as "completed" locally while no money
    // actually moves at the processor — this happened in production on
    // 2026-04-23 (refund cmobl9ib400ax3t2vvbk77n5q, Result "E", missing
    // X-Recurring-Api-Version header) so this check is not theoretical.
    if (json && typeof json === 'object') {
      const result = (json as any).Result ?? (json as any).xResult
      const gatewayError = (json as any).Error ?? (json as any).xError
      if ((result && result !== 'A') || gatewayError) {
        throw new Error(gatewayError || `SOLA gateway declined the request (Result: ${result})`)
      }
    }

    return json
  }

  async createPaymentLink(request: SolaPaymentLinkRequest): Promise<SolaPaymentLinkResponse> {
    const amountCents = Math.round((request.amount || 0) * 100)
    const v2Payload = {
      xCommand: 'cc:sale',
      xInvoice: request.invoiceNumber || request.invoiceId,
      ...(request.intentRef ? { xCustom1: request.intentRef } : {}),
      xAmount: (amountCents / 100).toFixed(2),
      amountCents,
      description: request.description,
      xName: request.clientName,
      xEmail: request.clientEmail,
      xPhone: request.clientPhone,
      xAddress: request.billingStreet,
      xCity: request.billingCity,
      xState: request.billingState,
      xZip: request.billingZip,
      metadata: {
        invoiceId: request.invoiceId,
        invoiceNumber: request.invoiceNumber,
      },
      customer: request.clientEmail
        ? {
            email: request.clientEmail,
            name: request.clientName,
            phone: request.clientPhone,
            address: request.billingStreet
              ? {
                  line1: request.billingStreet,
                  city: request.billingCity,
                  state: request.billingState,
                  postalCode: request.billingZip,
                  country: request.billingCountry || 'US',
                }
              : undefined,
          }
        : undefined,
      returnUrl: request.returnUrl,
      webhookUrl: request.webhookUrl,
    }
    const v1Payload = {
      amount: request.amount,
      currency: 'USD',
      description: request.description,
      metadata: {
        invoiceId: request.invoiceId,
        invoiceNumber: request.invoiceNumber,
      },
      customer: request.clientEmail
        ? {
            email: request.clientEmail,
            name: request.clientName,
          phone: request.clientPhone,
          }
        : undefined,
      returnUrl: request.returnUrl,
      webhookUrl: request.webhookUrl,
    }

    const attempts: Array<{ endpoint: string; payload: any }> = [
      { endpoint: '/payment-links', payload: v2Payload },
      { endpoint: '/v1/payment-links', payload: v1Payload },
      { endpoint: '/v2/payment-links', payload: v2Payload },
    ]
    let lastError: Error | null = null

    for (const attempt of attempts) {
      try {
        const raw = await this.makeRequest(attempt.endpoint, 'POST', attempt.payload, {
          apiKey: request.apiKey,
          apiSecret: request.apiSecret,
        })
        const url = String(
          raw?.url || raw?.paymentUrl || raw?.PaymentURL || raw?.link?.url || raw?.data?.url || ''
        )
        if (url) {
          return {
            id: String(raw.id || raw.transactionId || raw.TransactionID || raw.xRefnum || request.invoiceId),
            url: this.safePaymentUrl(url, request),
            expiresAt: String(
              raw.expiresAt ||
                raw.expiration ||
                raw.link?.expiresAt ||
                new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
            ),
          }
        }
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }

    // Fallback to merchant-hosted Cardknox payment page if API does not return a dynamic URL.
    // This keeps the payment flow usable while preserving API diagnostics in logs.
    if (CARDKNOX_HOSTED_FORM_URL) {
      console.warn(
        `Sola did not return a hosted payment URL. Falling back to CARDKNOX_HOSTED_FORM_URL. ${lastError ? `Last error: ${lastError.message}` : ''}`.trim()
      )
      const fallbackUrl = this.buildCardknoxFallbackUrl(request)
      return {
        id: request.invoiceId,
        url: this.safePaymentUrl(fallbackUrl, request),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
      }
    }

    throw new Error(
      `Sola did not return a hosted payment URL. ${lastError ? `Last error: ${lastError.message}` : ''}`.trim()
    )
  }

  async getPaymentStatus(paymentId: string): Promise<any> {
    return this.makeRequest(`/v1/payments/${paymentId}`, 'GET')
  }

  async refundPayment(paymentId: string, amount?: number): Promise<any> {
    return this.makeRequest(`/v1/payments/${paymentId}/refund`, 'POST', {
      amount,
    })
  }

  verifyWebhookSignature(payload: string, signature: string): boolean {
    // Verify webhook signature
    // Implementation depends on SOLA's signature algorithm
    // This is a placeholder
    if (!SOLA_API_SECRET) return false

    // TODO: Implement HMAC verification
    // const expectedSignature = crypto
    //   .createHmac('sha256', SOLA_API_SECRET)
    //   .update(payload)
    //   .digest('hex')
    
    return true // Placeholder
  }
}

export const solaService = new SolaService()
