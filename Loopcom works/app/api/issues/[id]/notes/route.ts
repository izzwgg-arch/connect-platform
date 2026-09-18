import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

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
    // Verify issue belongs to tenant
    const issue = await prisma.issue.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const notes = await prisma.issueNote.findMany({
      where: { issueId: params.id },
      orderBy: { createdAt: 'asc' },
    })

    const authorIds = Array.from(new Set(notes.map((n) => n.createdById)))
    const authors = authorIds.length
      ? await prisma.user.findMany({
          where: {
            tenantId: user.tenantId,
            id: { in: authorIds },
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        })
      : []
    const authorMap = new Map(authors.map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]))

    return NextResponse.json({
      notes: notes.map((note) => ({
        ...note,
        authorName: authorMap.get(note.createdById) || 'Unknown user',
      })),
    })
  } catch (error) {
    console.error('Get issue notes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
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
    const { content, isInternal } = body

    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    // Verify issue belongs to tenant
    const issue = await prisma.issue.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
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
      },
    })

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const note = await prisma.issueNote.create({
      data: {
        issueId: params.id,
        content,
        isInternal: isInternal || false,
        createdById: user.id,
      },
    })

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'ISSUE_CREATED',
        description: `Note added to issue "${issue.title}"`,
        issueId: issue.id,
        clientId: issue.clientId || undefined,
        jobId: issue.jobId || undefined,
      },
    })

    // Notify watchers (except creator)
    for (const watcher of issue.watchers) {
      if (watcher.userId !== user.id) {
        await prisma.notification.create({
          data: {
            tenantId: user.tenantId,
            userId: watcher.userId,
            type: 'OTHER',
            title: 'New Note on Issue',
            message: `${user.firstName} ${user.lastName} added a note to "${issue.title}"`,
            linkType: 'issue',
            linkId: issue.id,
            linkUrl: `/dashboard/issues/${issue.id}`,
          },
        })
      }
    }

    return NextResponse.json({ note }, { status: 201 })
  } catch (error) {
    console.error('Create issue note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
