import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getPaginationParams, createPaginationResponse } from '@/lib/pagination'
import { validateRequest, createJobSchema } from '@/lib/validation'
import { isMobileRequest, requireMobilePermission, hasMobilePermission } from '@/lib/authorization'
import { jobRecordJobSiteAddressSearchClauses } from '@/lib/search/job-site-address'
import { applySmartSearch, buildSmartSearchAnd, clientIdentityClauses, ilike } from '@/lib/search/prisma-filters'
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/statuses'
import { getJobBillingStatus } from '@/lib/jobs/billing-status'
import { applyJobTypeListFilter, jobTypeScopeWhere, resolveJobTypeForWrite } from '@/lib/jobs/job-type-scope'
import { getUnreadJobThreadCounts } from '@/lib/chat/service'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const isMobile = isMobileRequest(request)
  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || 'all'
  const clientId = searchParams.get('clientId') || ''
  const scheduled = searchParams.get('scheduled')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const crewId = searchParams.get('crewId') || ''
  const priorityParam = searchParams.get('priority') || ''
  const jobTypeParam = searchParams.get('jobType') || 'all'
  const sortByRaw = searchParams.get('sortBy') || 'updatedAt'
  const sortDirectionRaw = searchParams.get('sortDirection') || 'desc'
  const sortDirection = sortDirectionRaw === 'asc' ? 'asc' : 'desc'
  const sortMap: Record<string, any> = {
    jobNumber: { jobNumber: sortDirection },
    title: { title: sortDirection },
    status: { status: sortDirection },
    jobType: { jobType: sortDirection },
    priority: { priority: sortDirection },
    scheduledStart: { scheduledStart: sortDirection },
    createdAt: { createdAt: sortDirection },
    updatedAt: { updatedAt: sortDirection },
  }
  const orderBy = sortMap[sortByRaw] || sortMap.updatedAt
  const { skip, take, page, limit } = getPaginationParams(searchParams)

  try {
    const enrichJobsWithFinancials = async (jobs: any[]) => {
      if (!Array.isArray(jobs) || jobs.length === 0) return jobs

      const jobIds = jobs.map((j) => String(j.id))
      const clientIds = Array.from(new Set(jobs.map((j) => String(j.clientId || j.client?.id || '')).filter(Boolean)))

      const [jobInvoiceAgg, clientInvoiceAgg] = await Promise.all([
        prisma.invoice.groupBy({
          by: ['jobId'],
          where: {
            tenantId: user.tenantId,
            jobId: { in: jobIds },
            status: { notIn: ['CANCELLED', 'REFUNDED'] as any },
          } as any,
          _sum: { total: true, balance: true },
          _count: { _all: true },
        }),
        clientIds.length
          ? prisma.invoice.groupBy({
              by: ['clientId'],
              where: {
                tenantId: user.tenantId,
                clientId: { in: clientIds },
                balance: { gt: 0 },
                status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
              } as any,
              _sum: { balance: true },
            })
          : Promise.resolve([] as any[]),
      ])

      const byJobId = new Map(
        jobInvoiceAgg.map((row) => [
          String(row.jobId),
          {
            totalInvoicedAmount: row._sum.total?.toString() || '0',
            openInvoiceBalance: row._sum.balance?.toString() || '0',
            openInvoiceCount: Number(row._count?._all || 0),
          },
        ])
      )
      const byClientId = new Map(
        clientInvoiceAgg.map((row) => [String(row.clientId), row._sum.balance?.toString() || '0'])
      )

      const unreadByJob = await getUnreadJobThreadCounts(user.tenantId, user.id, jobIds)

      return jobs.map((job) => {
        const jobTotals = byJobId.get(String(job.id)) || {
          totalInvoicedAmount: '0',
          openInvoiceBalance: '0',
          openInvoiceCount: 0,
        }
        const clientOpenInvoiceBalance = byClientId.get(String(job.clientId || job.client?.id || '')) || '0'
        const totalCost = job.actualAmount ?? job.estimateAmount ?? null
        const billingStatus = getJobBillingStatus({
          estimateAmount: job.estimateAmount,
          actualAmount: job.actualAmount,
          totalInvoicedAmount: jobTotals.totalInvoicedAmount,
        })
        return {
          ...job,
          totalCost: totalCost != null ? totalCost.toString() : null,
          totalInvoicedAmount: jobTotals.totalInvoicedAmount,
          openInvoiceBalance: jobTotals.openInvoiceBalance,
          openInvoiceCount: jobTotals.openInvoiceCount,
          clientOpenInvoiceBalance,
          billingStatus,
          unreadMessages: unreadByJob.get(String(job.id)) || 0,
        }
      })
    }

    // If mobile request, enforce mobile.jobs.view_all permission for viewing all jobs
    if (isMobile) {
      const canViewAll = await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.view_all')
      if (!canViewAll) {
        // If user doesn't have view_all, only show assigned jobs
        const where: any = {
          tenantId: user.tenantId,
          assignments: {
            some: {
              userId: user.id,
            },
          },
          ...(await jobTypeScopeWhere(user.id, user.tenantId)),
        }

        applySmartSearch(
          where,
          buildSmartSearchAnd(search, (term) => [
            { jobNumber: ilike(term) },
            { title: ilike(term) },
            { description: ilike(term) },
            ...clientIdentityClauses(term),
            {
              assignments: {
                some: {
                  user: {
                    OR: [
                      { firstName: ilike(term) },
                      { lastName: ilike(term) },
                      { email: ilike(term) },
                    ],
                  },
                },
              },
            },
            ...jobRecordJobSiteAddressSearchClauses(term),
          ])
        )

        if (status !== 'all') {
          if (status === 'ACTIVE') {
            where.status = {
              in: ACTIVE_JOB_STATUSES as any[],
            }
          } else {
            where.status = status
          }
        }

        if (scheduled === 'false') {
          where.scheduledStart = null
        } else if (scheduled === 'true') {
          where.scheduledStart = {
            not: null,
            ...(startDate ? { gte: new Date(startDate) } : {}),
            ...(endDate ? { lte: new Date(endDate) } : {}),
          }
        } else if (startDate || endDate) {
          where.createdAt = {
            ...(startDate ? { gte: new Date(startDate) } : {}),
            ...(endDate ? { lte: new Date(`${endDate}T23:59:59.999`) } : {}),
          }
        }

        if (crewId) {
          where.assignments = {
            some: {
              userId: crewId,
            },
          }
        }

        if (priorityParam && priorityParam !== 'all') {
          const parsedPriority = Number(priorityParam)
          if (!Number.isNaN(parsedPriority)) {
            where.priority = parsedPriority
          }
        }

        applyJobTypeListFilter(where, jobTypeParam)

        const [jobs, total] = await Promise.all([
          prisma.job.findMany({
            where,
            include: {
              client: {
                select: {
                  id: true,
                  name: true,
                  companyName: true,
                },
              },
              assignments: {
                include: {
                  user: {
                    select: {
                      id: true,
                      firstName: true,
                      lastName: true,
                    },
                  },
                },
              },
              addresses: {
                where: { type: 'job_site' },
                select: {
                  id: true,
                  street: true,
                  city: true,
                  state: true,
                  zipCode: true,
                },
                take: 1,
              },
              _count: {
                select: {
                  tasks: true,
                  issues: true,
                },
              },
            },
            orderBy,
            skip,
            take,
          }),
          prisma.job.count({ where }),
        ])

        const enrichedJobs = await enrichJobsWithFinancials(jobs as any[])
        return NextResponse.json({
          jobs: enrichedJobs,
          pagination: createPaginationResponse(total, limit, skip),
        })
      }
    }

    const where: any = {
      tenantId: user.tenantId,
      ...(await jobTypeScopeWhere(user.id, user.tenantId)),
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { jobNumber: ilike(term) },
        { title: ilike(term) },
        { description: ilike(term) },
        ...clientIdentityClauses(term),
        {
          assignments: {
            some: {
              user: {
                OR: [
                  { firstName: ilike(term) },
                  { lastName: ilike(term) },
                  { email: ilike(term) },
                ],
              },
            },
          },
        },
        ...jobRecordJobSiteAddressSearchClauses(term),
      ])
    )

    if (status !== 'all') {
      if (status === 'ACTIVE') {
        where.status = {
          in: ACTIVE_JOB_STATUSES as any[],
        }
      } else {
        where.status = status
      }
    }

    if (clientId) {
      where.clientId = clientId
    }

    if (scheduled === 'false') {
      where.scheduledStart = null
    } else if (scheduled === 'true') {
      where.scheduledStart = {
        not: null,
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {}),
      }
    } else if (startDate || endDate) {
      where.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(`${endDate}T23:59:59.999`) } : {}),
      }
    }

    if (crewId) {
      where.assignments = {
        some: {
          userId: crewId,
        },
      }
    }

    if (priorityParam && priorityParam !== 'all') {
      const parsedPriority = Number(priorityParam)
      if (!Number.isNaN(parsedPriority)) {
        where.priority = parsedPriority
      }
    }

    applyJobTypeListFilter(where, jobTypeParam)

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: {
          client: {
            select: {
              id: true,
              name: true,
              companyName: true,
            },
          },
          assignments: {
            include: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
          addresses: {
            where: { type: 'job_site' },
            select: {
              id: true,
              street: true,
              city: true,
              state: true,
              zipCode: true,
            },
            take: 1,
          },
          _count: {
            select: {
              tasks: true,
              issues: true,
            },
          },
        },
        orderBy,
        skip,
        take,
      }),
      prisma.job.count({ where }),
    ])

    const enrichedJobs = await enrichJobsWithFinancials(jobs as any[])
    return NextResponse.json({
      jobs: enrichedJobs,
      pagination: createPaginationResponse(total, limit, skip),
    })
  } catch (error) {
    console.error('Get jobs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.create')
  if (permError) return permError

  const user = getAuthUser(request)
  const isMobile = isMobileRequest(request)

  // If mobile request, enforce mobile.jobs.create permission
  if (isMobile) {
    const permError = await requireMobilePermission(request, 'mobile.jobs.create')
    if (permError) return permError
  }

  // Validate request body
  const validation = await validateRequest(request, createJobSchema)
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: validation.status })
  }

  const {
    clientId,
    title,
    description,
    status,
    jobType,
    priority,
    scheduledStart,
    scheduledEnd,
    estimateAmount,
    jobSite,
  } = validation.data

  const resolvedType = await resolveJobTypeForWrite(user.id, user.tenantId, jobType)
  if (!resolvedType.ok) {
    return NextResponse.json({ error: resolvedType.error }, { status: 403 })
  }

  try {

    // Verify client belongs to tenant
    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        tenantId: user.tenantId,
      },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Generate job number
    const jobCount = await prisma.job.count({
      where: { tenantId: user.tenantId },
    })
    const jobNumber = `JOB-${String(jobCount + 1).padStart(6, '0')}`

    // Create job
    const job = await prisma.job.create({
      data: {
        tenantId: user.tenantId,
        clientId,
        jobNumber,
        title,
        description: description || null,
        status: status || 'QUOTE',
        jobType: resolvedType.jobType,
        priority: typeof priority === 'number' ? priority : (priority ? parseInt(String(priority)) : 3),
        scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
        scheduledEnd: scheduledEnd ? new Date(scheduledEnd) : null,
        estimateAmount: estimateAmount ? (typeof estimateAmount === 'string' ? parseFloat(estimateAmount) : estimateAmount) : null,
      },
      include: {
        client: true,
      },
    })

    // Create job site address if provided
    if (jobSite) {
      await prisma.address.create({
        data: {
          jobId: job.id,
          type: 'job_site',
          street: jobSite.street,
          city: jobSite.city,
          state: jobSite.state,
          zipCode: jobSite.zipCode,
          country: jobSite.country || 'US',
          notes: jobSite.notes || null,
        },
      })
    }

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'JOB_CREATED',
        description: `Job "${title}" created for ${client.name}`,
        jobId: job.id,
        clientId,
      },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'CREATE',
        entityType: 'Job',
        entityId: job.id,
        changes: {
          jobNumber,
          title,
          clientId,
          source: isMobile ? 'mobile' : 'web',
        },
      },
    })

    return NextResponse.json({ job }, { status: 201 })
  } catch (error) {
    console.error('Create job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
