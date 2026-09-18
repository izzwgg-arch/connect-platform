import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

async function getTaskNote(taskId: string, noteId: string, tenantId: string) {
  return prisma.activity.findFirst({
    where: {
      id: noteId,
      taskId,
      tenantId,
      metadata: {
        path: ['kind'],
        equals: 'task_note',
      },
    },
    include: {
      user: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; noteId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'tasks.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const activity = await getTaskNote(params.id, params.noteId, user.tenantId)
    if (!activity) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }

    const body = await request.json()
    const content = String(body?.content || '').trim()
    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    const existingMetadata = (activity.metadata || {}) as Record<string, unknown>
    const updated = await prisma.activity.update({
      where: { id: activity.id },
      data: {
        metadata: {
          ...existingMetadata,
          kind: 'task_note',
          content,
        },
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    const authorName = updated.user
      ? `${updated.user.firstName} ${updated.user.lastName}`.trim()
      : 'Unknown user'

    return NextResponse.json({
      note: {
        id: updated.id,
        content,
        createdAt: updated.createdAt.toISOString(),
        authorName,
        createdById: updated.userId || null,
      },
    })
  } catch (error) {
    console.error('Update task note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; noteId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'tasks.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const activity = await getTaskNote(params.id, params.noteId, user.tenantId)
    if (!activity) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }

    await prisma.activity.delete({ where: { id: activity.id } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete task note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
