import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { notifyIssueAssigned, createNotificationsForUsers, formatEntityStatusChangedMessage } from '@/lib/notifications'

function formatIssueStatus(status: string): string {
  return String(status || '')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function isMobileRequest(request: NextRequest): boolean {
  const userAgent = request.headers.get('user-agent') || ''
  const isMobileUA = /Mobile|Android|iPhone|iPad/i.test(userAgent)
  const hasMobileParam = request.nextUrl.searchParams.get('mobile') === 'true'
  return isMobileUA || hasMobileParam
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'issues.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const issue = await prisma.issue.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        assignee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        creator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            companyName: true,
          },
        },
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
          },
        },
        watchers: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
        notes: {
          orderBy: { createdAt: 'asc' },
          include: {
            // Note: We'd need to add createdBy relation or get from activities
          },
        },
        tasks: {
          orderBy: { createdAt: 'desc' },
          include: {
            assignee: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        attachments: {
          orderBy: { createdAt: 'desc' },
        },
        emails: {
          orderBy: { sentAt: 'desc' },
          take: 10,
        },
        activities: {
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        _count: {
          select: {
            notes: true,
            tasks: true,
            watchers: true,
          },
        },
      },
    })

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const noteAuthorIds = Array.from(new Set((issue.notes || []).map((note: any) => note.createdById)))
    const noteAuthors = noteAuthorIds.length
      ? await prisma.user.findMany({
          where: {
            tenantId: user.tenantId,
            id: { in: noteAuthorIds },
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        })
      : []
    const noteAuthorMap = new Map(noteAuthors.map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]))

    return NextResponse.json({
      issue: {
        ...issue,
        notes: (issue.notes || []).map((note: any) => ({
          ...note,
          authorName: noteAuthorMap.get(note.createdById) || 'Unknown user',
        })),
      },
    })
  } catch (error) {
    console.error('Get issue error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'issues.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      title,
      description,
      type,
      status,
      priority,
      dueDate,
      scheduledAt,
      assigneeId,
      watchers,
    } = body

    const resolvedDueDate = dueDate ?? scheduledAt

    // Get existing issue
    const existing = await prisma.issue.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    // Track status changes for SLA
    const statusChanged = status && status !== existing.status
    const now = new Date()
    
    let firstResponseAt = existing.firstResponseAt
    let resolvedAt = existing.resolvedAt
    let closedAt = existing.closedAt

    // Set first response time if going from OPEN to anything else
    if (!firstResponseAt && status && status !== 'OPEN' && existing.status === 'OPEN') {
      firstResponseAt = now
    }

    // Set resolved time
    if (status === 'RESOLVED' && existing.status !== 'RESOLVED') {
      resolvedAt = now
    } else if (status !== 'RESOLVED' && existing.status === 'RESOLVED') {
      resolvedAt = null
    }

    // Set closed time
    if (status === 'CLOSED' && existing.status !== 'CLOSED') {
      closedAt = now
    } else if (status !== 'CLOSED' && existing.status === 'CLOSED') {
      closedAt = null
    }

    // Verify assignee if changed
    if (assigneeId && assigneeId !== existing.assigneeId) {
      const assignee = await prisma.user.findFirst({
        where: {
          id: assigneeId,
          tenantId: user.tenantId,
        },
      })

      if (!assignee) {
        return NextResponse.json({ error: 'Assignee not found' }, { status: 404 })
      }

      // Notify new assignee with push notification
      await notifyIssueAssigned(user.tenantId, assigneeId, existing.id, existing.title)
    }

    // Update issue
    const issue = await prisma.issue.update({
      where: { id: params.id },
      data: {
        title: title !== undefined ? title : existing.title,
        description: description !== undefined ? description : existing.description,
        type: type !== undefined ? type : existing.type,
        status: status !== undefined ? status : existing.status,
        priority: priority !== undefined ? priority : existing.priority,
        dueDate:
          resolvedDueDate !== undefined ? (resolvedDueDate ? new Date(resolvedDueDate) : null) : existing.dueDate,
        assigneeId: assigneeId !== undefined ? assigneeId : existing.assigneeId,
        firstResponseAt,
        resolvedAt,
        closedAt,
      },
      include: {
        assignee: true,
        creator: true,
      },
    })

    // Update watchers if provided
    if (watchers && Array.isArray(watchers)) {
      // Get current watchers
      const currentWatchers = await prisma.issueWatcher.findMany({
        where: { issueId: params.id },
      })
      const currentWatcherIds = new Set(currentWatchers.map(w => w.userId))

      // Add new watchers
      for (const watcherId of watchers) {
        if (!currentWatcherIds.has(watcherId)) {
          await prisma.issueWatcher.create({
            data: {
              issueId: params.id,
              userId: watcherId,
            },
          })
        }
      }

      // Remove watchers not in new list
      const newWatcherIds = new Set(watchers)
      for (const watcher of currentWatchers) {
        if (!newWatcherIds.has(watcher.userId)) {
          await prisma.issueWatcher.delete({
            where: { id: watcher.id },
          })
        }
      }
    }

    // Create activity for status change
    if (statusChanged) {
      await prisma.activity.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          type: status === 'RESOLVED' ? 'ISSUE_RESOLVED' : 'ISSUE_CREATED',
          description: `Issue "${issue.title}" ${status === 'RESOLVED' ? 'resolved' : `status changed to ${status}`}`,
          issueId: issue.id,
          clientId: issue.clientId || undefined,
          jobId: issue.jobId || undefined,
        },
      })
    }

    // Notify assignee and watchers about any update (including status changes and other field updates)
    const notifyUserIds: string[] = []
    if (issue.assigneeId) {
      notifyUserIds.push(issue.assigneeId)
    }
    
    // Get watchers from database
    const issueWatchers = await prisma.issueWatcher.findMany({
      where: { issueId: issue.id },
      select: { userId: true },
    })
    for (const watcher of issueWatchers) {
      if (!notifyUserIds.includes(watcher.userId)) {
        notifyUserIds.push(watcher.userId)
      }
    }

    if (notifyUserIds.length > 0) {
      let notificationTitle = 'Issue Updated'
      let notificationMessage = `"${issue.title}" has been updated`

      if (statusChanged) {
        notificationTitle = 'Issue Update'
        notificationMessage = formatEntityStatusChangedMessage({
          entityType: 'Issue',
          entityNumber: issue.id.slice(-8).toUpperCase(),
          entityName: issue.title,
          oldStatusLabel: formatIssueStatus(existing.status),
          newStatusLabel: formatIssueStatus(status),
        })
      }

      await createNotificationsForUsers(user.tenantId, notifyUserIds, {
        type: 'ISSUE_UPDATED',
        title: notificationTitle,
        message: notificationMessage,
        linkType: 'issue',
        linkId: issue.id,
        linkUrl: `/dashboard/issues/${issue.id}`,
        actorUserId: user.id,
        action: statusChanged ? 'status_changed' : 'issue_updated',
      })
    }

    return NextResponse.json({ issue })
  } catch (error) {
    console.error('Update issue error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'issues.delete')
  if (permError) return permError

  const user = getAuthUser(request)
  const isMobile = isMobileRequest(request)

  try {
    const issue = await prisma.issue.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    // Mobile users can delete (cancel) only issues they created themselves.
    if (isMobile && issue.createdById !== user.id) {
      return NextResponse.json(
        { error: 'You can only delete issues that you created' },
        { status: 403 }
      )
    }

    // Update status to cancelled instead of deleting
    await prisma.issue.update({
      where: { id: params.id },
      data: { status: 'CANCELLED' },
    })

    return NextResponse.json({ message: 'Issue cancelled successfully' })
  } catch (error) {
    console.error('Delete issue error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
