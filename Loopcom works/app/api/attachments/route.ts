import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { createNotificationsForUsers, notifyDispatchJobActivity } from '@/lib/notifications'
import { publishDispatchRealtime } from '@/lib/dispatch-realtime'
import { hasMobilePermission, isMobileRequest, requireAnyPermission } from '@/lib/authorization'
import { normalizePublicFileUrl } from '@/lib/public-url'

type EntityType = 'estimate' | 'invoice' | 'purchase_order' | 'job' | 'task' | 'issue' | 'request' | 'lead'

function isValidEntityType(value: string): value is EntityType {
  return (
    value === 'estimate' ||
    value === 'invoice' ||
    value === 'purchase_order' ||
    value === 'job' ||
    value === 'task' ||
    value === 'issue' ||
    value === 'request' ||
    value === 'lead'
  )
}

async function ensureEntityAccess(
  entityType: EntityType,
  entityId: string,
  tenantId: string,
  options?: { enforceAssignedJobScope?: boolean; userId?: string }
) {
  if (entityType === 'estimate') {
    const estimate = await prisma.estimate.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
    return Boolean(estimate)
  }
  if (entityType === 'invoice') {
    const invoice = await prisma.invoice.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
    return Boolean(invoice)
  }
  if (entityType === 'purchase_order') {
    const purchaseOrder = await prisma.purchaseOrder.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
    return Boolean(purchaseOrder)
  }
  if (entityType === 'task') {
    const task = await prisma.task.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
    return Boolean(task)
  }
  if (entityType === 'issue') {
    const issue = await prisma.issue.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
    return Boolean(issue)
  }
  if (entityType === 'request' || entityType === 'lead') {
    const lead = await prisma.lead.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
    return Boolean(lead)
  }
  if (!options?.enforceAssignedJobScope || !options.userId) {
    const job = await prisma.job.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
    return Boolean(job)
  }
  const job = await prisma.job.findFirst({
    where: {
      id: entityId,
      tenantId,
      assignments: {
        some: { userId: options.userId },
      },
    },
    select: { id: true },
  })
  return Boolean(job)
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['jobs.view', 'leads.view', 'clients.view', 'purchase_orders.view'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const entityTypeRaw = request.nextUrl.searchParams.get('entityType') || ''
    const entityId = request.nextUrl.searchParams.get('entityId') || ''
    if (!isValidEntityType(entityTypeRaw) || !entityId) {
      return NextResponse.json({ error: 'entityType and entityId are required' }, { status: 400 })
    }

    const mobileRequest = isMobileRequest(request)
    const canViewAllJobs = mobileRequest
      ? await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.view_all')
      : true
    const hasAccess = await ensureEntityAccess(entityTypeRaw, entityId, user.tenantId, {
      enforceAssignedJobScope: entityTypeRaw === 'job' && mobileRequest && !canViewAllJobs,
      userId: user.id,
    })
    if (!hasAccess) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const where =
      entityTypeRaw === 'estimate'
        ? { estimateId: entityId }
        : entityTypeRaw === 'invoice'
          ? { invoiceId: entityId }
          : entityTypeRaw === 'purchase_order'
            ? { purchaseOrderId: entityId }
          : entityTypeRaw === 'task'
            ? { taskId: entityId }
            : entityTypeRaw === 'issue'
              ? { issueId: entityId }
              : entityTypeRaw === 'request' || entityTypeRaw === 'lead'
                ? { leadId: entityId }
                : { jobId: entityId }

    const rawAttachments = await prisma.attachment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    const attachments = rawAttachments.map((item) => ({
      ...item,
      url: normalizePublicFileUrl(item.url, request),
    }))

    return NextResponse.json({ attachments })
  } catch (error) {
    console.error('List attachments error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['jobs.view', 'leads.view', 'clients.view', 'purchase_orders.view'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const body = await request.json()
    const entityTypeRaw = String(body?.entityType || '')
    const entityId = String(body?.entityId || '')
    const fileName = String(body?.fileName || '')
    const url = String(body?.url || '')
    const mimeType = String(body?.mimeType || 'application/octet-stream')
    const fileSize = Number(body?.fileSize || 0)
    const key = String(body?.key || url)
    const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : null

    if (!isValidEntityType(entityTypeRaw) || !entityId || !fileName || !url || !key || !fileSize) {
      return NextResponse.json({ error: 'Missing required attachment fields' }, { status: 400 })
    }

    const mobileRequest = isMobileRequest(request)
    const canViewAllJobs = mobileRequest
      ? await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.view_all')
      : true
    const hasAccess = await ensureEntityAccess(entityTypeRaw, entityId, user.tenantId, {
      enforceAssignedJobScope: entityTypeRaw === 'job' && mobileRequest && !canViewAllJobs,
      userId: user.id,
    })
    if (!hasAccess) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const normalizedUrl = normalizePublicFileUrl(url, request)

    const data =
      entityTypeRaw === 'estimate'
        ? { estimateId: entityId }
        : entityTypeRaw === 'invoice'
          ? { invoiceId: entityId }
          : entityTypeRaw === 'purchase_order'
            ? { purchaseOrderId: entityId }
          : entityTypeRaw === 'task'
            ? { taskId: entityId }
            : entityTypeRaw === 'issue'
              ? { issueId: entityId }
              : entityTypeRaw === 'request' || entityTypeRaw === 'lead'
                ? { leadId: entityId }
                : { jobId: entityId }

    const attachment = await prisma.attachment.create({
      data: {
        ...data,
        fileName,
        url: normalizedUrl,
        key,
        mimeType,
        fileSize,
        uploadedById: user.id,
      },
    })

    if (entityTypeRaw === 'request' || entityTypeRaw === 'lead') {
      const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
      await Promise.all([
        prisma.activity.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            type: 'OTHER',
            description: `REQUEST_ATTACHMENT_ADDED: ${fileName}`,
            leadId: entityId,
          },
        }),
        prisma.auditLog.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            action: 'CREATE',
            entityType: 'RequestAttachment',
            entityId: attachment.id,
            ipAddress,
            userAgent: request.headers.get('user-agent') || undefined,
            changes: {
              requestId: entityId,
              fileName,
              fileSize,
              mimeType,
              url,
              key,
            },
          },
        }),
      ])
    }

    // If attachment is for a job, also attach it to any linked invoices
    if (entityTypeRaw === 'job') {
      try {
        const linkedInvoices = await prisma.invoice.findMany({
          where: {
            jobId: entityId,
            tenantId: user.tenantId,
          },
          select: { id: true },
        })

        // Create duplicate attachments for each linked invoice
        if (linkedInvoices.length > 0) {
          await Promise.all(
            linkedInvoices.map((invoice) =>
              prisma.attachment.create({
                data: {
                  invoiceId: invoice.id,
                  fileName,
                  url: normalizedUrl,
                  key,
                  mimeType,
                  fileSize,
                  uploadedById: user.id,
                },
              })
            )
          )
          console.log(`[Attachment] Also attached to ${linkedInvoices.length} invoice(s) linked to job ${entityId}`)
        }
      } catch (invoiceAttachError) {
        console.error('[Attachment] Failed to attach to linked invoices:', invoiceAttachError)
        // Don't fail the main attachment creation if invoice attachment fails
      }
    }

    if (entityTypeRaw === 'job') {
      try {
        console.log('[Attachment] Processing job attachment notification for jobId:', entityId, 'userId:', user.id)
        const [job, uploader] = await Promise.all([
          prisma.job.findFirst({
            where: { id: entityId, tenantId: user.tenantId },
            include: {
              assignments: { select: { userId: true } },
            },
          }),
          prisma.user.findUnique({
            where: { id: user.id },
            select: { firstName: true, lastName: true, email: true },
          }),
        ])

        if (job) {
          console.log('[Attachment] Job found:', job.jobNumber, 'Assignments:', job.assignments.length)
          const mediaKind = attachment.mimeType.startsWith('image/')
            ? 'photo'
            : attachment.mimeType.startsWith('video/')
            ? 'video'
            : 'file'

          // Helper to clean up filename - remove UUIDs and show friendly text
          const getCleanFileDescription = (fileName: string, mimeType: string): string => {
            // Check if filename looks like a UUID (contains 8-4-4-4-12 pattern)
            const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
            // Also check for numeric-only filenames (like "1000073388.jpg")
            const numericOnlyPattern = /^[0-9]+\.[a-z]{3,4}$/i
            
            if (uuidPattern.test(fileName) || numericOnlyPattern.test(fileName)) {
              // It's a UUID or numeric filename, return friendly description based on mime type
              if (mimeType.startsWith('image/')) return 'a photo'
              if (mimeType.startsWith('video/')) return 'a video'
              return 'a file'
            }
            // Not a UUID/numeric, return the filename (but maybe truncate if too long)
            return fileName.length > 30 ? fileName.substring(0, 27) + '...' : fileName
          }

          // Build actor name with proper fallbacks
          let actorName = 'A team member'
          if (uploader) {
            const fullName = `${uploader.firstName || ''} ${uploader.lastName || ''}`.trim()
            actorName = fullName || uploader.email || user.email || 'A team member'
          } else if (user.email) {
            actorName = user.email
          }

          await prisma.dispatchEvent.create({
            data: {
              tenantId: user.tenantId,
              jobId: entityId,
              eventType: 'NOTE_ADDED',
              actorUserId: user.id,
              payload: {
                kind: 'media_uploaded',
                attachmentId: attachment.id,
                fileName: attachment.fileName,
                mimeType: attachment.mimeType,
                fileSize: attachment.fileSize,
                metadata,
              },
            },
          })

          publishDispatchRealtime(user.tenantId, {
            id: `att_${attachment.id}`,
            kind: mediaKind,
            ts: attachment.createdAt.toISOString(),
            jobId: entityId,
            attachment: {
              id: attachment.id,
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              url: attachment.url,
              fileSize: attachment.fileSize,
            },
            payload: { metadata },
            job: {
              id: job.id,
              jobNumber: job.jobNumber,
              title: job.title,
            },
          })

          const cleanFileDesc = getCleanFileDescription(attachment.fileName, attachment.mimeType)
          const jobDisplayName = (job.title || job.jobNumber || 'Job').trim()
          const jobNumber = job.jobNumber || 'Unknown'

          const recipientIds = Array.from(new Set(job.assignments.map((a) => a.userId).filter((id) => id !== user.id)))
          console.log('[Attachment] Recipient IDs for assigned users:', recipientIds.length, recipientIds)
          
          if (recipientIds.length > 0) {
            try {
              console.log('[Attachment] Creating notifications for assigned users:', recipientIds)
              await createNotificationsForUsers(user.tenantId, recipientIds, {
                type: 'JOB_MEDIA_ADDED',
                title: `${actorName} uploaded ${cleanFileDesc}`,
                message: `${jobDisplayName} (${jobNumber})`,
                linkType: 'job',
                linkId: job.id,
                linkUrl: `/dashboard/dispatch?jobId=${job.id}`,
                actorUserId: user.id,
                action: 'media_uploaded',
              })
              console.log('[Attachment] Successfully created notifications for assigned users')
            } catch (notifError) {
              console.error('[Attachment] Failed to create notifications for assigned users:', notifError)
            }
          }

          try {
            console.log('[Attachment] Creating dispatch notifications, actorName:', actorName, 'cleanFileDesc:', cleanFileDesc)
            // Don't exclude the uploader - they should see their own uploads too
            await notifyDispatchJobActivity({
              tenantId: user.tenantId,
              jobId: job.id,
              title: `${actorName} uploaded ${cleanFileDesc}`,
              message: `${jobDisplayName} (${jobNumber})`,
              excludeUserId: null, // Include uploader so they see their own uploads
              actorUserId: user.id,
              action: 'media_uploaded',
            })
            console.log('[Attachment] Successfully created dispatch notifications')
          } catch (dispatchNotifError) {
            console.error('[Attachment] Failed to create dispatch notifications:', dispatchNotifError)
          }
        } else {
          console.log('[Attachment] Job not found for entityId:', entityId, 'tenantId:', user.tenantId)
        }
      } catch (error) {
        console.error('Attachment dispatch fanout error:', error)
      }
    }

    return NextResponse.json({ attachment }, { status: 201 })
  } catch (error) {
    console.error('Create attachment error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
