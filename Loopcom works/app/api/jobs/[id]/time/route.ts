import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { hasMobilePermission, hasPermission, requireWebOrAnyMobilePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getJobTimeSummary } from '@/lib/time-tracking'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireWebOrAnyMobilePermission(request, 'jobs.view', [
    'mobile.jobs.view_time_entries',
    'mobile.jobs.track_time',
    'mobile.jobs.view_assigned',
  ])
  if (permError) return permError

  const actor = getAuthUser(request)
  const jobId = params.id

  try {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      include: {
        assignments: {
          select: { userId: true },
        },
      },
    })
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const isAssigned = job.assignments.some((a) => a.userId === actor.id)
    const canEditWeb = actor.role === 'ADMIN' || (await hasPermission(actor.id, actor.tenantId, 'web.jobs.edit_time_entries'))
    const canEditTeamMobile = await hasMobilePermission(actor.id, actor.tenantId, 'mobile.jobs.edit_team_time_entries')
    const canViewAll = canEditWeb || canEditTeamMobile

    if (!isAssigned && !canViewAll) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const entries = await prisma.timeEntry.findMany({
      where: {
        tenantId: actor.tenantId,
        jobId,
        deletedAt: null,
        ...(canViewAll ? {} : { workerId: actor.id }),
      },
      include: {
        worker: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        updatedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    })

    const activeEntries = entries.filter((e) => e.status === 'ACTIVE')
    const summary = await getJobTimeSummary(actor.tenantId, jobId, job.hourlyRateCents ?? null)

    return NextResponse.json({
      entries,
      activeEntries,
      summary,
      billing: {
        chargeByHour: job.chargeByHour,
        hourlyRateCents: job.hourlyRateCents,
      },
      permissions: {
        canViewAll,
      },
    })
  } catch (error) {
    console.error('Get job time entries error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
