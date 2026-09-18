import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { publishDispatchRealtime } from '@/lib/dispatch-realtime'
import { notifyDispatchJobActivity } from '@/lib/notifications'

/**
 * Mobile API: Add note to job
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'jobs.update')
  if (permError) return permError

  const user = getAuthUser(request)
  const jobId = params.id

  try {
    const body = await request.json()
    const { content } = body

    if (!content || content.trim().length === 0) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    // Verify job exists and is assigned to user
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenantId: user.tenantId,
        assignments: {
          some: {
            userId: user.id,
          },
        },
      },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found or not assigned to you' }, { status: 404 })
    }

    // Create note
    const note = await prisma.note.create({
      data: {
        jobId,
        content: content.trim(),
        createdById: user.id,
      },
    })

    // Create dispatch event
    await prisma.dispatchEvent.create({
      data: {
        tenantId: user.tenantId,
        jobId: jobId,
        eventType: 'NOTE_ADDED',
        actorUserId: user.id,
        payload: {
          noteId: note.id,
          content: content.trim(),
          source: 'mobile',
        },
      },
    })

    publishDispatchRealtime(user.tenantId, {
      id: `mobile_note_${note.id}`,
      kind: 'dispatch_event',
      ts: new Date().toISOString(),
      jobId,
      eventType: 'NOTE_ADDED',
      payload: {
        noteId: note.id,
        content: content.trim(),
        source: 'mobile',
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
      message: content.trim().slice(0, 140),
    })

    return NextResponse.json({ note }, { status: 201 })
  } catch (error) {
    console.error('Mobile job note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
