import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; messageId: string } }
) {
  const authError = await authenticateRequest(req)
  if (authError) return authError
  const permError = await requirePermission(req, 'messages.send')
  if (permError) return permError
  const user = getAuthUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { emoji } = await req.json()
  if (!emoji || typeof emoji !== 'string') {
    return NextResponse.json({ error: 'emoji is required' }, { status: 400 })
  }

  // Verify the message exists in this conversation and tenant
  const message = await prisma.chatMessage.findFirst({
    where: { id: params.messageId, conversationId: params.id, tenantId: user.tenantId },
    select: { id: true },
  })
  if (!message) return NextResponse.json({ error: 'Message not found' }, { status: 404 })

  // Toggle: remove if exists, add if not
  const existing = await prisma.chatMessageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId: params.messageId, userId: user.id, emoji } },
  })

  if (existing) {
    await prisma.chatMessageReaction.delete({ where: { id: existing.id } })
  } else {
    await prisma.chatMessageReaction.create({
      data: { tenantId: user.tenantId, messageId: params.messageId, userId: user.id, emoji },
    })
  }

  // Return updated reactions for this message
  const reactions = await prisma.chatMessageReaction.findMany({
    where: { messageId: params.messageId },
    select: { userId: true, emoji: true },
  })

  // Enrich with user names
  const userIds = [...new Set(reactions.map((r) => r.userId))]
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, firstName: true, lastName: true, email: true },
  })
  const userMap = new Map(users.map((u) => [u.id, u]))

  const enriched = reactions.map((r) => {
    const u = userMap.get(r.userId)
    const name = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email : 'Unknown'
    return { emoji: r.emoji, userId: r.userId, userName: name }
  })

  return NextResponse.json({ reactions: enriched })
}
