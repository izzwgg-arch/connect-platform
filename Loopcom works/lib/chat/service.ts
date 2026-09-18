import {
  ChatAttachmentKind,
  ChatConversationType,
  ChatDeliveryStatus,
  ChatMessageType,
  NotificationType,
} from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createNotificationsForUsers } from '@/lib/notifications'

type AuthLikeUser = {
  id: string
  tenantId: string
  email?: string
  firstName?: string
  lastName?: string
}

type SendAttachmentInput = {
  kind: ChatAttachmentKind
  url: string
  fileName?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  durationMs?: number | null
  thumbnailUrl?: string | null
  latitude?: number | null
  longitude?: number | null
}

type SendMessageInput = {
  text?: string | null
  type?: ChatMessageType
  attachments?: SendAttachmentInput[]
  clientTempId?: string | null
  jobId?: string | null
  replyToMessageId?: string | null
  replyToSenderName?: string | null
  replyToText?: string | null
  replyToType?: ChatMessageType | null
  /** When set, only these member userIds (excluding sender) are notified. */
  notifyUserIds?: string[] | null
}

function normalizeDmPair(userIdA: string, userIdB: string) {
  return userIdA < userIdB ? { userAId: userIdA, userBId: userIdB } : { userAId: userIdB, userBId: userIdA }
}

function displayName(user: { firstName: string | null; lastName: string | null; email: string }) {
  const full = `${user.firstName || ''} ${user.lastName || ''}`.trim()
  return full || user.email
}

export async function ensureTeamConversation(tenantId: string) {
  let conversation = await prisma.chatConversation.findFirst({
    where: { tenantId, type: ChatConversationType.TEAM },
    orderBy: { createdAt: 'asc' },
  })

  if (!conversation) {
    conversation = await prisma.chatConversation.create({
      data: {
        tenantId,
        type: ChatConversationType.TEAM,
        title: 'Team Chat',
        pinned: true,
      },
    })
  }

  return conversation
}

export async function ensureTeamConversationMembers(tenantId: string) {
  const teamConversation = await ensureTeamConversation(tenantId)
  const users = await prisma.user.findMany({
    where: { tenantId, status: 'ACTIVE' },
    select: { id: true },
    take: 500,
  })

  if (users.length > 0) {
    await prisma.chatConversationMember.createMany({
      data: users.map((u) => ({
        tenantId,
        conversationId: teamConversation.id,
        userId: u.id,
      })),
      skipDuplicates: true,
    })
  }

  return teamConversation
}

export async function createOrGetDmConversation(tenantId: string, currentUserId: string, targetUserId: string) {
  if (currentUserId === targetUserId) {
    throw new Error('You cannot create a direct message with yourself')
  }

  const [currentUser, targetUser] = await Promise.all([
    prisma.user.findFirst({
      where: { id: currentUserId, tenantId, status: 'ACTIVE' },
      select: { id: true },
    }),
    prisma.user.findFirst({
      where: { id: targetUserId, tenantId, status: 'ACTIVE' },
      select: { id: true },
    }),
  ])

  if (!currentUser || !targetUser) {
    throw new Error('User not found in your tenant')
  }

  const pair = normalizeDmPair(currentUserId, targetUserId)
  let conversation = await prisma.chatConversation.findFirst({
    where: {
      tenantId,
      type: ChatConversationType.DM,
      userAId: pair.userAId,
      userBId: pair.userBId,
    },
  })

  if (!conversation) {
    conversation = await prisma.chatConversation.create({
      data: {
        tenantId,
        type: ChatConversationType.DM,
        userAId: pair.userAId,
        userBId: pair.userBId,
      },
    })
  }

  await prisma.chatConversationMember.createMany({
    data: [
      { tenantId, conversationId: conversation.id, userId: currentUserId },
      { tenantId, conversationId: conversation.id, userId: targetUserId },
    ],
    skipDuplicates: true,
  })

  return conversation
}

const JOB_THREAD_MEMBER_CAP = 100

export type JobThreadRecipient = {
  id: string
  firstName: string | null
  lastName: string | null
  email: string
  role: string
  isAssignee: boolean
}

/**
 * Assignees + active ADMIN/OFFICE users eligible for a job thread.
 */
export async function listJobThreadRecipients(
  tenantId: string,
  jobId: string
): Promise<JobThreadRecipient[]> {
  const job = await prisma.job.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true },
  })
  if (!job) throw new Error('Job not found')

  const [assignments, staff] = await Promise.all([
    prisma.jobAssignment.findMany({
      where: { jobId },
      select: {
        userId: true,
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, role: true, status: true },
        },
      },
    }),
    prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE', role: { in: ['ADMIN', 'OFFICE'] } },
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
      take: JOB_THREAD_MEMBER_CAP,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    }),
  ])

  const byId = new Map<string, JobThreadRecipient>()
  for (const a of assignments) {
    if (!a.user || a.user.status !== 'ACTIVE') continue
    byId.set(a.user.id, {
      id: a.user.id,
      firstName: a.user.firstName,
      lastName: a.user.lastName,
      email: a.user.email,
      role: a.user.role,
      isAssignee: true,
    })
  }
  for (const s of staff) {
    const existing = byId.get(s.id)
    if (existing) continue
    byId.set(s.id, {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email,
      role: s.role,
      isAssignee: false,
    })
  }

  return Array.from(byId.values()).sort((a, b) => {
    const an = `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.email
    const bn = `${b.firstName || ''} ${b.lastName || ''}`.trim() || b.email
    return an.localeCompare(bn)
  })
}

/**
 * Find or create a JOB_THREAD conversation for a job.
 * Jobs can have multiple named threads (default title: "General").
 * Members are assignees + ADMIN/OFFICE + actor (+ optional participantIds).
 */
export async function ensureJobThread(
  tenantId: string,
  jobId: string,
  actorUserId: string,
  options?: { participantIds?: string[]; title?: string | null; conversationId?: string | null }
) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true, jobNumber: true, title: true },
  })
  if (!job) {
    throw new Error('Job not found')
  }

  const requestedTitle = typeof options?.title === 'string' ? options.title.trim() : ''
  const title = requestedTitle || 'General'
  const conversationId =
    typeof options?.conversationId === 'string' && options.conversationId
      ? options.conversationId
      : null

  let conversation = conversationId
    ? await prisma.chatConversation.findFirst({
        where: {
          id: conversationId,
          tenantId,
          type: ChatConversationType.JOB_THREAD,
          jobId,
        },
      })
    : null

  if (!conversation) {
    conversation = await prisma.chatConversation.findFirst({
      where: { tenantId, type: ChatConversationType.JOB_THREAD, jobId, title },
      orderBy: { createdAt: 'asc' },
    })
  }

  // Legacy: one unnamed / "Job N" thread from before multi-thread support
  if (!conversation && title === 'General' && !conversationId) {
    conversation = await prisma.chatConversation.findFirst({
      where: { tenantId, type: ChatConversationType.JOB_THREAD, jobId },
      orderBy: { createdAt: 'asc' },
    })
  }

  if (!conversation) {
    conversation = await prisma.chatConversation.create({
      data: {
        tenantId,
        type: ChatConversationType.JOB_THREAD,
        jobId,
        title,
      },
    })
  }

  const [assignments, staff] = await Promise.all([
    prisma.jobAssignment.findMany({
      where: { jobId },
      select: { userId: true },
    }),
    prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE', role: { in: ['ADMIN', 'OFFICE'] } },
      select: { id: true },
      take: JOB_THREAD_MEMBER_CAP,
    }),
  ])

  const extraIds = Array.isArray(options?.participantIds)
    ? options!.participantIds!.filter((id) => typeof id === 'string' && id.length > 0)
    : []

  const memberIds = new Set<string>([
    actorUserId,
    ...assignments.map((a) => a.userId),
    ...staff.map((s) => s.id),
    ...extraIds,
  ])

  if (memberIds.size > 0) {
    await prisma.chatConversationMember.createMany({
      data: Array.from(memberIds).map((userId) => ({
        tenantId,
        conversationId: conversation!.id,
        userId,
      })),
      skipDuplicates: true,
    })
  }

  return conversation
}

export async function listJobThreads(tenantId: string, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true },
  })
  if (!job) throw new Error('Job not found')

  return prisma.chatConversation.findMany({
    where: { tenantId, type: ChatConversationType.JOB_THREAD, jobId },
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      title: true,
      lastMessageAt: true,
      createdAt: true,
    },
  })
}

/**
 * Number of unread messages (created after the member's lastReadAt) in each
 * job's JOB_THREAD conversation, scoped to jobs the user is a member of.
 */
export async function getUnreadJobThreadCounts(
  tenantId: string,
  userId: string,
  jobIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (jobIds.length === 0) return result

  const conversations = await prisma.chatConversation.findMany({
    where: { tenantId, type: ChatConversationType.JOB_THREAD, jobId: { in: jobIds } },
    select: { id: true, jobId: true },
  })
  if (conversations.length === 0) return result

  const conversationIds = conversations.map((c) => c.id)
  const members = await prisma.chatConversationMember.findMany({
    where: { tenantId, userId, conversationId: { in: conversationIds } },
    select: { conversationId: true, lastReadAt: true },
  })
  const memberMap = new Map(members.map((m) => [m.conversationId, m.lastReadAt]))
  const conversationToJob = new Map(conversations.map((c) => [c.id, c.jobId as string]))

  await Promise.all(
    conversationIds.map(async (conversationId) => {
      if (!memberMap.has(conversationId)) return
      const lastReadAt = memberMap.get(conversationId) || new Date(0)
      const count = await prisma.chatMessage.count({
        where: {
          tenantId,
          conversationId,
          createdAt: { gt: lastReadAt },
          senderId: { not: userId },
        },
      })
      const jobId = conversationToJob.get(conversationId)
      if (jobId) result.set(jobId, (result.get(jobId) || 0) + count)
    })
  )

  return result
}

export async function getConversationForMember(tenantId: string, conversationId: string, userId: string) {
  const member = await prisma.chatConversationMember.findFirst({
    where: { tenantId, conversationId, userId },
  })
  if (!member) return null

  return prisma.chatConversation.findFirst({
    where: { id: conversationId, tenantId },
  })
}

export async function markConversationRead(tenantId: string, conversationId: string, userId: string) {
  await prisma.chatConversationMember.updateMany({
    where: { tenantId, conversationId, userId },
    data: { lastReadAt: new Date() },
  })
}

export async function listConversationsForUser(tenantId: string, userId: string) {
  await ensureTeamConversationMembers(tenantId)

  const members = await prisma.chatConversationMember.findMany({
    where: { tenantId, userId },
    take: 200,
  })
  const conversationIds = members.map((m) => m.conversationId)
  const conversations = await prisma.chatConversation.findMany({
    where: { tenantId, id: { in: conversationIds } },
  })
  const conversationMap = new Map(conversations.map((c) => [c.id, c]))

  const lastMessages = await prisma.chatMessage.findMany({
    where: { tenantId, conversationId: { in: conversationIds } },
    orderBy: { createdAt: 'desc' },
    distinct: ['conversationId'],
  })
  const lastMessageMap = new Map(lastMessages.map((m) => [m.conversationId, m]))

  const dmUserIds = new Set<string>()
  const jobIds = new Set<string>()
  for (const m of members) {
    const conversation = conversationMap.get(m.conversationId)
    if (conversation?.type === ChatConversationType.DM) {
      if (conversation.userAId && conversation.userAId !== userId) dmUserIds.add(conversation.userAId)
      if (conversation.userBId && conversation.userBId !== userId) dmUserIds.add(conversation.userBId)
    }
    if (conversation?.type === ChatConversationType.JOB_THREAD && conversation.jobId) {
      jobIds.add(conversation.jobId)
    }
  }

  const [dmUsers, jobs] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: Array.from(dmUserIds) }, tenantId },
      select: { id: true, firstName: true, lastName: true, email: true, avatar: true },
    }),
    prisma.job.findMany({
      where: { id: { in: Array.from(jobIds) }, tenantId },
      select: { id: true, jobNumber: true, title: true },
    }),
  ])
  const dmUserMap = new Map(dmUsers.map((u) => [u.id, u]))
  const jobMap = new Map(jobs.map((job) => [job.id, job]))

  const unreadCounts = await Promise.all(
    members.map(async (member) => {
      const count = await prisma.chatMessage.count({
        where: {
          tenantId,
          conversationId: member.conversationId,
          createdAt: { gt: member.lastReadAt || new Date(0) },
          senderId: { not: userId },
        },
      })
      return [member.conversationId, count] as const
    })
  )
  const unreadMap = new Map(unreadCounts)

  const list = members
    .map((member) => {
      const conversation = conversationMap.get(member.conversationId)
      if (!conversation) return null
      const lastMessage = lastMessageMap.get(conversation.id)
      const isTeam = conversation.type === ChatConversationType.TEAM
      const isJobThread = conversation.type === ChatConversationType.JOB_THREAD
      const otherUserId = conversation.userAId === userId ? conversation.userBId : conversation.userAId
      const otherUser = otherUserId ? dmUserMap.get(otherUserId) : null
      const job = conversation.jobId ? jobMap.get(conversation.jobId) : null
      const threadTitle = isJobThread ? conversation.title?.trim() || 'General' : null
      const title = isTeam
        ? conversation.title || 'Team Chat'
        : isJobThread
          ? threadTitle!
          : otherUser
            ? `${otherUser.firstName || ''} ${otherUser.lastName || ''}`.trim() || otherUser.email
            : 'Direct Message'

      return {
        id: conversation.id,
        type: conversation.type,
        title,
        pinned: isTeam || conversation.pinned,
        jobId: conversation.jobId || null,
        jobNumber: job?.jobNumber || null,
        jobTitle: job?.title || null,
        threadTitle,
        displayTitle: isJobThread
          ? `Job ${job?.jobNumber || 'chat'} · ${threadTitle}`
          : title,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: unreadMap.get(conversation.id) || 0,
        otherUser: otherUser
          ? {
              id: otherUser.id,
              firstName: otherUser.firstName,
              lastName: otherUser.lastName,
              email: otherUser.email,
              avatar: otherUser.avatar,
            }
          : null,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              text: lastMessage.text,
              type: lastMessage.type,
              createdAt: lastMessage.createdAt,
              senderId: lastMessage.senderId,
              status: lastMessage.status,
              jobId: lastMessage.jobId,
              jobNumber: lastMessage.jobNumber,
              jobName: lastMessage.jobName,
            }
          : null,
      }
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))

  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
    return bTime - aTime
  })

  return list
}

export async function listMessages(
  tenantId: string,
  conversationId: string,
  userId: string,
  cursor?: string | null,
  limit = 40
) {
  const conversation = await getConversationForMember(tenantId, conversationId, userId)
  if (!conversation) throw new Error('Conversation not found')

  const messages = await prisma.chatMessage.findMany({
    where: {
      tenantId,
      conversationId,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(limit, 1), 100),
  })

  const messageIds = messages.map((m) => m.id)
  const senderIds = Array.from(new Set(messages.map((m) => m.senderId)))
  const [attachments, senders, reactions] = await Promise.all([
    prisma.chatMessageAttachment.findMany({
      where: { tenantId, messageId: { in: messageIds } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findMany({
      where: { tenantId, id: { in: senderIds } },
      select: { id: true, firstName: true, lastName: true, email: true, avatar: true },
    }),
    prisma.chatMessageReaction.findMany({
      where: { messageId: { in: messageIds } },
      select: { messageId: true, userId: true, emoji: true },
    }),
  ])

  const attachmentMap = new Map<string, any[]>()
  for (const attachment of attachments) {
    if (!attachmentMap.has(attachment.messageId)) attachmentMap.set(attachment.messageId, [])
    attachmentMap.get(attachment.messageId)!.push(attachment)
  }
  const senderMap = new Map(senders.map((s) => [s.id, s]))

  // Build reaction user name map
  const reactionUserIds = [...new Set(reactions.map((r) => r.userId))]
  const reactionUsers = reactionUserIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: reactionUserIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : []
  const reactionUserMap = new Map(reactionUsers.map((u) => [u.id, u]))

  const reactionMap = new Map<string, Array<{ emoji: string; userId: string; userName: string }>>()
  for (const r of reactions) {
    if (!reactionMap.has(r.messageId)) reactionMap.set(r.messageId, [])
    const u = reactionUserMap.get(r.userId)
    const name = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email : 'Unknown'
    reactionMap.get(r.messageId)!.push({ emoji: r.emoji, userId: r.userId, userName: name })
  }

  return messages.map((message) => ({
    ...message,
    sender: senderMap.get(message.senderId) || null,
    replyTo: message.replyToMessageId
      ? {
          messageId: message.replyToMessageId,
          senderName: message.replyToSenderName || 'Unknown',
          textPreview: message.replyToText || '',
          type: message.replyToType || undefined,
          createdAt: null,
        }
      : null,
    attachments: attachmentMap.get(message.id) || [],
    reactions: reactionMap.get(message.id) || [],
  }))
}

function inferMessageType(input: SendMessageInput) {
  if (input.type) return input.type
  if (input.attachments?.some((a) => a.kind === ChatAttachmentKind.VOICE)) return ChatMessageType.VOICE
  if (input.attachments?.some((a) => a.kind === ChatAttachmentKind.LOCATION)) return ChatMessageType.LOCATION
  if ((input.attachments || []).length > 0) return ChatMessageType.MEDIA
  return ChatMessageType.TEXT
}

export async function sendMessageToConversation(
  sender: AuthLikeUser,
  conversationId: string,
  input: SendMessageInput
) {
  const conversation = await getConversationForMember(sender.tenantId, conversationId, sender.id)
  if (!conversation) throw new Error('Conversation not found')

  const trimmedText = typeof input.text === 'string' ? input.text.trim() : ''
  const attachments = input.attachments || []
  if (!trimmedText && attachments.length === 0) {
    throw new Error('Message text or attachment is required')
  }

  let jobStamp: { jobId?: string | null; jobNumber?: string | null; jobName?: string | null } = {}
  if (input.jobId) {
    const job = await prisma.job.findFirst({
      where: { id: input.jobId, tenantId: sender.tenantId },
      select: { id: true, jobNumber: true, title: true },
    })
    if (!job) throw new Error('Job not found')
    jobStamp = { jobId: job.id, jobNumber: job.jobNumber, jobName: job.title }
  }

  const message = await prisma.chatMessage.create({
    data: {
      tenantId: sender.tenantId,
      conversationId,
      senderId: sender.id,
      type: inferMessageType(input),
      text: trimmedText || null,
      clientTempId: input.clientTempId || null,
      status: ChatDeliveryStatus.SENT,
      jobId: jobStamp.jobId || null,
      jobNumber: jobStamp.jobNumber || null,
      jobName: jobStamp.jobName || null,
      replyToMessageId: input.replyToMessageId || null,
      replyToSenderName: input.replyToSenderName || null,
      replyToText: input.replyToText || null,
      replyToType: input.replyToType || null,
    },
  })

  if (attachments.length > 0) {
    await prisma.chatMessageAttachment.createMany({
      data: attachments.map((attachment) => ({
        tenantId: sender.tenantId,
        messageId: message.id,
        kind: attachment.kind,
        url: attachment.url,
        fileName: attachment.fileName || null,
        mimeType: attachment.mimeType || null,
        sizeBytes: attachment.sizeBytes || null,
        durationMs: attachment.durationMs || null,
        thumbnailUrl: attachment.thumbnailUrl || null,
        latitude: attachment.latitude || null,
        longitude: attachment.longitude || null,
      })),
    })
  }

  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: message.createdAt, updatedAt: new Date() },
  })

  const senderProfile = await prisma.user.findFirst({
    where: { id: sender.id, tenantId: sender.tenantId },
    select: { firstName: true, lastName: true, email: true },
  })
  const senderName = senderProfile ? displayName(senderProfile) : sender.email || 'Team member'

  const notifyFilter =
    Array.isArray(input.notifyUserIds) && input.notifyUserIds.length > 0
      ? Array.from(new Set(input.notifyUserIds.filter((id) => id && id !== sender.id)))
      : null

  // Job threads must always target an explicit recipient list — never blast everyone.
  if (conversation.type === ChatConversationType.JOB_THREAD && (!notifyFilter || notifyFilter.length === 0)) {
    throw new Error('Select at least one recipient for this job chat message')
  }

  // Ensure explicitly selected recipients are conversation members (job chat picker).
  if (notifyFilter && notifyFilter.length > 0) {
    await prisma.chatConversationMember.createMany({
      data: notifyFilter.map((userId) => ({
        tenantId: sender.tenantId,
        conversationId,
        userId,
      })),
      skipDuplicates: true,
    })
  }

  const recipientMembers = await prisma.chatConversationMember.findMany({
    where: {
      tenantId: sender.tenantId,
      conversationId,
      userId: {
        not: sender.id,
        ...(notifyFilter
          ? { in: notifyFilter }
          : conversation.type === ChatConversationType.JOB_THREAD
            ? { in: [] }
            : {}),
      },
      OR: [{ mutedUntil: null }, { mutedUntil: { lt: new Date() } }],
    },
    select: { userId: true },
  })

  if (recipientMembers.length > 0) {
    await createNotificationsForUsers(
      sender.tenantId,
      recipientMembers.map((m) => m.userId),
      {
        type: NotificationType.MESSAGE_RECEIVED,
        title: conversation.type === ChatConversationType.TEAM ? 'Team Chat' : `Message from ${senderName}`,
        message:
          trimmedText ||
          (attachments.some((a) => a.kind === ChatAttachmentKind.VOICE)
            ? 'Sent a voice note'
            : attachments.some((a) => a.kind === ChatAttachmentKind.LOCATION)
              ? 'Shared a location'
              : 'Sent an attachment'),
        linkType: 'message',
        linkId: conversationId,
        linkUrl: `/dashboard/messages?conversationId=${conversationId}`,
        actorUserId: sender.id,
        action: 'chat_new_message',
      }
    )
  }

  return message
}

type DeleteMode = 'ME' | 'EVERYONE'

export async function editMessageInConversation(
  actor: AuthLikeUser,
  conversationId: string,
  messageId: string,
  text: string
) {
  const conversation = await getConversationForMember(actor.tenantId, conversationId, actor.id)
  if (!conversation) throw new Error('Conversation not found')

  const nextText = (text || '').trim()
  if (!nextText) throw new Error('Message text is required')

  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, tenantId: actor.tenantId, conversationId },
  })
  if (!message) throw new Error('Message not found')
  if (message.senderId !== actor.id) throw new Error('Only the sender can edit this message')

  return prisma.chatMessage.update({
    where: { id: messageId },
    data: { text: nextText, type: ChatMessageType.TEXT },
  })
}

export async function deleteMessageInConversation(
  actor: AuthLikeUser,
  conversationId: string,
  messageId: string,
  mode: DeleteMode = 'ME'
) {
  const conversation = await getConversationForMember(actor.tenantId, conversationId, actor.id)
  if (!conversation) throw new Error('Conversation not found')

  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, tenantId: actor.tenantId, conversationId },
  })
  if (!message) throw new Error('Message not found')
  if (message.senderId !== actor.id) throw new Error('Only the sender can delete this message')

  // Current schema does not support per-user soft delete state.
  // Treat both modes as a sender-authorized message removal.
  if (mode !== 'ME' && mode !== 'EVERYONE') throw new Error('Invalid delete mode')

  await prisma.$transaction([
    prisma.chatMessageAttachment.deleteMany({
      where: { tenantId: actor.tenantId, messageId },
    }),
    prisma.chatMessage.delete({
      where: { id: messageId },
    }),
  ])
}
