import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { hasMobilePermission, hasPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { syncJobBillableMinutes } from '@/lib/time-tracking'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const actor = getAuthUser(request)
  const id = params.id

  try {
    const body = await request.json()
    const editedReason = typeof body?.editedReason === 'string' ? body.editedReason.trim() : ''
    if (!editedReason) {
      return NextResponse.json({ error: 'editedReason is required' }, { status: 400 })
    }

    const entry = await prisma.timeEntry.findFirst({
      where: { id, tenantId: actor.tenantId, deletedAt: null },
      include: {
        job: {
          include: {
            assignments: { select: { userId: true } },
          },
        },
      },
    })
    if (!entry) return NextResponse.json({ error: 'Time entry not found' }, { status: 404 })

    const canEditWeb = actor.role === 'ADMIN' || (await hasPermission(actor.id, actor.tenantId, 'web.jobs.edit_time_entries'))
    const canEditTeam = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.edit_team_time_entries')
    const canEditOwn = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.edit_own_time_entries')
    const ownsEntry = entry.workerId === actor.id
    if (!(canEditWeb || canEditTeam || (ownsEntry && canEditOwn))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const startedAt = body?.startedAt ? new Date(body.startedAt) : entry.startedAt
    const endedAt = body?.endedAt ? new Date(body.endedAt) : entry.endedAt
    let durationMinutes = Number.isFinite(Number(body?.durationMinutes))
      ? Number(body.durationMinutes)
      : entry.durationMinutes
    if ((!Number.isFinite(durationMinutes) || durationMinutes <= 0) && startedAt && endedAt) {
      durationMinutes = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000))
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0) {
      return NextResponse.json({ error: 'Invalid duration' }, { status: 400 })
    }

    const note = typeof body?.note === 'string' ? body.note.trim() : entry.note
    const nextStatus = endedAt ? 'STOPPED' : entry.status

    const updated = await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        startedAt,
        endedAt,
        durationMinutes,
        note: note || null,
        status: nextStatus,
        editedReason,
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
          entityId: updated.id,
          changes: {
            before: {
              startedAt: entry.startedAt,
              endedAt: entry.endedAt,
              durationMinutes: entry.durationMinutes,
              note: entry.note,
            },
            after: {
              startedAt: updated.startedAt,
              endedAt: updated.endedAt,
              durationMinutes: updated.durationMinutes,
              note: updated.note,
            },
            editedReason,
          },
        },
      }),
      prisma.activity.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          type: 'OTHER',
          description: `Time entry edited on ${entry.job.jobNumber}`,
          jobId: entry.jobId,
          metadata: { timeEntryId: updated.id, editedReason },
        },
      }),
    ])

    const summary = await syncJobBillableMinutes(actor.tenantId, entry.jobId)
    return NextResponse.json({ entry: updated, summary })
  } catch (error) {
    console.error('Update time entry error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const actor = getAuthUser(request)
  const id = params.id

  try {
    const body = await request.json().catch(() => ({}))
    const editedReason = typeof body?.editedReason === 'string' ? body.editedReason.trim() : 'Deleted from UI'
    const entry = await prisma.timeEntry.findFirst({
      where: { id, tenantId: actor.tenantId, deletedAt: null },
      include: {
        job: true,
      },
    })
    if (!entry) return NextResponse.json({ error: 'Time entry not found' }, { status: 404 })

    const canEditWeb = actor.role === 'ADMIN' || (await hasPermission(actor.id, actor.tenantId, 'web.jobs.edit_time_entries'))
    const canEditTeam = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.edit_team_time_entries')
    if (!(canEditWeb || canEditTeam)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const deleted = await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        deletedAt: new Date(),
        editedReason,
        updatedById: actor.id,
        status: 'STOPPED',
      },
    })

    await Promise.all([
      prisma.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          action: 'DELETE',
          entityType: 'TimeEntry',
          entityId: deleted.id,
          changes: { editedReason },
        },
      }),
      prisma.activity.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.id,
          type: 'OTHER',
          description: `Time entry removed on ${entry.job.jobNumber}`,
          jobId: entry.jobId,
          metadata: { timeEntryId: deleted.id, editedReason },
        },
      }),
    ])

    const summary = await syncJobBillableMinutes(actor.tenantId, entry.jobId)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    console.error('Delete time entry error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
