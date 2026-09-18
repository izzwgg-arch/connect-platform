import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { notifyIssueAssigned } from '@/lib/notifications'
import { hasMobilePermission, requireMobilePermission, requirePermission } from '@/lib/authorization'
import { applySmartSearch, buildSmartSearchAnd, clientIdentityClauses, ilike } from '@/lib/search/prisma-filters'

// Helper to detect if request is from mobile app
function isMobileRequest(request: NextRequest): boolean {
  const userAgent = request.headers.get('user-agent') || ''
  const isMobileUA = /Mobile|Android|iPhone|iPad/i.test(userAgent)
  const hasMobileParam = request.nextUrl.searchParams.get('mobile') === 'true'
  return isMobileUA || hasMobileParam
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'issues.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || 'all'
  const type = searchParams.get('type') || 'all'
  const assigneeId = searchParams.get('assigneeId') || ''
  const scheduledFrom = searchParams.get('scheduledFrom')
  const scheduledTo = searchParams.get('scheduledTo')
  const filter = searchParams.get('filter') || 'all' // all, my, assigned, watched
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const skip = (page - 1) * limit

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { title: ilike(term) },
        { description: ilike(term) },
        ...clientIdentityClauses(term),
        { job: { jobNumber: ilike(term) } },
        { job: { title: ilike(term) } },
        { assignee: { firstName: ilike(term) } },
        { assignee: { lastName: ilike(term) } },
      ])
    )

    if (status !== 'all') {
      where.status = status
    }

    if (type !== 'all') {
      where.type = type
    }

    if (assigneeId) {
      where.assigneeId = assigneeId
    }

    if (scheduledFrom || scheduledTo) {
      where.dueDate = {
        ...(scheduledFrom ? { gte: new Date(scheduledFrom) } : {}),
        ...(scheduledTo ? { lte: new Date(scheduledTo) } : {}),
      }
    }

    // Filter: my issues (created by me), assigned to me, watched, or assigned/created combined.
    if (filter === 'my') {
      where.createdById = user.id
    } else if (filter === 'assigned') {
      where.assigneeId = user.id
    } else if (filter === 'assigned_or_created') {
      where.AND = where.AND || []
      where.AND.push({
        OR: [
          { assigneeId: user.id },
          { createdById: user.id },
        ],
      })
    } else if (filter === 'watched') {
      where.watchers = {
        some: {
          userId: user.id,
        },
      }
    }

    const [issues, total] = await Promise.all([
      prisma.issue.findMany({
        where,
        include: {
          assignee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
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
                },
              },
            },
          },
          _count: {
            select: {
              notes: true,
              tasks: true,
            },
          },
        },
        orderBy: [
          { priority: 'desc' },
          { dueDate: 'asc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: limit,
      }),
      prisma.issue.count({ where }),
    ])

    return NextResponse.json({
      issues,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get issues error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)
  const isMobile = isMobileRequest(request)

  // If request is from mobile, enforce mobile permissions
  if (isMobile) {
    const createPermError = await requireMobilePermission(request, 'mobile.issues.create')
    if (createPermError) return createPermError
  } else {
    const permError = await requirePermission(request, 'issues.create')
    if (permError) return permError
  }

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
      clientId,
      leadId,
      jobId,
      watchers,
    } = body

    const resolvedDueDate = dueDate ?? scheduledAt ?? null

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 })
    }

    // If mobile request and assignee is provided, check assignment permissions
    if (isMobile && assigneeId) {
      // Verify assignee belongs to tenant
      const assignee = await prisma.user.findFirst({
        where: {
          id: assigneeId,
          tenantId: user.tenantId,
        },
        select: {
          id: true,
          role: true,
        },
      })

      if (!assignee) {
        return NextResponse.json({ error: 'Assignee not found' }, { status: 404 })
      }

      // Check if assigning to admin
      const isAdmin = assignee.role === 'ADMIN' || assignee.role === 'OFFICE'
      
      // If assigning to admin, require mobile.issues.assign_to_admin or mobile.issues.assign_to_any
      if (isAdmin) {
        const canAssignToAdmin = await hasMobilePermission(user.id, user.tenantId, 'mobile.issues.assign_to_admin')
        const canAssignToAny = await hasMobilePermission(user.id, user.tenantId, 'mobile.issues.assign_to_any')
        
        if (!canAssignToAdmin && !canAssignToAny) {
          return NextResponse.json(
            { error: 'You do not have permission to assign issues to admin users' },
            { status: 403 }
          )
        }
      } else {
        // If assigning to non-admin, require mobile.issues.assign_to_any (admin-level)
        const canAssignToAny = await hasMobilePermission(user.id, user.tenantId, 'mobile.issues.assign_to_any')
        if (!canAssignToAny) {
          return NextResponse.json(
            { error: 'You do not have permission to assign issues to this user' },
            { status: 403 }
          )
        }
      }
    }

    let resolvedClientId = clientId || null

    // If created from a job context, enforce issue -> job -> client relational mapping.
    if (jobId) {
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId: user.tenantId,
        },
        select: {
          id: true,
          clientId: true,
        },
      })

      if (!job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      }

      resolvedClientId = job.clientId
    }

    if (resolvedClientId) {
      const client = await prisma.client.findFirst({
        where: {
          id: resolvedClientId,
          tenantId: user.tenantId,
        },
        select: { id: true },
      })

      if (!client) {
        return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      }
    }

    // Create issue
    const issue = await prisma.issue.create({
      data: {
        tenantId: user.tenantId,
        title,
        description: description || null,
        type: type || 'OTHER',
        status: status || 'OPEN',
        priority: priority || 'MEDIUM',
        dueDate: resolvedDueDate ? new Date(resolvedDueDate) : null,
        assigneeId: assigneeId || null,
        createdById: user.id,
        clientId: resolvedClientId,
        leadId: leadId || null,
        jobId: jobId || null,
        firstResponseAt: null,
        resolvedAt: null,
        closedAt: null,
      },
      include: {
        assignee: true,
        creator: true,
      },
    })

    // Add watchers
    if (watchers && Array.isArray(watchers)) {
      for (const watcherId of watchers) {
        if (watcherId !== user.id) {
          await prisma.issueWatcher.create({
            data: {
              issueId: issue.id,
              userId: watcherId,
            },
          })
        }
      }
    }

    // Auto-add creator as watcher
    await prisma.issueWatcher.create({
      data: {
        issueId: issue.id,
        userId: user.id,
      },
    })

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'ISSUE_CREATED',
        description: `Issue "${title}" created`,
        issueId: issue.id,
        clientId: resolvedClientId || undefined,
        jobId: jobId || undefined,
      },
    })

    // Notify assignee
    if (assigneeId && assigneeId !== user.id) {
      await notifyIssueAssigned(user.tenantId, assigneeId, issue.id, title)
    }

    // Audit log for mobile issue creation
    if (isMobile) {
      await prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'CREATE',
          entityType: 'Issue',
          entityId: issue.id,
          changes: {
            title,
            assigneeId: assigneeId || null,
            source: 'mobile',
          },
        },
      })
    }

    return NextResponse.json({ issue }, { status: 201 })
  } catch (error) {
    console.error('Create issue error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
