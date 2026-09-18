import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { createNotificationsForUsers } from '@/lib/notifications'

type TeamParticipantArray = string[]

async function getOrCreateTeamConversation(tenantId: string, userId: string) {
  const candidates = await prisma.conversation.findMany({
    where: {
      tenantId,
      channel: 'EMAIL',
    },
    select: {
      id: true,
      participants: true,
      status: true,
    },
    orderBy: {
      updatedAt: 'desc',
    },
    take: 100,
  })

  const existing = candidates.find((conv) => {
    const participants = conv.participants as TeamParticipantArray
    return Array.isArray(participants) && participants.includes('TEAM_CHAT')
  })

  if (existing) {
    return prisma.conversation.findUnique({
      where: { id: existing.id },
      include: {
        messages: {
          include: {
            media: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
          take: 200,
        },
      },
    })
  }

  const created = await prisma.conversation.create({
    data: {
      tenantId,
      channel: 'EMAIL',
      assignedUserId: userId,
      participants: ['TEAM_CHAT'],
      status: 'ACTIVE',
      metadata: {
        kind: 'TEAM_CHAT',
      },
      lastMessageAt: new Date(),
    },
  })

  return prisma.conversation.findUnique({
    where: { id: created.id },
    include: {
      messages: {
        include: {
          media: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
        take: 200,
      },
    },
  })
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)

  try {
    const { searchParams } = new URL(request.url)
    const summaryOnly = searchParams.get('summary') === '1'
    const markRead = searchParams.get('markRead') !== '0'

    const conversation = await getOrCreateTeamConversation(user.tenantId, user.id)
    if (!conversation) {
      return NextResponse.json({ error: 'Unable to load team chat' }, { status: 500 })
    }

    const receipt = await prisma.conversationReadReceipt.findUnique({
      where: {
        conversationId_userId: {
          conversationId: conversation.id,
          userId: user.id,
        },
      },
    })

    const unreadMessages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        createdAt: {
          gt: receipt?.readAt || new Date(0),
        },
      },
      select: {
        id: true,
        metadata: true,
      },
    })
    const unreadCount = unreadMessages.filter((message) => {
      const metadata = (message.metadata || {}) as Record<string, any>
      return metadata.senderUserId !== user.id
    }).length

    if (summaryOnly) {
      return NextResponse.json({
        conversationId: conversation.id,
        unreadCount,
        lastMessageAt: conversation.lastMessageAt,
      })
    }

    if (markRead) {
      await prisma.conversationReadReceipt.upsert({
        where: {
          conversationId_userId: {
            conversationId: conversation.id,
            userId: user.id,
          },
        },
        create: {
          conversationId: conversation.id,
          userId: user.id,
          readAt: new Date(),
        },
        update: {
          readAt: new Date(),
        },
      })
    }

    const teamMembers = await prisma.user.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 200,
    })

    return NextResponse.json({ conversation, teamMembers, unreadCount })
  } catch (error) {
    console.error('Mobile team chat GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const messageBody = typeof body?.body === 'string' ? body.body.trim() : ''
    const media = Array.isArray(body?.media) ? body.media : []
    const mentions = Array.isArray(body?.mentions) ? body.mentions.filter((id: any) => typeof id === 'string') : []

    if (!messageBody && media.length === 0) {
      return NextResponse.json({ error: 'Message body or media is required' }, { status: 400 })
    }

    const conversation = await getOrCreateTeamConversation(user.tenantId, user.id)
    if (!conversation) {
      return NextResponse.json({ error: 'Unable to load team conversation' }, { status: 500 })
    }

    const sender = await prisma.user.findUnique({
      where: { id: user.id },
      select: { firstName: true, lastName: true, email: true },
    })

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        tenantId: user.tenantId,
        direction: 'OUTBOUND',
        channel: 'EMAIL',
        body: messageBody || null,
        fromEmail: sender?.email || user.email,
        toEmail: 'team@internal',
        provider: 'internal',
        status: 'SENT',
        sentAt: new Date(),
        metadata: {
          isTeamChat: true,
          senderUserId: user.id,
          senderName: `${sender?.firstName || ''} ${sender?.lastName || ''}`.trim() || user.email,
          mentions,
        },
      },
    })

    if (media.length > 0) {
      await Promise.all(
        media.map((m: any) =>
          prisma.messageMedia.create({
            data: {
              messageId: message.id,
              type: String(m?.type || 'file'),
              url: String(m?.url || ''),
              thumbnailUrl: typeof m?.thumbnailUrl === 'string' ? m.thumbnailUrl : null,
              mimeType: typeof m?.mimeType === 'string' ? m.mimeType : null,
              size: typeof m?.size === 'number' ? m.size : null,
              filename: typeof m?.filename === 'string' ? m.filename : null,
            },
          })
        )
      )
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      },
    })

    const recipients = await prisma.user.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'ACTIVE',
        id: { not: user.id },
      },
      select: { id: true },
      take: 200,
    })

    if (recipients.length > 0) {
      const senderName =
        `${sender?.firstName || ''} ${sender?.lastName || ''}`.trim() || sender?.email || user.email || 'Team member'
      await createNotificationsForUsers(
        user.tenantId,
        recipients.map((r) => r.id),
        {
          type: 'MESSAGE_RECEIVED',
          title: 'Team Chat',
          message: `${senderName}: ${messageBody || (media.length > 0 ? 'sent an attachment' : 'new message')}`,
          linkType: 'message',
          linkId: conversation.id,
          linkUrl: `/dashboard/messages?conversationId=${conversation.id}`,
          actorUserId: user.id,
          action: 'message_received',
        }
      )
    }

    return NextResponse.json({ success: true, messageId: message.id, conversationId: conversation.id })
  } catch (error) {
    console.error('Mobile team chat POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

