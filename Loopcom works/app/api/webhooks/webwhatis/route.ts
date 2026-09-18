import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { WebWhatisProvider } from '@/lib/messaging/providers/webwhatis'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import crypto from 'crypto'

export async function POST(request: NextRequest) {
  try {
    // Get webhook secret from integration (assuming web.whatis is stored as "webwhatis" provider)
    // For now, we'll check all tenants and find the one with matching secret
    // In production, you'd want a better way to route to the correct tenant
    const providerName = 'webwhatis'

    // Try to find tenant by checking webhook signature
    // This is a simplified approach - in production, you might use a shared secret
    // or route based on subdomain/domain
    const connections = await prisma.integrationConnection.findMany({
      where: {
        provider: providerName,
        status: 'CONNECTED',
      },
      include: {
        tenant: true,
      },
    })

    if (connections.length === 0) {
      console.warn('No web.whatis integration found')
      return NextResponse.json({ error: 'Integration not configured' }, { status: 404 })
    }

    // Use first connection for now (in production, determine tenant differently)
    const connection = connections[0]
    const secrets = await getIntegrationSecrets(connection.tenantId, providerName as any)

    if (!secrets?.webhookSecret) {
      console.error('Webhook secret not configured for web.whatis')
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 401 })
    }

    // Clone request for signature verification (body can only be read once)
    const clonedRequest = request.clone()
    
    // Verify webhook signature
    const webwhatisProvider = new WebWhatisProvider(secrets.apiKey)
    const isValid = await webwhatisProvider.verifyWebhookSignature(clonedRequest, secrets.webhookSecret)

    if (!isValid) {
      console.error('Invalid webhook signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // Parse webhook payload (use original request)
    const body = await request.json()
    const payload = await webwhatisProvider.parseWebhookPayload(body)

    if (!payload) {
      // Unknown event type, but signature was valid - acknowledge it
      return NextResponse.json({ received: true })
    }

    // Check for duplicate events (idempotency)
    const eventHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ providerMessageId: payload.providerMessageId, eventType: payload.eventType }))
      .digest('hex')

    const existingEvent = await prisma.webhookEvent.findFirst({
      where: {
        tenantId: connection.tenantId,
        provider: providerName,
        OR: [
          { eventId: payload.providerMessageId },
          { payloadHash: eventHash },
        ],
      },
    })

    if (existingEvent) {
      // Already processed
      return NextResponse.json({ received: true, duplicate: true })
    }

    // Store webhook event
    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        tenantId: connection.tenantId,
        provider: providerName,
        eventId: payload.providerMessageId,
        eventType: payload.eventType,
        payloadHash: eventHash,
        rawPayload: body,
        processed: false,
      },
    })

    // Process based on event type
    if (payload.eventType === 'inbound_message') {
      await processInboundMessage(connection.tenantId, payload)
    } else if (payload.eventType === 'message_status_update') {
      await processStatusUpdate(connection.tenantId, payload)
    }

    // Mark as processed
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processed: true, processedAt: new Date() },
    })

    return NextResponse.json({ received: true })
  } catch (error: any) {
    console.error('Web.whatis webhook error:', error.message || error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function processInboundMessage(tenantId: string, payload: any) {
  try {
    // Find or create conversation
    const phoneNumber = payload.from
    const channel = payload.body || payload.media?.length > 0 ? 'SMS' : 'MMS' // Determine channel

    // Find existing client by phone number
    const client = await prisma.client.findFirst({
      where: {
        tenantId,
        phone: phoneNumber,
      },
    })

    // Find or create conversation
    // For JSON array fields, we need to check if the array contains the value
    const allConversations = await prisma.conversation.findMany({
      where: {
        tenantId,
        channel: channel as any,
      },
      select: {
        id: true,
        participants: true,
      },
    })

    let conversation = allConversations.find((conv) => {
      const participants = conv.participants as any
      return Array.isArray(participants) && participants.includes(phoneNumber)
    })

    if (conversation) {
      conversation = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      })
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          tenantId,
          channel: channel as any,
          clientId: client?.id || null,
          participants: [phoneNumber],
          status: 'ACTIVE',
          lastMessageAt: payload.timestamp,
          unreadCount: 1,
        },
      })
    } else {
      // Update conversation
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: payload.timestamp,
          unreadCount: {
            increment: 1,
          },
        },
      })
    }

    // Create message
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        direction: 'INBOUND',
        channel: channel as any,
        body: payload.body || null,
        fromNumber: payload.from,
        toNumber: payload.to,
        provider: 'webwhatis',
        providerMessageId: payload.providerMessageId,
        status: 'DELIVERED',
        deliveredAt: payload.timestamp,
      },
    })

    // Create media attachments if any
    if (payload.media && payload.media.length > 0) {
      await Promise.all(
        payload.media.map((media: any) =>
          prisma.messageMedia.create({
            data: {
              messageId: message.id,
              type: media.type || 'image',
              url: media.url,
              thumbnailUrl: media.thumbnailUrl,
              mimeType: media.mimeType,
              size: media.size,
              filename: media.filename,
            },
          })
        )
      )
    }

    // Create notification for assigned user
    if (conversation.assignedUserId) {
      await prisma.notification.create({
        data: {
          tenantId,
          userId: conversation.assignedUserId,
          type: 'INCOMING_SMS',
          title: 'New Message',
          message: payload.body || 'New message received',
          linkUrl: `/dashboard/messages/${conversation.id}`,
          linkType: 'conversation',
          status: 'UNREAD',
        },
      })
    }
  } catch (error) {
    console.error('Failed to process inbound message:', error)
    throw error
  }
}

async function processStatusUpdate(tenantId: string, payload: any) {
  try {
    // Update message status
    const message = await prisma.message.findFirst({
      where: {
        tenantId,
        provider: 'webwhatis',
        providerMessageId: payload.providerMessageId,
      },
    })

    if (message) {
      const updateData: any = {
        status: payload.status,
      }

      if (payload.status === 'DELIVERED') {
        updateData.deliveredAt = payload.timestamp
      } else if (payload.status === 'READ') {
        updateData.readAt = payload.timestamp
      } else if (payload.status === 'FAILED') {
        updateData.failedAt = payload.timestamp
      }

      await prisma.message.update({
        where: { id: message.id },
        data: updateData,
      })
    }
  } catch (error) {
    console.error('Failed to process status update:', error)
    throw error
  }
}
