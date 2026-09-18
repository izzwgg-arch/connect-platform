import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission, requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

async function getTenantNote(noteId: string, tenantId: string) {
  return prisma.note.findFirst({
    where: {
      id: noteId,
      OR: [{ job: { tenantId } }, { client: { tenantId } }],
    },
    select: {
      id: true,
      content: true,
      createdAt: true,
      jobId: true,
      clientId: true,
    },
  })
}

async function requireNotePermission(request: NextRequest, note: { jobId: string | null; clientId: string | null }) {
  if (note.jobId) {
    return requireAnyPermission(request, ['jobs.add_notes', 'jobs.update'])
  }
  if (note.clientId) {
    return requirePermission(request, 'clients.edit')
  }
  return NextResponse.json({ error: 'Invalid note' }, { status: 400 })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)

  try {
    const note = await getTenantNote(params.id, user.tenantId)
    if (!note) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }

    const permError = await requireNotePermission(request, note)
    if (permError) return permError

    const body = await request.json()
    const content = String(body?.content || '').trim()
    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    const updated = await prisma.note.update({
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
    console.error('Update note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)

  try {
    const note = await getTenantNote(params.id, user.tenantId)
    if (!note) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }

    const permError = await requireNotePermission(request, note)
    if (permError) return permError

    await prisma.note.delete({ where: { id: note.id } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
