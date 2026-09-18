/**
 * Unified Messaging Abstraction
 * Send messages via SMS, WhatsApp, or Email
 */

import { getIntegrationSecrets } from '../integrations/status'
import { sendVoipMsSms } from '../integrations/providers/voipms'
import { sendWhatsApp } from '../integrations/providers/whatsapp'
import { sendEmail } from '../email/provider'

export type MessagingChannel = 'sms' | 'whatsapp' | 'email'

export interface SendMessageOptions {
  channel: MessagingChannel
  tenantId: string
  to: string | string[]
  body: string
  subject?: string // For email
  html?: string // For email
  from?: string // Optional override
}

export interface SendMessageResult {
  success: boolean
  messageId?: string
  error?: string
  provider?: string
}

/**
 * Send a message via the specified channel
 */
export async function sendMessage(
  options: SendMessageOptions
): Promise<SendMessageResult> {
  const { channel, tenantId, to, body, subject, html, from } = options

  try {
    switch (channel) {
      case 'sms':
        return await sendViaSms(tenantId, Array.isArray(to) ? to[0] : to, body, from)

      case 'whatsapp':
        return await sendViaWhatsApp(tenantId, Array.isArray(to) ? to[0] : to, body, from)

      case 'email':
        return await sendViaEmail(
          tenantId,
          Array.isArray(to) ? to : [to],
          body,
          subject,
          html,
          from
        )

      default:
        return {
          success: false,
          error: `Unsupported channel: ${channel}`,
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
 * Send SMS via VoIP.ms
 */
async function sendViaSms(
  tenantId: string,
  to: string,
  message: string,
  from?: string
): Promise<SendMessageResult> {
  const secrets = await getIntegrationSecrets(tenantId, 'voipms_sms')

  if (!secrets) {
    return {
      success: false,
      error: 'VoIP.ms SMS not configured',
    }
  }

  return await sendVoipMsSms(secrets, to, message, from || secrets.defaultDid)
}

/**
 * Send WhatsApp message
 */
async function sendViaWhatsApp(
  tenantId: string,
  to: string,
  message: string,
  from?: string
): Promise<SendMessageResult> {
  const secrets = await getIntegrationSecrets(tenantId, 'whatsapp')

  if (!secrets) {
    return {
      success: false,
      error: 'WhatsApp not configured',
    }
  }

  return await sendWhatsApp(secrets, to, message)
}

/**
 * Send Email
 */
async function sendViaEmail(
  tenantId: string,
  to: string[],
  text: string,
  subject?: string,
  html?: string,
  from?: string
): Promise<SendMessageResult> {
  const secrets = await getIntegrationSecrets(tenantId, 'email')

  if (!secrets) {
    return {
      success: false,
      error: 'Email provider not configured',
    }
  }

  const result = await sendEmail({
    to,
    subject: subject || 'Message from Trim Pro',
    html: html || text,
    text,
    from: from || secrets.fromEmail,
    replyTo: secrets.replyTo,
  })

  return {
    success: result.success,
    messageId: result.messageId,
    error: result.error,
    provider: result.provider,
  }
}

/**
 * Send message to multiple channels (fallback chain)
 * Tries channels in order until one succeeds
 */
export async function sendMessageWithFallback(
  channels: MessagingChannel[],
  options: Omit<SendMessageOptions, 'channel'>
): Promise<SendMessageResult> {
  for (const channel of channels) {
    const result = await sendMessage({
      ...options,
      channel,
    })

    if (result.success) {
      return result
    }
  }

  return {
    success: false,
    error: `Failed to send via all channels: ${channels.join(', ')}`,
  }
}
