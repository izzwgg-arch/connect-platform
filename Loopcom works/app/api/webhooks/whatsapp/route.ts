import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import crypto from 'crypto'

/**
 * WhatsApp Webhook Handler
 * Supports Twilio and Meta webhooks
 */

// Handle Twilio webhook
async function handleTwilioWebhook(request: NextRequest): Promise<NextResponse> {
  try {
    const formData = await request.formData()
    const from = formData.get('From')?.toString() || ''
    const to = formData.get('To')?.toString() || ''
    const body = formData.get('Body')?.toString() || ''
    const messageSid = formData.get('MessageSid')?.toString() || ''

    // Verify Twilio signature
    const signature = request.headers.get('x-twilio-signature') || ''
    const url = request.url.split('?')[0] // Get URL without query params

    // Get secrets for verification
    const allConnections = await prisma.integrationConnection.findMany({
      where: { provider: 'whatsapp', status: 'CONNECTED' },
    })

    // Find the matching connection (by DID/number)
    // In production, you'd match based on the 'to' number
    let connection = allConnections[0]
    if (allConnections.length > 1) {
      // Match by number
      connection =
        allConnections.find((c) => {
          const secrets = JSON.parse(c.encryptedSecrets || '{}') // Would decrypt in production
          return to.includes(secrets.twilioFromNumber?.replace('whatsapp:', '') || '')
        }) || allConnections[0]
    }

    if (!connection) {
      return NextResponse.json({ error: 'WhatsApp integration not found' }, { status: 404 })
    }

    // Find tenant and create message record
    const tenantId = connection.tenantId

    // Extract phone number (remove whatsapp: prefix)
    const phoneNumber = from.replace(/whatsapp:/gi, '').replace(/\D/g, '')

    // Find client/contact by phone
    const client = await prisma.client.findFirst({
      where: {
        tenantId,
        phone: { contains: phoneNumber.slice(-10) }, // Match last 10 digits
      },
    })

    const contact = client
      ? await prisma.contact.findFirst({
          where: {
            clientId: client.id,
            OR: [{ phone: { contains: phoneNumber } }, { mobile: { contains: phoneNumber } }],
          },
        })
      : null

    // Create message record (using existing SmsMessage model or create new model)
    // For now, store in a general messaging table if available, or skip
    // In production, you might want a separate WhatsAppMessage model

    return NextResponse.json({ message: 'Webhook processed' })
  } catch (error: any) {
    console.error('Twilio WhatsApp webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}

// Handle Meta webhook (verification challenge)
async function handleMetaWebhook(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  // Verification request
  if (mode === 'subscribe' && challenge) {
    // Verify token matches stored verify_token
    // In production, check against integration secrets
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || 'trimpro_verify_token'

    if (token === expectedToken) {
      return new NextResponse(challenge, { status: 200 })
    } else {
      return NextResponse.json({ error: 'Invalid verify token' }, { status: 403 })
    }
  }

  // Incoming message
  if (mode !== 'subscribe') {
    try {
      const body = await request.json()

      if (body.object === 'whatsapp_business_account') {
        const entry = body.entry?.[0]
        const changes = entry?.changes?.[0]
        const value = changes?.value

        if (value?.messages) {
          const message = value.messages[0]
          const from = message.from
          const text = message.text?.body || ''

          // Verify signature if configured
          const signature = request.headers.get('x-hub-signature-256') || ''
          if (signature) {
            // Verify HMAC-SHA256 signature
            const secrets = await getIntegrationSecrets(
              process.env.DEFAULT_TENANT_ID || '', // In production, determine tenant from phone number
              'whatsapp'
            )

            if (secrets?.metaAppSecret) {
              const rawBody = JSON.stringify(body)
              const expectedSignature = crypto
                .createHmac('sha256', secrets.metaAppSecret)
                .update(rawBody)
                .digest('hex')

              if (`sha256=${expectedSignature}` !== signature) {
                return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
              }
            }
          }

          // Process message (similar to Twilio flow)
          // Find tenant, client, create message record

          return NextResponse.json({ message: 'Webhook processed' })
        }
      }

      return NextResponse.json({ message: 'No action required' })
    } catch (error: any) {
      console.error('Meta WhatsApp webhook error:', error)
      return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  // Determine provider based on headers/request format
  const signature = request.headers.get('x-twilio-signature')
  const metaSignature = request.headers.get('x-hub-signature-256')

  if (signature) {
    return handleTwilioWebhook(request)
  } else if (metaSignature || request.nextUrl.searchParams.get('hub.mode')) {
    return handleMetaWebhook(request)
  } else {
    // Default to Twilio format
    return handleTwilioWebhook(request)
  }
}

// Meta requires GET for verification
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  if (searchParams.get('hub.mode')) {
    return handleMetaWebhook(request)
  }

  return NextResponse.json({ message: 'WhatsApp webhook endpoint' })
}
