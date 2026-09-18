import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { decryptSecrets } from '@/lib/integrations/secrets'
import { toE164, toNanp10 } from '@/lib/phone'

// Legacy alias used throughout this file
function normalizeNanpDigits(input: string): string {
  return toNanp10(input)
}

export async function POST(request: NextRequest) {
  try {
    // VoIP.ms sends webhooks as form data, not JSON
    // IMPORTANT: Request body can only be read once!
    let body: any = {}
    const contentType = request.headers.get('content-type') || ''
    
    // Read body based on content type - only read once!
    if (contentType.includes('application/json')) {
      body = await request.json()
    } else {
      // For form data or URL-encoded, read as text first, then parse
      const text = await request.text()
      console.log('Raw webhook body:', text.substring(0, 500))
      
      if (contentType.includes('application/x-www-form-urlencoded') || !contentType || text.includes('=')) {
        // URL-encoded form data or query string format
        const params = new URLSearchParams(text)
        body = Object.fromEntries(params.entries())
        // VoIP.ms might send mms_urls as a string array or comma-separated
        if (body.mms_urls && typeof body.mms_urls === 'string') {
          body.mms_urls = body.mms_urls.split(',').filter((url: string) => url.trim())
        }
      } else {
        // Try to parse as JSON if it looks like JSON
        try {
          body = JSON.parse(text)
        } catch (e) {
          // Fallback: try as query string
          const params = new URLSearchParams(text)
          body = Object.fromEntries(params.entries())
        }
      }
    }
    
    console.log('=== VoIP.ms WEBHOOK RECEIVED ===')
    console.log('Content-Type:', contentType)
    console.log('Body:', JSON.stringify(body, null, 2))
    console.log('Request URL:', request.url)
    console.log('Request Method:', request.method)
    
    // VoIP.ms sends webhooks in a nested format:
    // { data: { payload: { from: { phone_number }, to: [{ phone_number }], text, type, received_at, id } } }
    // OR: { payload: { ... } }
    // OR older format: { type, from, to, message, datetime, id }
    let type: string | undefined
    let from: string | undefined
    let to: string | undefined
    let message: string | undefined
    let mms_urls: string[] | undefined
    let datetime: string | undefined
    let id: string | undefined

    // VoIP.ms wraps in data.payload
    const payload = body.data?.payload || body.payload
    
    if (payload) {
      // New VoIP.ms format with nested structure
      type = payload.type?.toLowerCase() // "SMS" or "MMS"
      from = payload.from?.phone_number || payload.from
      to = Array.isArray(payload.to) ? payload.to[0]?.phone_number : payload.to
      message = payload.text || payload.message
      datetime = payload.received_at || payload.datetime
      id = payload.id?.toString()
      mms_urls = payload.media?.map((m: any) => m.url || m.media_url) || []
    } else {
      // Old flat format
      type = body.type
      from = body.from
      to = body.to
      message = body.message
      mms_urls = body.mms_urls
      datetime = body.datetime
      id = body.id?.toString()
    }

    console.log(`Parsed: type=${type}, from=${from}, to=${to}, message=${message}`)

    // Verify webhook (in production, verify signature/IP)
    
    // Handle inbound SMS and MMS
    if (type === 'sms' || type === 'mms') {
      console.log(`Processing ${type} webhook: from=${from}, to=${to}`)
      // Find tenant by matching the DID (the "to" field) to an IntegrationConnection
      // VoIP.ms sends the DID as the "to" field
      const normalizedToDid = normalizeNanpDigits(to || '')
      
      // Find all VoIP.ms integrations
      const voipmsConnections = await prisma.integrationConnection.findMany({
        where: {
          provider: 'voipms_sms',
          status: 'CONNECTED',
        },
      })

      // Find the connection that matches this DID
      let matchingConnection = null
      for (const connection of voipmsConnections) {
        try {
          const secrets = decryptSecrets(connection.encryptedSecrets)
          const connectionDid = normalizeNanpDigits(secrets.defaultDid || '')
          if (connectionDid === normalizedToDid) {
            matchingConnection = connection
            break
          }
        } catch (e) {
          // Skip connections with invalid secrets
          continue
        }
      }

      if (!matchingConnection) {
        console.error(`VoIP.ms webhook: No tenant found for DID ${to} (normalized: ${normalizedToDid})`)
        console.error(`Available connections:`, voipmsConnections.map(c => ({ id: c.id, tenantId: c.tenantId })))
        return NextResponse.json({ error: 'Tenant not found for this DID' }, { status: 404 })
      }

      console.log(`Found matching connection for tenant: ${matchingConnection.tenantId}`)
      const tenantId = matchingConnection.tenantId
      const normalizedFrom = normalizeNanpDigits(from || '')
      // Canonical E.164 form — used for storage so same number always maps to one thread
      const fromE164 = toE164(from || '')

      // Try to find client/contact by phone number
      const client = await prisma.client.findFirst({
        where: {
          tenantId,
          phone: { contains: normalizedFrom.slice(-10) }, // Match last 10 digits
        },
      })

      const contact = client
        ? await prisma.contact.findFirst({
            where: {
              clientId: client.id,
              OR: [
                { phone: { contains: normalizedFrom } },
                { mobile: { contains: normalizedFrom } },
              ],
            },
          })
        : null

      // Find or create conversation — always match and store using E.164 to prevent duplicates
      const channel = type === 'mms' ? 'MMS' : 'SMS'

      // Load all SMS/MMS conversations for this tenant (only id + participants for efficiency)
      const allConversations = await prisma.conversation.findMany({
        where: { tenantId, channel: { in: ['SMS', 'MMS'] as any } },
        select: { id: true, participants: true },
      })

      // Match by E.164 normalization — same number in any format → same thread
      let conversation = allConversations.find((conv) => {
        const parts = Array.isArray(conv.participants) ? (conv.participants as string[]) : []
        return parts.some((p) => toE164(p) === fromE164)
      }) as any

      const timestamp = datetime ? new Date(datetime) : new Date()

      if (conversation) {
        // Canonicalize participants to E.164 if not already stored that way
        const parts = Array.isArray(conversation.participants) ? (conversation.participants as string[]) : []
        const alreadyE164 = parts.includes(fromE164)
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: timestamp,
            unreadCount: { increment: 1 },
            // Replace any legacy formats with E.164
            participants: alreadyE164 ? undefined : [fromE164, ...parts.filter((p: string) => toE164(p) !== fromE164)],
          },
        })
        conversation = await prisma.conversation.findUnique({ where: { id: conversation.id } })
      } else {
        // Create new conversation — always store E.164
        conversation = await prisma.conversation.create({
          data: {
            tenantId,
            channel: channel as any,
            clientId: client?.id || null,
            participants: [fromE164],
            status: 'ACTIVE',
            lastMessageAt: timestamp,
            unreadCount: 1,
          },
        })
      }

      // Create message - MUST include channel field
      const messageRecord = await prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          channel: channel as any, // Required field
          direction: 'INBOUND',
          body: message || '',
          provider: 'voipms',
          providerMessageId: id?.toString() || null,
          status: 'DELIVERED',
          fromNumber: from,
          toNumber: to,
          createdAt: timestamp,
        },
      })

      // Create message media if MMS
      if (type === 'mms' && mms_urls && mms_urls.length > 0) {
        for (const mediaUrl of mms_urls) {
          await prisma.messageMedia.create({
            data: {
              messageId: messageRecord.id,
              type: 'image', // VoIP.ms doesn't specify, default to image
              url: mediaUrl,
              mimeType: null,
            },
          })
        }
      }

      // Create notification for unread message
      const users = await prisma.user.findMany({
        where: {
          tenantId,
          status: 'ACTIVE',
        },
      })

      for (const user of users) {
        await prisma.notification.create({
          data: {
            tenantId,
            userId: user.id,
            type: 'INCOMING_SMS', // Use INCOMING_SMS for both SMS and MMS (INCOMING_MMS doesn't exist in enum)
            title: type === 'mms' ? 'New MMS' : 'New SMS',
            message: `${type === 'mms' ? 'MMS' : 'SMS'} from ${from}: ${(message || '').substring(0, 50)}${mms_urls && mms_urls.length > 0 ? ` (${mms_urls.length} media)` : ''}`,
            linkType: 'conversation',
            linkId: conversation.id,
            linkUrl: `/dashboard/messages?conversation=${conversation.id}`,
          },
        })
      }

      return NextResponse.json({ message: 'Webhook processed successfully' })
    }

    return NextResponse.json({ message: 'Webhook received (not SMS/MMS type)' })
  } catch (error: any) {
    console.error('VoIP.ms webhook error:', error)
    console.error('Error stack:', error?.stack)
    console.error('Error message:', error?.message)
    return NextResponse.json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error?.message : undefined
    }, { status: 500 })
  }
}

// GET endpoint for webhook verification
export async function GET(request: NextRequest) {
  return NextResponse.json({ message: 'VoIP.ms webhook endpoint' })
}
