import crypto from 'crypto'
import { NotificationType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { sendPushToDevices } from '@/lib/services/mobile-push'
import {
  normalizeNotificationPreferences,
  preferenceKeyForNotification,
} from '@/lib/notifications/preferences'
import { sendStaffNotificationEmail } from '@/lib/notifications/email'
import { formatJobStatus } from '@/lib/jobs/statuses'

/** Shared copy for status-change emails/notifications. */
export function formatEntityStatusChangedMessage(params: {
  entityType: string
  entityNumber?: string | null
  entityName: string
  oldStatusLabel: string
  newStatusLabel: string
}) {
  const type = String(params.entityType || 'Item').trim()
  const number = String(params.entityNumber || '').trim() || '—'
  const name = String(params.entityName || '').trim() || '—'
  const from = String(params.oldStatusLabel || '').trim() || '—'
  const to = String(params.newStatusLabel || '').trim() || '—'
  return `Status for ${type} ${number} ${name} has been changed from ${from} to ${to}`
}

export type CreateNotificationResult = {
  ok: boolean
  notificationId?: string
  traceId?: string
  deliveryStatus?: 'QUEUED' | 'SENT' | 'FAILED'
  reason?: string
}

interface CreateNotificationParams {
  tenantId: string
  userId: string
  type: NotificationType
  title: string
  message?: string | null
  linkUrl?: string | null
  linkType?: string | null
  linkId?: string | null
  requiresAck?: boolean
  actorUserId?: string | null
  dedupeKey?: string | null
  action?: string | null
}

function makeTraceId() {
  return crypto.randomUUID()
}

function makeDedupeKey(params: {
  tenantId: string
  userId: string
  type: NotificationType
  entityId?: string | null
  action?: string | null
}) {
  const bucket = Math.floor(Date.now() / (1000 * 30)) // 30s bucket
  return `${params.tenantId}:${params.userId}:${params.type}:${params.entityId || 'none'}:${params.action || 'update'}:${bucket}`
}

function buildMobileDeepLink(linkType?: string | null, linkId?: string | null): string | undefined {
  if (!linkType || !linkId) return undefined
  if (linkType === 'job') return `trimpro://jobs/${linkId}`
  if (linkType === 'task') return `trimpro://tasks/${linkId}`
  if (linkType === 'issue') return `trimpro://issues/${linkId}`
  if (linkType === 'request' || linkType === 'lead') return `trimpro://requests/${linkId}`
  if (linkType === 'message' || linkType === 'conversation') return `trimpro://messages/${linkId}`
  if (linkType === 'schedule') return 'trimpro://schedule'
  return undefined
}

async function shouldCollapseByRateLimit(tenantId: string, userId: string) {
  const oneMinuteAgo = new Date(Date.now() - 60_000)
  const count = await prisma.notification.count({
    where: {
      tenantId,
      userId,
      createdAt: { gte: oneMinuteAgo },
    },
  })
  return count >= 20
}

async function createAndSendNotification(params: CreateNotificationParams): Promise<CreateNotificationResult> {
  const preferenceKey = preferenceKeyForNotification(params.type, params.linkType)
  const user = await prisma.user.findFirst({
    where: { id: params.userId, tenantId: params.tenantId },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      notificationPreferences: true,
    },
  })
  const prefs = normalizeNotificationPreferences(user?.notificationPreferences)

  if (preferenceKey && !prefs[preferenceKey]) {
    return { ok: true, reason: 'disabled_by_user_preference' }
  }

  const traceId = makeTraceId()
  const deepLink = buildMobileDeepLink(params.linkType, params.linkId)
  const rateLimited = await shouldCollapseByRateLimit(params.tenantId, params.userId)

  const title = rateLimited ? 'You have new updates' : params.title
  const message = rateLimited ? 'Open TrimPro to review your latest updates.' : params.message || null
  const dedupeKey =
    params.dedupeKey ||
    makeDedupeKey({
      tenantId: params.tenantId,
      userId: params.userId,
      type: params.type,
      entityId: params.linkId,
      action: params.action,
    })

  let notification = null as any
  try {
    notification = await prisma.notification.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        type: params.type,
        title,
        message,
        linkUrl: params.linkUrl || null,
        linkType: params.linkType || null,
        linkId: params.linkId || null,
        requiresAck: params.requiresAck || false,
        status: 'UNREAD',
        traceId,
        dedupeKey,
        data: {
          entityType: params.linkType || null,
          entityId: params.linkId || null,
          action: params.action || 'update',
          actorUserId: params.actorUserId || null,
          deepLink,
          timestamp: new Date().toISOString(),
          traceId,
        },
        deliveryStatus: 'QUEUED',
      },
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return { ok: true, reason: 'duplicate_event' }
    }
    throw error
  }

  const pushResult = await sendPushToDevices({
    traceId,
    tenantId: params.tenantId,
    recipientUserId: params.userId,
    payload: {
      title,
      body: message || undefined,
      data: {
        notificationId: notification.id,
        linkType: params.linkType || undefined,
        linkId: params.linkId || undefined,
        deepLink,
        traceId,
      },
    },
  })

  let emailError: string | null = null
  if (prefs.emailNotifications === true && user?.email) {
    const emailResult = await sendStaffNotificationEmail({
      tenantId: params.tenantId,
      to: user.email,
      recipientName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || null,
      title,
      message,
      linkUrl: params.linkUrl,
      notificationId: notification.id,
    })
    if (!emailResult.sent) {
      emailError = emailResult.error || 'email_failed'
      console.warn('notification.email_failed', {
        notificationId: notification.id,
        userId: params.userId,
        error: emailError,
      })
    }
  } else if (user?.email && prefs.emailNotifications !== true) {
    console.info('notification.email_skipped', {
      notificationId: notification.id,
      userId: params.userId,
      reason: 'emailNotifications_disabled',
    })
  }

  const deliveryStatus: 'FAILED' | 'SENT' = pushResult.failed > 0 && pushResult.sent === 0 ? 'FAILED' : 'SENT'
  const failureParts = [
    pushResult.failed > 0
      ? `tickets_failed=${pushResult.failed};receipts_failed=${pushResult.receiptErrors.length}`
      : null,
    emailError ? `email_failed=${emailError}` : null,
  ].filter(Boolean)
  const failureReason = failureParts.length ? failureParts.join('|') : null

  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      deliveryStatus,
      sentAt: new Date(),
      failureReason,
    },
  })

  return {
    ok: true,
    notificationId: notification.id,
    traceId,
    deliveryStatus,
    reason: failureReason || undefined,
  }
}

export async function createNotification(params: CreateNotificationParams): Promise<CreateNotificationResult> {
  try {
    return await createAndSendNotification(params)
  } catch (error) {
    console.error('Failed to create notification:', error)
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'create_notification_failed',
    }
  }
}
export async function createNotificationsForUsers(
  tenantId: string,
  userIds: string[],
  params: Omit<CreateNotificationParams, 'tenantId' | 'userId'>
) {
  const recipients = Array.from(new Set(userIds.filter(Boolean)))
  for (const userId of recipients) {
    await createNotification({
      tenantId,
      userId,
      ...params,
      dedupeKey:
        params.dedupeKey ||
        makeDedupeKey({
          tenantId,
          userId,
          type: params.type,
          entityId: params.linkId,
          action: params.action,
        }),
    })
  }
}

function parseNotificationTargetEnv(value: string | undefined) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

const REQUEST_NOTIFICATION_TARGET_NAME_FALLBACKS = [
  { firstName: 'Shia', lastName: 'Weinstock' },
  { firstName: 'Shalomy', lastName: 'Falkowitz' },
]

const PAYMENT_NOTIFICATION_PERMISSION_KEYS = [
  'payments.view',
  'payments.manage',
  'manage_payments',
]

const PAYMENT_NOTIFICATION_ROLES = ['ADMIN', 'ACCOUNTING', 'OFFICE', 'MANAGER'] as const

async function getPaymentNotificationRecipientUserIds(tenantId: string): Promise<string[]> {
  const configuredUserIds = new Set(
    parseNotificationTargetEnv(process.env.PAYMENT_NOTIFICATION_TARGET_USER_IDS)
  )
  const configuredEmails = new Set(
    parseNotificationTargetEnv(process.env.PAYMENT_NOTIFICATION_TARGET_EMAILS).map((email) =>
      email.toLowerCase()
    )
  )

  if (configuredUserIds.size > 0 || configuredEmails.size > 0) {
    const configured = await prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: [
          ...(configuredUserIds.size > 0 ? [{ id: { in: Array.from(configuredUserIds) } }] : []),
          ...(configuredEmails.size > 0
            ? [{ email: { in: Array.from(configuredEmails) } }]
            : []),
        ],
      },
      select: { id: true },
    })
    return configured.map((user) => user.id)
  }

  const users = await prisma.user.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      OR: [
        { role: { in: [...PAYMENT_NOTIFICATION_ROLES] } },
        {
          userRoles: {
            some: {
              role: {
                isActive: true,
                permissions: {
                  some: {
                    permission: {
                      key: { in: PAYMENT_NOTIFICATION_PERMISSION_KEYS },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
    select: { id: true },
  })

  return Array.from(new Set(users.map((user) => user.id)))
}

async function getRequestNotificationRecipientUserIds(tenantId: string) {
  const configuredUserIds = new Set(parseNotificationTargetEnv(process.env.REQUEST_NOTIFICATION_TARGET_USER_IDS))
  const configuredEmails = new Set(
    parseNotificationTargetEnv(process.env.REQUEST_NOTIFICATION_TARGET_EMAILS).map((email) =>
      email.toLowerCase()
    )
  )
  const shouldUseNameFallback = configuredUserIds.size === 0 && configuredEmails.size === 0

  const candidates = await prisma.user.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      OR: [
        ...(configuredUserIds.size > 0 ? [{ id: { in: Array.from(configuredUserIds) } }] : []),
        ...(configuredEmails.size > 0
          ? [{ email: { in: Array.from(configuredEmails) } }]
          : []),
        ...(shouldUseNameFallback
          ? REQUEST_NOTIFICATION_TARGET_NAME_FALLBACKS.map((target) => ({
              firstName: { equals: target.firstName, mode: 'insensitive' as const },
              lastName: { equals: target.lastName, mode: 'insensitive' as const },
            }))
          : []),
      ],
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  })

  return candidates
    .filter((candidate) => {
      if (configuredUserIds.has(candidate.id)) return true
      if (candidate.email && configuredEmails.has(candidate.email.toLowerCase())) return true
      if (!shouldUseNameFallback) return false
      return REQUEST_NOTIFICATION_TARGET_NAME_FALLBACKS.some(
        (target) =>
          candidate.firstName.trim().toLowerCase() === target.firstName.toLowerCase() &&
          candidate.lastName.trim().toLowerCase() === target.lastName.toLowerCase()
      )
    })
    .map((candidate) => candidate.id)
}

/**
 * Notify assigned users about job activity (status, notes, media, messages).
 * If the job has no assignees, nobody is notified.
 */
export async function notifyDispatchJobActivity(params: {
  tenantId: string
  jobId: string
  title: string
  message?: string | null
  excludeUserId?: string | null
  actorUserId?: string | null
  action?: string | null
}) {
  const assignments = await prisma.jobAssignment.findMany({
    where: { jobId: params.jobId },
    select: { userId: true },
  })
  const recipientIds = assignments
    .map((a) => a.userId)
    .filter((id) => Boolean(id) && id !== params.excludeUserId)

  if (recipientIds.length === 0) return

  await createNotificationsForUsers(params.tenantId, recipientIds, {
    type: 'JOB_UPDATED',
    title: params.title,
    message: params.message || null,
    linkUrl: `/dashboard/jobs/${params.jobId}`,
    linkType: 'job',
    linkId: params.jobId,
    actorUserId: params.actorUserId || null,
    action: params.action || 'job_updated',
  })
}

/**
 * Notify assigned users when a job status changes.
 * If the job has no assignees, nobody is notified (including office/admin).
 */
export async function notifyJobStatusChanged(params: {
  tenantId: string
  jobId: string
  jobNumber?: string | null
  jobTitle: string
  oldStatus: string
  newStatus: string
  actorUserId?: string | null
}) {
  const fromLabel = formatJobStatus(params.oldStatus)
  const toLabel = formatJobStatus(params.newStatus)
  const message = formatEntityStatusChangedMessage({
    entityType: 'Job',
    entityNumber: params.jobNumber,
    entityName: params.jobTitle,
    oldStatusLabel: fromLabel,
    newStatusLabel: toLabel,
  })

  const assignments = await prisma.jobAssignment.findMany({
    where: { jobId: params.jobId },
    select: { userId: true },
  })
  const recipientIds = Array.from(
    new Set(assignments.map((a) => a.userId).filter(Boolean))
  )

  // No assignees → no notifications / emails.
  if (recipientIds.length === 0) return

  await createNotificationsForUsers(params.tenantId, recipientIds, {
    type: 'JOB_UPDATED',
    title: 'Job Update',
    message,
    linkUrl: `/dashboard/jobs/${params.jobId}`,
    linkType: 'job',
    linkId: params.jobId,
    actorUserId: params.actorUserId || null,
    action: 'status_changed',
  })
}

/**
 * Notify when a job is assigned to a tech
 */
export async function notifyJobAssigned(
  tenantId: string,
  techUserId: string,
  jobId: string,
  jobTitle: string
) {
  await createNotification({
    tenantId,
    userId: techUserId,
    type: 'JOB_ASSIGNED',
    title: 'New Job Assigned',
    message: `You have been assigned to job: ${jobTitle}`,
    linkUrl: `/dashboard/jobs/${jobId}`,
    linkType: 'job',
    linkId: jobId,
    action: 'job_assigned',
  })
}

/**
 * Notify when an invoice is paid
 */
export async function notifyInvoicePaid(
  tenantId: string,
  invoiceId: string,
  invoiceNumber: string,
  amount: number,
  clientName: string,
  options?: {
    paymentMethod?: 'ACH' | 'CARD' | 'OTHER' | string
    providerPaymentId?: string | null
    dedupeKey?: string | null
  }
) {
  const recipientIds = new Set(await getPaymentNotificationRecipientUserIds(tenantId))

  // Also notify techs assigned to the related job (user toggle: paymentReceived).
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: {
      jobId: true,
      job: {
        select: {
          assignments: { select: { userId: true } },
        },
      },
    },
  })
  for (const row of invoice?.job?.assignments || []) {
    if (row.userId) recipientIds.add(row.userId)
  }

  if (recipientIds.size === 0) return

  const methodLabel =
    options?.paymentMethod === 'ACH'
      ? 'ACH'
      : options?.paymentMethod === 'CARD'
        ? 'card'
        : options?.paymentMethod
          ? String(options.paymentMethod)
          : 'payment'

  const amountText = amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  const dedupeKey =
    options?.dedupeKey ||
    `payment-received:${tenantId}:${invoiceId}:${options?.providerPaymentId || invoiceNumber}`

  await createNotificationsForUsers(tenantId, Array.from(recipientIds), {
    type: 'PAYMENT_RECEIVED',
    title: 'Payment Received',
    message: `${clientName} paid ${amountText} via ${methodLabel} for invoice ${invoiceNumber}`,
    linkUrl: `/dashboard/invoices/${invoiceId}`,
    linkType: 'invoice',
    linkId: invoiceId,
    requiresAck: true,
    action: 'payment_received',
    dedupeKey,
  })
}

/**
 * Notify when an invoice is overdue
 */
export async function notifyInvoiceOverdue(
  tenantId: string,
  invoiceId: string,
  invoiceNumber: string,
  clientName: string,
  daysOverdue: number
) {
  // Notify accounting users and admins
  const accountingUsers = await prisma.user.findMany({
    where: {
      tenantId,
      role: { in: ['ADMIN', 'ACCOUNTING', 'OFFICE'] },
      status: 'ACTIVE',
    },
    select: { id: true },
  })

  if (accountingUsers.length > 0) {
    await createNotificationsForUsers(tenantId, accountingUsers.map((u) => u.id), {
      type: 'INVOICE_OVERDUE',
      title: 'Invoice Overdue',
      message: `Invoice ${invoiceNumber} for ${clientName} is ${daysOverdue} days overdue`,
      linkUrl: `/dashboard/invoices/${invoiceId}`,
      linkType: 'invoice',
      linkId: invoiceId,
    })
  }
}

/**
 * Notify when a new request is created.
 */
export async function notifyRequestCreated(
  tenantId: string,
  requestId: string,
  requestName: string
) {
  const recipientUserIds = await getRequestNotificationRecipientUserIds(tenantId)

  if (recipientUserIds.length > 0) {
    await createNotificationsForUsers(tenantId, recipientUserIds, {
      type: 'OTHER',
      title: 'New Request Created',
      message: `New request: ${requestName}`,
      linkUrl: `/dashboard/requests/${requestId}`,
      linkType: 'request',
      linkId: requestId,
      action: 'request_created',
    })
  }
}

/**
 * Notify creator + assignee when a request status changes.
 */
export async function notifyRequestStatusChanged(params: {
  tenantId: string
  requestId: string
  requestName: string
  oldStatus: string
  newStatus: string
  createdById?: string | null
  assignedToId?: string | null
  actorUserId?: string | null
}) {
  const recipients = new Set<string>()
  if (params.createdById) recipients.add(params.createdById)
  if (params.assignedToId) recipients.add(params.assignedToId)
  if (params.actorUserId) recipients.delete(params.actorUserId)
  if (recipients.size === 0) return

  const oldLabel = String(params.oldStatus || '').replace(/_/g, ' ')
  const newLabel = String(params.newStatus || '').replace(/_/g, ' ')

  await createNotificationsForUsers(params.tenantId, Array.from(recipients), {
    type: 'OTHER',
    title: 'Request Status Updated',
    message: `${params.requestName}: ${oldLabel} → ${newLabel}`,
    linkUrl: `/dashboard/requests/${params.requestId}`,
    linkType: 'request',
    linkId: params.requestId,
    action: 'request_status_changed',
    actorUserId: params.actorUserId || null,
  })
}

/**
 * Notify when a task is assigned
 */
export async function notifyTaskAssigned(
  tenantId: string,
  userId: string,
  taskId: string,
  taskTitle: string
) {
  await createNotification({
    tenantId,
    userId,
    type: 'TASK_ASSIGNED',
    title: 'New Task Assigned',
    message: `You have been assigned a task: ${taskTitle}`,
    linkUrl: `/dashboard/tasks/${taskId}`,
    linkType: 'task',
    linkId: taskId,
      action: 'task_assigned',
  })
}

/**
 * Notify when a task is overdue
 */
export async function notifyTaskOverdue(
  tenantId: string,
  userId: string,
  taskId: string,
  taskTitle: string
) {
  await createNotification({
    tenantId,
    userId,
    type: 'TASK_OVERDUE',
    title: 'Task Overdue',
    message: `Task "${taskTitle}" is overdue`,
    linkUrl: `/dashboard/tasks/${taskId}`,
    linkType: 'task',
    linkId: taskId,
  })
}

/**
 * Notify when an issue is assigned
 */
export async function notifyIssueAssigned(
  tenantId: string,
  userId: string,
  issueId: string,
  issueTitle: string
) {
  await createNotification({
    tenantId,
    userId,
    type: 'ISSUE_ASSIGNED',
    title: 'Issue Assigned',
    message: `You have been assigned an issue: ${issueTitle}`,
    linkUrl: `/dashboard/issues/${issueId}`,
    linkType: 'issue',
    linkId: issueId,
    action: 'issue_assigned',
  })
}
