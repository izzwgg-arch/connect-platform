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
  const permError = await requirePermission(request, 'tasks.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const task = await prisma.task.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: { id: true },
    })

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const activities = await prisma.activity.findMany({
      where: {
        tenantId: user.tenantId,
        taskId: params.id,
        metadata: {
          path: ['kind'],
          equals: 'task_note',
        },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    return NextResponse.json({
      notes: activities.map((activity) => {
        const metadata = (activity.metadata || {}) as Record<string, unknown>
        const content =
          typeof metadata.content === 'string' && metadata.content.trim()
            ? metadata.content
            : activity.description
        const authorName = activity.user
          ? `${activity.user.firstName} ${activity.user.lastName}`.trim()
          : 'Unknown user'
        return {
          id: activity.id,
          content,
          createdAt: activity.createdAt.toISOString(),
          authorName,
          createdById: activity.userId || null,
        }
      }),
    })
  } catch (error) {
    console.error('Get task notes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'tasks.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const content = String(body?.content || '').trim()

    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    const task = await prisma.task.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: {
        id: true,
        clientId: true,
        jobId: true,
      },
    })

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const noteActivity = await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: 'Task note added',
        taskId: task.id,
        clientId: task.clientId || undefined,
        jobId: task.jobId || undefined,
        metadata: {
          kind: 'task_note',
          content,
        },
      },
    })

    return NextResponse.json({ note: noteActivity }, { status: 201 })
  } catch (error) {
    console.error('Create task note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
