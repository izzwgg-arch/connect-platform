/**
 * WhatsApp Integration
 * Supports Twilio WhatsApp and Meta WhatsApp Cloud API
 */

import { IntegrationTestResult } from '../types'

export async function testWhatsApp(
  secrets: Record<string, any>,
  to: string,
  message: string
): Promise<IntegrationTestResult> {
  try {
    const provider = secrets.provider || 'twilio'

    if (provider === 'twilio') {
      return await testTwilioWhatsApp(secrets, to, message)
    } else if (provider === 'meta') {
      return await testMetaWhatsApp(secrets, to, message)
    } else {
      return {
        success: false,
        message: 'Unknown WhatsApp provider',
        error: `Unsupported provider: ${provider}`,
      }
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'WhatsApp test failed',
      error: error.message || 'Unknown error',
    }
  }
}

async function testTwilioWhatsApp(
  secrets: Record<string, any>,
  to: string,
  message: string
): Promise<IntegrationTestResult> {
  const accountSid = secrets.twilioAccountSid
  const authToken = secrets.twilioAuthToken
  const fromNumber = secrets.twilioFromNumber

  if (!accountSid || !authToken || !fromNumber) {
    return {
      success: false,
      message: 'Twilio WhatsApp credentials not configured',
      error: 'Missing twilioAccountSid, twilioAuthToken, or twilioFromNumber',
    }
  }

  try {
    // Ensure to number is in WhatsApp format
    const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:+${to.replace(/\D/g, '')}`

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: fromNumber,
          To: toFormatted,
          Body: message,
        }),
      }
    )

    if (!response.ok) {
      const error = await response.json()
      return {
        success: false,
        message: 'Twilio WhatsApp test failed',
        error: error.message || `Twilio API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return {
      success: true,
      message: `Test WhatsApp message sent successfully to ${to} via Twilio`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'Twilio WhatsApp test failed',
      error: error.message || 'Unknown error',
    }
  }
}

async function testMetaWhatsApp(
  secrets: Record<string, any>,
  to: string,
  message: string
): Promise<IntegrationTestResult> {
  const phoneNumberId = secrets.metaPhoneNumberId
  const accessToken = secrets.metaAccessToken

  if (!phoneNumberId || !accessToken) {
    return {
      success: false,
      message: 'Meta WhatsApp credentials not configured',
      error: 'Missing metaPhoneNumberId or metaAccessToken',
    }
  }

  try {
    // Format phone number (remove + and non-digits)
    const phoneNumber = to.replace(/\D/g, '')

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'text',
          text: { body: message },
        }),
      }
    )

    if (!response.ok) {
      const error = await response.json()
      return {
        success: false,
        message: 'Meta WhatsApp test failed',
        error: error.error?.message || `Meta API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return {
      success: true,
      message: `Test WhatsApp message sent successfully to ${to} via Meta`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'Meta WhatsApp test failed',
      error: error.message || 'Unknown error',
    }
  }
}

/**
 * Send WhatsApp message
 */
export async function sendWhatsApp(
  secrets: Record<string, any>,
  to: string,
  message: string,
  mediaUrl?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const provider = secrets.provider || 'twilio'

  if (provider === 'twilio') {
    return await sendTwilioWhatsApp(secrets, to, message, mediaUrl)
  } else if (provider === 'meta') {
    return await sendMetaWhatsApp(secrets, to, message, mediaUrl)
  } else {
    return {
      success: false,
      error: `Unsupported provider: ${provider}`,
    }
  }
}

async function sendTwilioWhatsApp(
  secrets: Record<string, any>,
  to: string,
  message: string,
  mediaUrl?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const accountSid = secrets.twilioAccountSid
    const authToken = secrets.twilioAuthToken
    const fromNumber = secrets.twilioFromNumber || secrets.twilioMessagingServiceSid

    if (!accountSid || !authToken || !fromNumber) {
      throw new Error('Twilio credentials not configured')
    }

    const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:+${to.replace(/\D/g, '')}`

    const body: any = {
      From: fromNumber,
      To: toFormatted,
      Body: message,
    }

    if (mediaUrl) {
      body.MediaUrl = mediaUrl
    }

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body),
      }
    )

    const data = await response.json()

    if (response.ok && data.sid) {
      return {
        success: true,
        messageId: data.sid,
      }
    } else {
      return {
        success: false,
        error: data.message || 'Unknown error',
      }
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown error',
    }
  }
}

async function sendMetaWhatsApp(
  secrets: Record<string, any>,
  to: string,
  message: string,
  mediaUrl?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const phoneNumberId = secrets.metaPhoneNumberId
    const accessToken = secrets.metaAccessToken

    if (!phoneNumberId || !accessToken) {
      throw new Error('Meta credentials not configured')
    }

    const phoneNumber = to.replace(/\D/g, '')

    const payload: any = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
    }

    if (mediaUrl) {
      payload.type = 'image'
      payload.image = { link: mediaUrl }
    } else {
      payload.type = 'text'
      payload.text = { body: message }
    }

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )

    const data = await response.json()

    if (response.ok && data.messages) {
      return {
        success: true,
        messageId: data.messages[0]?.id,
      }
    } else {
      return {
        success: false,
        error: data.error?.message || 'Unknown error',
      }
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown error',
    }
  }
}
