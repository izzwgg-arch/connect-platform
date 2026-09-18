import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { jobRecordJobSiteAddressSearchClauses } from '@/lib/search/job-site-address'
import { applySmartSearch, buildSmartSearchAnd, clientIdentityClauses, ilike } from '@/lib/search/prisma-filters'
import { jobTypeScopeWhere } from '@/lib/jobs/job-type-scope'
import {
  ARCHIVE_JOB_STATUSES,
  getProductionInfo,
  PRODUCTION_STATUS_MAP,
} from '@/lib/production/production-status'
import type { JobStatusValue } from '@/lib/jobs/statuses'

/**
 * Production board data — entirely derived from the existing Job.status.
 * Job.status is the single source of truth; this route never writes it and
 * introduces no separate production status. Job status changes made
 * anywhere else in the app (Jobs page, job detail, Schedule, mobile) are
 * reflected here automatically on the next fetch, with no extra sync step.
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'production.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') || ''
  const view = searchParams.get('view') === 'archive' ? 'archive' : 'active'
  const crewId = searchParams.get('assignedTo') || ''
  const priorityParam = searchParams.get('priority') || ''

  try {
    const baseWhere: any = {
      tenantId: user.tenantId,
      ...(await jobTypeScopeWhere(user.id, user.tenantId)),
    }

    applySmartSearch(
      baseWhere,
      buildSmartSearchAnd(search, (term) => [
        { jobNumber: ilike(term) },
        { title: ilike(term) },
        ...clientIdentityClauses(term),
        ...jobRecordJobSiteAddressSearchClauses(term),
      ])
    )

    if (crewId) {
      baseWhere.assignments = { some: { userId: crewId } }
    }

    if (priorityParam) {
      const parsedPriority = Number(priorityParam)
      if (!Number.isNaN(parsedPriority)) {
        baseWhere.priority = parsedPriority
      }
    }

    const listWhere = {
      ...baseWhere,
      status: view === 'archive' ? { in: ARCHIVE_JOB_STATUSES } : { notIn: ARCHIVE_JOB_STATUSES },
    }

    const [jobs, statusCounts] = await Promise.all([
      prisma.job.findMany({
        where: listWhere,
        include: {
          client: {
            select: { id: true, name: true, companyName: true },
          },
          assignments: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
          addresses: {
            where: { type: 'job_site' },
            select: { id: true, street: true, city: true, state: true, zipCode: true },
            take: 1,
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 500,
      }),
      // Counts are computed from ALL of the tenant's jobs (not just the fetched
      // page), so they stay correct even though the board itself is capped.
      prisma.job.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ])

    const countByStatus: Partial<Record<JobStatusValue, number>> = {}
    for (const row of statusCounts) {
      countByStatus[row.status as JobStatusValue] = row._count._all
    }

    let activeProduction = 0
    for (const [status, info] of Object.entries(PRODUCTION_STATUS_MAP)) {
      if (info.isActive) activeProduction += countByStatus[status as JobStatusValue] || 0
    }

    const counts = {
      activeProduction,
      needToOrder: countByStatus.NEED_TO_ORDER || 0,
      ordered: countByStatus.ORDERED || 0,
      inProgress: countByStatus.IN_PROGRESS || 0,
      needTouchUps: countByStatus.NEED_TOUCH_UPS || 0,
      onHold: countByStatus.ON_HOLD || 0,
      // "Ready for Installation" = jobs Scheduled and ready to begin (Board: Ready).
      readyForInstallation: countByStatus.SCHEDULED || 0,
      completed: countByStatus.COMPLETED || 0,
    }

    const enrichedJobs = jobs.map((job) => ({
      id: job.id,
      jobNumber: job.jobNumber,
      title: job.title,
      status: job.status,
      priority: job.priority,
      jobType: job.jobType,
      scheduledStart: job.scheduledStart,
      scheduledEnd: job.scheduledEnd,
      estimateAmount: job.estimateAmount != null ? job.estimateAmount.toString() : null,
      actualAmount: job.actualAmount != null ? job.actualAmount.toString() : null,
      client: job.client,
      assignments: job.assignments.map((a) => ({
        id: a.id,
        user: a.user,
      })),
      addresses: job.addresses,
      production: getProductionInfo(job.status),
    }))

    return NextResponse.json({ jobs: enrichedJobs, counts })
  } catch (error) {
    console.error('Get production data error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
