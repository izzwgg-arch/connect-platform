import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { toE164, formatPhone, toNanp10 } from '@/lib/phone'

export const dynamic = 'force-dynamic'

/** GET /api/sms/conversations — list all SMS/MMS conversations for the tenant. */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError
  const user = getAuthUser(request)

  const conversations = await prisma.conversation.findMany({
    where: {
      tenantId: user.tenantId,
      channel: { in: ['SMS', 'MMS'] as any },
    },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, body: true, direction: true, createdAt: true, status: true },
      },
      client: { select: { id: true, name: true } },
    },
    orderBy: { lastMessageAt: 'desc' },
  })

  return NextResponse.json({
    conversations: conversations.map((conv) => {
      const participants = Array.isArray(conv.participants) ? (conv.participants as string[]) : []
      const phoneRaw = participants[0] || ''
      const phoneE164 = toE164(phoneRaw)
      return {
        id: conv.id,
        phone: phoneE164,
        phoneDisplay: formatPhone(phoneRaw),
        clientName: conv.client?.name || null,
        clientId: conv.clientId,
        channel: conv.channel,
        status: conv.status,
        unreadCount: conv.unreadCount,
        lastMessageAt: conv.lastMessageAt,
        lastMessage: conv.messages[0] || null,
      }
    }),
  })
}

/**
 * POST /api/sms/conversations — find or create an SMS conversation for a phone number.
 * Body: { phone: string }
 */
export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  // Was unguarded — any authenticated user could create conversation records and
  // probe whether a client exists for an arbitrary phone number. GET already
  // requires messages.view; a create is at least as sensitive.
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError
  const user = getAuthUser(request)

  const body = await request.json()
  const rawPhone: string = String(body.phone || '').trim()
  if (!rawPhone) return NextResponse.json({ error: 'phone is required' }, { status: 400 })

  const e164 = toE164(rawPhone)
  const digits10 = toNanp10(rawPhone)

  // Search all SMS/MMS conversations and match by normalized number
  const existing = await prisma.conversation.findMany({
    where: {
      tenantId: user.tenantId,
      channel: { in: ['SMS', 'MMS'] as any },
    },
    select: { id: true, participants: true },
  })

  const match = existing.find((conv) => {
    const parts = Array.isArray(conv.participants) ? (conv.participants as string[]) : []
    return parts.some((p) => toE164(p) === e164)
  })

  if (match) {
    return NextResponse.json({ conversationId: match.id, existing: true })
  }

  // Look up client by phone
  const client = await prisma.client.findFirst({
    where: { tenantId: user.tenantId, phone: { contains: digits10 } },
    select: { id: true },
  })

  const conversation = await prisma.conversation.create({
    data: {
      tenantId: user.tenantId,
      channel: 'SMS' as any,
      clientId: client?.id || null,
      participants: [e164],
      status: 'ACTIVE',
    },
  })

  return NextResponse.json({ conversationId: conversation.id, existing: false })
}
