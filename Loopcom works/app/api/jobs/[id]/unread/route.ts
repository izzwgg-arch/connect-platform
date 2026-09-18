import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireWebOrMobilePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getUnreadJobThreadCounts } from '@/lib/chat/service'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireWebOrMobilePermission(request, 'jobs.view', 'mobile.jobs.view_all')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const job = await prisma.job.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      select: { id: true, createdAt: true },
    })
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const notesSinceParam = searchParams.get('notesSince')
    const notesSince = notesSinceParam ? new Date(notesSinceParam) : null

    const [unreadByJob, notesCount] = await Promise.all([
      getUnreadJobThreadCounts(user.tenantId, user.id, [job.id]),
      notesSince && !Number.isNaN(notesSince.getTime())
        ? prisma.note.count({
            where: { jobId: job.id, createdAt: { gt: notesSince } },
          })
        : Promise.resolve(0),
    ])

    return NextResponse.json({
      messages: unreadByJob.get(job.id) || 0,
      notes: notesCount,
    })
  } catch (error) {
    console.error('job unread GET error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
