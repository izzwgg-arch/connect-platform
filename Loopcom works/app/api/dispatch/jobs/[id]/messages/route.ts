import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission, requireAnyPermission } from '@/lib/authorization'
import { createNotificationsForUsers, notifyDispatchJobActivity } from '@/lib/notifications'
import { publishDispatchRealtime } from '@/lib/dispatch-realtime'

async function getOrCreateDispatchJobConversation(tenantId: string, jobId: string, userId: string) {
  const existing = await prisma.conversation.findFirst({
    where: {
      tenantId,
      jobId,
      metadata: { path: ['kind'], equals: 'DISPATCH_JOB_CHAT' },
    },
  })

  if (existing) return existing

  return prisma.conversation.create({
    data: {
      tenantId,
      channel: 'EMAIL',
      assignedUserId: userId,
      jobId,
      participants: ['DISPATCH_JOB_CHAT', jobId],
      status: 'ACTIVE',
      metadata: { kind: 'DISPATCH_JOB_CHAT' },
      lastMessageAt: new Date(),
    },
  })
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'dispatch.view')
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const job = await prisma.job.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      select: { id: true },
    })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const conversation = await getOrCreateDispatchJobConversation(user.tenantId, job.id, user.id)
    const full = await prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: {
        messages: {
          include: { media: true },
          orderBy: { createdAt: 'asc' },
          take: 400,
        },
      },
    })

    return NextResponse.json({ conversation: full })
  } catch (error) {
    console.error('Dispatch job messages GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  // Sending a dispatch message is a notify/send action — require the same
  // permissions as the broadcast endpoint, not the read-only dispatch.view.
  const permError = await requireAnyPermission(request, ['dispatch.notify', 'dispatch.assign'])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const text = String(body?.body || '').trim()
    const media = Array.isArray(body?.media) ? body.media : []
    if (!text && media.length === 0) {
      return NextResponse.json({ error: 'Message text or media is required' }, { status: 400 })
    }

    const job = await prisma.job.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      include: {
        assignments: { select: { userId: true } },
      },
    })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const conversation = await getOrCreateDispatchJobConversation(user.tenantId, job.id, user.id)
    const sender = await prisma.user.findUnique({
      where: { id: user.id },
      select: { firstName: true, lastName: true, email: true },
    })
    const senderName = `${sender?.firstName || ''} ${sender?.lastName || ''}`.trim() || sender?.email || user.email || 'Dispatch'

    const msg = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          tenantId: user.tenantId,
          direction: 'OUTBOUND',
          channel: 'EMAIL',
          body: text || null,
          fromEmail: sender?.email || user.email || 'dispatch@internal',
          toEmail: 'crew@internal',
          provider: 'internal',
          status: 'SENT',
          sentAt: new Date(),
          metadata: {
            source: 'dispatch',
            senderUserId: user.id,
            senderName,
          },
        },
      })

      if (media.length > 0) {
        for (const m of media) {
          await tx.messageMedia.create({
            data: {
              messageId: created.id,
              type: String(m?.type || 'file'),
              url: String(m?.url || ''),
              thumbnailUrl: typeof m?.thumbnailUrl === 'string' ? m.thumbnailUrl : null,
              mimeType: typeof m?.mimeType === 'string' ? m.mimeType : null,
              size: typeof m?.size === 'number' ? m.size : null,
              filename: typeof m?.filename === 'string' ? m.filename : null,
            },
          })
        }
      }

      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      })

      await tx.dispatchEvent.create({
        data: {
          tenantId: user.tenantId,
          jobId: job.id,
          eventType: 'NOTE_ADDED',
          actorUserId: user.id,
          payload: {
            kind: 'dispatch_message',
            messageId: created.id,
            text: text || null,
            hasMedia: media.length > 0,
          },
        },
      })

      return created
    })

    const recipientIds = Array.from(new Set(job.assignments.map((a) => a.userId).filter((id) => id !== user.id)))
    if (recipientIds.length > 0) {
      await createNotificationsForUsers(user.tenantId, recipientIds, {
        type: 'MESSAGE_RECEIVED',
        title: `Dispatch message for ${job.jobNumber}`,
        message: text || 'Dispatch sent an attachment',
        linkType: 'job',
        linkId: job.id,
        linkUrl: `/dashboard/dispatch?jobId=${job.id}`,
        actorUserId: user.id,
        action: 'message_received',
      })
    }

    publishDispatchRealtime(user.tenantId, {
      id: `msg_${msg.id}`,
      kind: 'message',
      ts: new Date().toISOString(),
      jobId: job.id,
      body: text || null,
      payload: { hasMedia: media.length > 0 },
      job: {
        id: job.id,
        jobNumber: job.jobNumber,
        title: job.title,
      },
    })

    await notifyDispatchJobActivity({
      tenantId: user.tenantId,
      jobId: job.id,
      title: `New message on ${job.jobNumber}`,
      message: text || 'Dispatch sent an attachment',
      actorUserId: user.id,
      action: 'message_received',
    })

    return NextResponse.json({ success: true, messageId: msg.id })
  } catch (error) {
    console.error('Dispatch job messages POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

