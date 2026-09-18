import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { messagingService } from '@/lib/messaging/service'
import { MessagingChannel } from '@/lib/messaging/types'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.send')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { conversationId, to, from, body: messageBody, channel, media } = body

    const result = await messagingService.sendMessage(
      user.tenantId,
      {
        to,
        from,
        body: typeof messageBody === 'string' ? messageBody : '',
        channel: channel as MessagingChannel,
        media: media?.map((m: any) => ({
          type: m.type,
          url: m.url,
          thumbnailUrl: m.thumbnailUrl,
          mimeType: m.mimeType,
          size: m.size,
          filename: m.filename,
        })),
      },
      conversationId
    )

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ success: true, messageId: result.messageId })
  } catch (error: any) {
    console.error('Send message error:', error)
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}
