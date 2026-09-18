import { ChatAttachmentKind, ChatMessageType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { listMessages, sendMessageToConversation } from '@/lib/chat/service'

function toAttachmentKind(value: string): ChatAttachmentKind | null {
  const upper = value.toUpperCase()
  if (upper === 'IMAGE') return ChatAttachmentKind.IMAGE
  if (upper === 'VIDEO') return ChatAttachmentKind.VIDEO
  if (upper === 'FILE') return ChatAttachmentKind.FILE
  if (upper === 'VOICE') return ChatAttachmentKind.VOICE
  if (upper === 'LOCATION') return ChatAttachmentKind.LOCATION
  return null
}

function toMessageType(value: string): ChatMessageType | null {
  const upper = value.toUpperCase()
  if (upper === 'TEXT') return ChatMessageType.TEXT
  if (upper === 'MEDIA') return ChatMessageType.MEDIA
  if (upper === 'VOICE') return ChatMessageType.VOICE
  if (upper === 'LOCATION') return ChatMessageType.LOCATION
  if (upper === 'SYSTEM') return ChatMessageType.SYSTEM
  return null
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const { searchParams } = new URL(request.url)
    const cursor = searchParams.get('cursor')
    const limitParam = Number(searchParams.get('limit') || 40)
    const messages = await listMessages(user.tenantId, params.id, user.id, cursor, limitParam)
    return NextResponse.json({ messages })
  } catch (error: any) {
    if (String(error?.message || '').includes('not found')) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    console.error('messages list GET error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.send')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const rawAttachments = Array.isArray(body?.attachments) ? body.attachments : []
    const attachments = rawAttachments
      .map((attachment: any) => {
        const kind = toAttachmentKind(String(attachment?.kind || ''))
        const url = typeof attachment?.url === 'string' ? attachment.url : ''
        if (!kind || !url) return null
        return {
          kind,
          url,
          fileName: typeof attachment?.fileName === 'string' ? attachment.fileName : null,
          mimeType: typeof attachment?.mimeType === 'string' ? attachment.mimeType : null,
          sizeBytes: typeof attachment?.sizeBytes === 'number' ? attachment.sizeBytes : null,
          durationMs: typeof attachment?.durationMs === 'number' ? attachment.durationMs : null,
          thumbnailUrl: typeof attachment?.thumbnailUrl === 'string' ? attachment.thumbnailUrl : null,
          latitude: typeof attachment?.latitude === 'number' ? attachment.latitude : null,
          longitude: typeof attachment?.longitude === 'number' ? attachment.longitude : null,
        }
      })
      .filter((row: any) => Boolean(row))

    const messageTypeRaw = typeof body?.type === 'string' ? body.type : ''
    const messageType = messageTypeRaw ? toMessageType(messageTypeRaw) : null
    const replyToTypeRaw = typeof body?.replyToType === 'string' ? body.replyToType : ''
    const replyToType = replyToTypeRaw ? toMessageType(replyToTypeRaw) : null

    const message = await sendMessageToConversation(
      {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
      },
      params.id,
      {
        text: typeof body?.text === 'string' ? body.text : null,
        clientTempId: typeof body?.clientTempId === 'string' ? body.clientTempId : null,
        jobId: typeof body?.jobId === 'string' ? body.jobId : null,
        type: messageType || undefined,
        replyToMessageId: typeof body?.replyToMessageId === 'string' ? body.replyToMessageId : null,
        replyToSenderName: typeof body?.replyToSenderName === 'string' ? body.replyToSenderName : null,
        replyToText: typeof body?.replyToText === 'string' ? body.replyToText : null,
        replyToType: replyToType || null,
        notifyUserIds: Array.isArray(body?.notifyUserIds)
          ? body.notifyUserIds.filter((id: unknown) => typeof id === 'string' && id)
          : null,
        attachments,
      }
    )

    return NextResponse.json({ message })
  } catch (error: any) {
    const message = String(error?.message || 'Internal server error')
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    if (message.includes('required') || message.includes('cannot')) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    console.error('messages send POST error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
