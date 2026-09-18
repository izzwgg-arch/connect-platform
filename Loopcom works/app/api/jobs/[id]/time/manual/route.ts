import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { hasMobilePermission, hasPermission, requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { syncJobBillableMinutes } from '@/lib/time-tracking'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'web.jobs.edit_time_entries')
  if (permError) return permError

  const actor = getAuthUser(request)
  const jobId = params.id

  try {
    const body = await request.json()
    const note = typeof body?.note === 'string' ? body.note.trim() : ''
    const workerId = typeof body?.workerId === 'string' && body.workerId ? body.workerId : actor.id
    const startedAt = body?.startedAt ? new Date(body.startedAt) : null
    const endedAt = body?.endedAt ? new Date(body.endedAt) : null
    let durationMinutes = Number.isFinite(Number(body?.durationMinutes)) ? Number(body.durationMinutes) : 0

    if (!durationMinutes && startedAt && endedAt) {
      durationMinutes = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000))
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return NextResponse.json({ error: 'Duration must be greater than zero' }, { status: 400 })
    }

    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      include: { assignments: { select: { userId: true } } },
    })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    if (!job.chargeByHour) return NextResponse.json({ error: 'Job is not configured for hourly billing' }, { status: 400 })

    const isAssigned = job.assignments.some((a) => a.userId === actor.id)
    const canEditWeb = actor.role === 'ADMIN' || (await hasPermission(actor.id, actor.tenantId, 'web.jobs.edit_time_entries'))
    const canEditTeam = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.edit_team_time_entries')
    const canEditOwn = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.edit_own_time_entries')
    if (!(canEditWeb || canEditTeam || (isAssigned && canEditOwn))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (workerId !== actor.id && !(canEditWeb || canEditTeam)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const workerAssigned = job.assignments.some((a) => a.userId === workerId)
    if (!workerAssigned) {
      return NextResponse.json({ error: 'Worker is not assigned to this job' }, { status: 400 })
    }

    const entry = await prisma.timeEntry.create({
      data: {
        tenantId: actor.tenantId,
        jobId,
        workerId,
        startedAt,
        endedAt,
        durationMinutes,
        source: 'MANUAL',
        status: 'STOPPED',
        note: note || null,
        createdById: actor.id,
        updatedById: actor.id,
      },
      include: {
        worker: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    })

    await Promise.all([
      prisma.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          action: 'CREATE',
          entityType: 'TimeEntry',
          entityId: entry.id,
          changes: {
            jobId,
            workerId,
            source: 'MANUAL',
            durationMinutes: entry.durationMinutes,
            note: entry.note,
          },
        },
      }),
      prisma.activity.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          type: 'OTHER',
          description: `Manual time entry added on ${job.jobNumber}`,
          jobId,
          metadata: { timeEntryId: entry.id, source: 'MANUAL', durationMinutes: entry.durationMinutes },
        },
      }),
    ])

    const summary = await syncJobBillableMinutes(actor.tenantId, jobId)
    return NextResponse.json({ entry, summary }, { status: 201 })
  } catch (error) {
    console.error('Create manual time entry error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
