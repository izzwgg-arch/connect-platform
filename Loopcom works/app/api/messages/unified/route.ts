/**
 * GET /api/messages/unified
 *
 * Returns a single sorted thread list that merges:
 *   - ChatConversation (team / DM internal chats)
 *   - Conversation (SMS / MMS external chats)
 *
 * Both are returned under a common shape so the UI can render one list
 * without any tab splitting.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { listConversationsForUser } from '@/lib/chat/service'
import { prisma } from '@/lib/prisma'
import { toE164, formatPhone } from '@/lib/phone'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError
  const user = getAuthUser(request)

  const [teamConvs, smsConvs] = await Promise.all([
    listConversationsForUser(user.tenantId, user.id).catch(() => [] as any[]),
    prisma.conversation.findMany({
      where: {
        tenantId: user.tenantId,
        channel: { in: ['SMS', 'MMS'] as any },
      },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true, body: true, direction: true,
            createdAt: true, status: true,
          },
        },
        client: { select: { id: true, name: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
    }).catch(() => [] as any[]),
  ])

  // Normalise team conversations
  const teamThreads = (teamConvs as any[]).map((conv) => {
    const isJobThread = String(conv.type || '') === 'JOB_THREAD'
    const jobContext = [conv.jobNumber, conv.jobTitle].filter(Boolean).join(' — ')
    return {
      id: conv.id,
      kind: 'team' as const,
      channel: 'team' as const,
      title: conv.pinned
        ? 'Team Chat'
        : isJobThread
          ? `Job ${jobContext || 'chat'}`
          : (conv.title || 'Direct Message'),
      subtitle: isJobThread ? (conv.threadTitle || conv.title || 'General') : null as string | null,
      unreadCount: conv.unreadCount || 0,
      lastMessageAt: conv.lastMessageAt ? new Date(conv.lastMessageAt).toISOString() : null,
      preview: conv.lastMessage?.text
        || (conv.lastMessage?.type ? `[${String(conv.lastMessage.type).toLowerCase()}]` : null),
      previewIsOutbound: conv.lastMessage
        ? String(conv.lastMessage.senderId) === String(user.id)
        : undefined,
      pinned: Boolean(conv.pinned),
      convType: String(conv.type || ''),
      jobId: conv.jobId || null,
      jobNumber: conv.jobNumber || null,
      jobTitle: conv.jobTitle || null,
      threadTitle: isJobThread ? (conv.threadTitle || conv.title || 'General') : null,
    }
  })

  // Normalise SMS/MMS conversations
  const smsThreads = (smsConvs as any[]).map((conv) => {
    const parts: string[] = Array.isArray(conv.participants) ? conv.participants : []
    const phoneRaw = parts[0] || ''
    const phoneDisplay = formatPhone(phoneRaw)
    const clientName: string | null = conv.client?.name || null
    const lastMsg = conv.messages?.[0] || null
    return {
      id: conv.id,
      kind: 'sms' as const,
      channel: (conv.channel === 'MMS' ? 'MMS' : 'SMS') as 'SMS' | 'MMS',
      title: clientName || phoneDisplay || conv.id,
      subtitle: clientName ? phoneDisplay : null,
      phone: toE164(phoneRaw),
      phoneDisplay,
      unreadCount: conv.unreadCount || 0,
      lastMessageAt: conv.lastMessageAt ? new Date(conv.lastMessageAt).toISOString() : null,
      preview: lastMsg?.body || null,
      previewIsOutbound: lastMsg ? lastMsg.direction === 'OUTBOUND' : undefined,
      pinned: false,
      convType: String(conv.channel || 'SMS'),
    }
  })

  // Merge and sort: pinned first, then by most-recent message
  const all = [...teamThreads, ...smsThreads].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
    return tb - ta
  })

  return NextResponse.json({ threads: all })
}
