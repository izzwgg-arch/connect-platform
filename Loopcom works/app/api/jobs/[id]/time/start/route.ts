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
    const startedAt = body?.startedAt ? new Date(body.startedAt) : new Date()
    const note = typeof body?.note === 'string' ? body.note.trim() : null

    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      include: { assignments: { select: { userId: true } } },
    })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    if (!job.chargeByHour) return NextResponse.json({ error: 'Job is not configured for hourly billing' }, { status: 400 })

    const isAssigned = job.assignments.some((a) => a.userId === actor.id)
    const canEditTeam = actor.role === 'ADMIN' || (await hasPermission(actor.id, actor.tenantId, 'web.jobs.edit_time_entries'))
    const canTrackMobile = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.track_time')
    if (!(canEditTeam || (isAssigned && canTrackMobile))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const workerId = typeof body?.workerId === 'string' && body.workerId && canEditTeam ? body.workerId : actor.id
    if (workerId !== actor.id && !canEditTeam) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (workerId !== actor.id) {
      const assignedWorker = job.assignments.some((a) => a.userId === workerId)
      if (!assignedWorker) {
        return NextResponse.json({ error: 'Worker is not assigned to this job' }, { status: 400 })
      }
    }

    const existingActive = await prisma.timeEntry.findFirst({
      where: {
        tenantId: actor.tenantId,
        jobId,
        workerId,
        status: 'ACTIVE',
        deletedAt: null,
      },
    })
    if (existingActive) {
      return NextResponse.json({ error: 'An active timer already exists for this worker and job' }, { status: 409 })
    }

    const entry = await prisma.timeEntry.create({
      data: {
        tenantId: actor.tenantId,
        jobId,
        workerId,
        startedAt,
        source: 'TIMER',
        status: 'ACTIVE',
        note,
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
          changes: { jobId, workerId, source: 'TIMER', status: 'ACTIVE', startedAt: entry.startedAt },
        },
      }),
      prisma.activity.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          type: 'OTHER',
          description: `Timer started on ${job.jobNumber} by ${entry.worker.firstName} ${entry.worker.lastName}`,
          jobId,
          metadata: { timeEntryId: entry.id, source: 'TIMER' },
        },
      }),
    ])

    const summary = await syncJobBillableMinutes(actor.tenantId, jobId)
    return NextResponse.json({ entry, summary }, { status: 201 })
  } catch (error) {
    console.error('Start timer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
