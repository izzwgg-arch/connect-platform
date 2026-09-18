/**
 * web.whatis Messaging Provider
 */

import { MessagingProvider, SendMessageParams, SendMessageResult, InboundWebhookPayload, MessagingChannel, MessageStatus } from '../types'
import crypto from 'crypto'

const WEBWHATIS_API_BASE = process.env.WEBWHATIS_API_BASE || 'https://api.webwhatis.com/v1'
const WEBWHATIS_API_KEY = process.env.WEBWHATIS_API_KEY

export class WebWhatisProvider implements MessagingProvider {
  private apiKey: string

  constructor(apiKey?: string) {
    this.apiKey = apiKey || WEBWHATIS_API_KEY || ''
    if (!this.apiKey) {
      throw new Error('WEBWHATIS_API_KEY not configured')
    }
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    try {
      if (
        params.channel !== MessagingChannel.WHATSAPP &&
        params.channel !== MessagingChannel.SMS &&
        params.channel !== MessagingChannel.MMS
      ) {
        return {
          success: false,
          error: `Channel ${params.channel} not supported by web.whatis`,
        }
      }

      // Web.whatis: treat MMS as SMS endpoint with media payload
      const endpoint = params.channel === MessagingChannel.WHATSAPP
        ? `${WEBWHATIS_API_BASE}/whatsapp/messages`
        : `${WEBWHATIS_API_BASE}/sms/messages`

      const payload: any = {
        to: params.to,
        message: params.body || '',
      }

      if (params.from) {
        payload.from = params.from
      }

      if (params.media && params.media.length > 0) {
        payload.media = params.media.map((m) => ({
          type: m.type,
          url: m.url,
          mime_type: m.mimeType,
          filename: m.filename,
        }))
      }

      if (params.metadata) {
        payload.metadata = params.metadata
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Unknown error' }))
        return {
          success: false,
          error: error.message || `HTTP ${response.status}`,
        }
      }

      const data = await response.json()

      return {
        success: true,
        messageId: data.id,
        providerMessageId: data.provider_message_id || data.id,
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Unknown error',
      }
    }
  }

  async verifyWebhookSignature(request: Request, secret: string): Promise<boolean> {
    try {
      // web.whatis typically uses HMAC-SHA256 signature
      const signature = request.headers.get('x-webwhatis-signature') || 
                        request.headers.get('x-signature') ||
                        request.headers.get('x-hub-signature-256')
      
      if (!signature) {
        // If no signature header, allow (for development/testing)
        // In production, you might want to require it
        return true
      }

      // Clone request to read body
      const clonedRequest = request.clone()
      const body = await clonedRequest.text()
      
      // Compute HMAC
      const hmac = crypto.createHmac('sha256', secret)
      hmac.update(body)
      const computedSignature = hmac.digest('hex')

      // Handle different signature formats
      // Some providers send "sha256=..." prefix
      const sigValue = signature.replace('sha256=', '')
      
      // Compare signatures (timing-safe comparison)
      if (sigValue.length !== computedSignature.length) {
        return false
      }
      
      return crypto.timingSafeEqual(
        Buffer.from(sigValue, 'hex'),
        Buffer.from(computedSignature, 'hex')
      )
    } catch (error) {
      // Never log secrets in error messages
      console.error('Webhook signature verification failed')
      return false
    }
  }

  async parseWebhookPayload(body: any): Promise<InboundWebhookPayload | null> {
    try {
      // Parse web.whatis webhook format
      // Adjust based on actual web.whatis API documentation
      const eventType = body.event_type || body.type

      if (eventType === 'message.received' || eventType === 'inbound_message') {
        return {
          eventType: 'inbound_message',
          providerMessageId: body.message_id || body.id,
          from: body.from || body.from_number || body.phone,
          to: body.to || body.to_number || body.destination,
          body: body.message || body.body || body.text,
          media: body.media?.map((m: any) => ({
            type: m.type || 'image',
            url: m.url || m.media_url,
            thumbnailUrl: m.thumbnail_url,
            mimeType: m.mime_type || m.content_type,
            size: m.size,
            filename: m.filename,
          })) || [],
          timestamp: new Date(body.timestamp || body.created_at || Date.now()),
          metadata: body.metadata || {},
        }
      }

      if (eventType === 'message.status' || eventType === 'message_status_update') {
        let status: MessageStatus = MessageStatus.SENT
        if (body.status === 'delivered') status = MessageStatus.DELIVERED
        else if (body.status === 'failed') status = MessageStatus.FAILED
        else if (body.status === 'read') status = MessageStatus.READ

        return {
          eventType: 'message_status_update',
          providerMessageId: body.message_id || body.id,
          from: body.from || '',
          to: body.to || '',
          status,
          timestamp: new Date(body.timestamp || body.updated_at || Date.now()),
          metadata: body.metadata || {},
        }
      }

      return null
    } catch (error) {
      console.error('Failed to parse webhook payload:', error)
      return null
    }
  }
}
