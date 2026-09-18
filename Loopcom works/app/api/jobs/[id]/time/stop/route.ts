import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { hasMobilePermission, hasPermission, requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { syncJobBillableMinutes } from '@/lib/time-tracking'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['web.jobs.edit_time_entries', 'jobs.edit'])
  if (permError) return permError

  const actor = getAuthUser(request)
  const jobId = params.id

  try {
    const body = await request.json().catch(() => ({}))
    const endedAt = body?.endedAt ? new Date(body.endedAt) : new Date()
    const note = typeof body?.note === 'string' ? body.note.trim() : null
    const workerId = typeof body?.workerId === 'string' && body.workerId ? body.workerId : actor.id

    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      include: { assignments: { select: { userId: true } } },
    })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const isAssigned = job.assignments.some((a) => a.userId === actor.id)
    const canEditTeam = actor.role === 'ADMIN' || (await hasPermission(actor.id, actor.tenantId, 'web.jobs.edit_time_entries'))
    const canTrackMobile = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.track_time')
    if (!(canEditTeam || (isAssigned && canTrackMobile))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (workerId !== actor.id && !canEditTeam) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const activeEntry = await prisma.timeEntry.findFirst({
      where: {
        tenantId: actor.tenantId,
        jobId,
        workerId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: {
        worker: { select: { id: true, firstName: true, lastName: true } },
      },
    })
    if (!activeEntry) {
      return NextResponse.json({ error: 'No active timer found to stop' }, { status: 404 })
    }

    const safeEnd = endedAt.getTime() < new Date(activeEntry.startedAt || activeEntry.createdAt).getTime()
      ? new Date(activeEntry.startedAt || activeEntry.createdAt)
      : endedAt
    const durationMinutes = Math.max(
      0,
      Math.round((safeEnd.getTime() - new Date(activeEntry.startedAt || activeEntry.createdAt).getTime()) / 60000)
    )

    const entry = await prisma.timeEntry.update({
      where: { id: activeEntry.id },
      data: {
        endedAt: safeEnd,
        durationMinutes,
        status: 'STOPPED',
        note: note || activeEntry.note,
        updatedById: actor.id,
      },
    })

    await Promise.all([
      prisma.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'TimeEntry',
          entityId: entry.id,
          changes: { status: 'STOPPED', endedAt: entry.endedAt, durationMinutes: entry.durationMinutes },
        },
      }),
      prisma.activity.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          type: 'OTHER',
          description: `Timer stopped on ${job.jobNumber} for ${activeEntry.worker.firstName} ${activeEntry.worker.lastName}`,
          jobId,
          metadata: { timeEntryId: entry.id, durationMinutes: entry.durationMinutes, source: 'TIMER' },
        },
      }),
    ])

    const summary = await syncJobBillableMinutes(actor.tenantId, jobId)
    return NextResponse.json({ entry, summary })
  } catch (error) {
    console.error('Stop timer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
