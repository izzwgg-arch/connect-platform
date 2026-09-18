import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { publishDispatchRealtime } from '@/lib/dispatch-realtime'
import { notifyDispatchJobActivity } from '@/lib/notifications'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requireAnyPermission(request, ['jobs.add_notes', 'jobs.update'])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const content = String(body?.content || '').trim()

    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    const job = await prisma.job.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: {
        id: true,
        jobNumber: true,
        title: true,
        clientId: true,
      },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const note = await prisma.note.create({
      data: {
        jobId: job.id,
        content,
        createdById: user.id,
      },
    })

    await prisma.dispatchEvent.create({
      data: {
        tenantId: user.tenantId,
        jobId: job.id,
        eventType: 'NOTE_ADDED',
        actorUserId: user.id,
        payload: {
          noteId: note.id,
          content,
          source: 'dashboard',
        },
      },
    })

    publishDispatchRealtime(user.tenantId, {
      id: `dashboard_note_${note.id}`,
      kind: 'dispatch_event',
      ts: new Date().toISOString(),
      jobId: job.id,
      eventType: 'NOTE_ADDED',
      payload: {
        noteId: note.id,
        content,
        source: 'dashboard',
      },
      job: {
        id: job.id,
        jobNumber: job.jobNumber,
        title: job.title,
      },
    })

    await notifyDispatchJobActivity({
      tenantId: user.tenantId,
      jobId: job.id,
      title: `New note on ${job.jobNumber}`,
      message: content.slice(0, 140),
    })

    return NextResponse.json(
      {
        note: {
          id: note.id,
          content: note.content,
          createdAt: note.createdAt.toISOString(),
          authorName: `${user.firstName} ${user.lastName}`.trim() || user.email,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create job note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
