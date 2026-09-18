import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { messagingService } from '@/lib/messaging/service'
import { MessagingChannel } from '@/lib/messaging/types'

export const dynamic = 'force-dynamic'

/** GET /api/sms/conversations/[id]/messages */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError
  const user = getAuthUser(request)

  const conversation = await prisma.conversation.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  })
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const messages = await prisma.message.findMany({
    where: { conversationId: params.id, tenantId: user.tenantId },
    include: { media: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })

  // Mark conversation as read
  if (conversation.unreadCount > 0) {
    await prisma.conversation.update({
      where: { id: params.id },
      data: { unreadCount: 0 },
    }).catch(() => {})
  }

  return NextResponse.json({ messages, conversation })
}

/**
 * POST /api/sms/conversations/[id]/messages
 *
 * Supports:
 *   - text-only SMS: { text: "hello" }
 *   - MMS with media: { text?: "caption", media: [{ url, type, mimeType, filename }] }
 *   - voice note:     { media: [{ url, type: "audio", mimeType: "audio/webm" }] }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.send')
  if (permError) return permError
  const user = getAuthUser(request)

  const conversation = await prisma.conversation.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  })
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json()
  const text: string = String(body.text || '').trim()
  const rawMedia: any[] = Array.isArray(body.media) ? body.media : []

  if (!text && rawMedia.length === 0) {
    return NextResponse.json({ error: 'text or media required' }, { status: 400 })
  }

  const participants = Array.isArray(conversation.participants)
    ? (conversation.participants as string[])
    : []
  const toNumber = participants[0]
  if (!toNumber) {
    return NextResponse.json({ error: 'No recipient phone number on this conversation' }, { status: 400 })
  }

  // Determine channel: MMS if any media, otherwise SMS
  const hasmedia = rawMedia.length > 0
  const channel = hasmedia ? MessagingChannel.MMS : MessagingChannel.SMS

  const result = await messagingService.sendMessage(
    user.tenantId,
    {
      to: toNumber,
      body: text || undefined,
      channel,
      media: hasmedia
        ? rawMedia.map((m: any) => ({
            url: m.url,
            type: m.type || 'image',
            mimeType: m.mimeType || null,
            filename: m.filename || m.fileName || null,
          }))
        : undefined,
    },
    params.id
  )

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  return NextResponse.json({ success: true, messageId: result.messageId })
}
