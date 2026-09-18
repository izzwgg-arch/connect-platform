import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

async function getIssueNote(issueId: string, noteId: string, tenantId: string) {
  return prisma.issueNote.findFirst({
    where: {
      id: noteId,
      issueId,
      issue: { tenantId },
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; noteId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'issues.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const note = await getIssueNote(params.id, params.noteId, user.tenantId)
    if (!note) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }

    const body = await request.json()
    const content = String(body?.content || '').trim()
    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    const updated = await prisma.issueNote.update({
      where: { id: note.id },
      data: { content },
    })

    return NextResponse.json({
      note: {
        id: updated.id,
        content: updated.content,
        createdAt: updated.createdAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Update issue note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; noteId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'issues.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const note = await getIssueNote(params.id, params.noteId, user.tenantId)
    if (!note) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }

    await prisma.issueNote.delete({ where: { id: note.id } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete issue note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
