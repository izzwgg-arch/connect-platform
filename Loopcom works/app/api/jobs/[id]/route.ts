import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission, requireWebOrMobilePermission, isMobileRequest, requireMobilePermission, hasMobilePermission, hasPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { formatAddressParts, parseAddressParts } from '@/lib/address/parse'
import { geocodeAddressPartsFromString } from '@/lib/geocoding'
import { getJobTimeSummary } from '@/lib/time-tracking'
import { syncAutoJobSchedules } from '@/lib/services/job-schedule-sync'
import { createNotificationsForUsers, notifyJobStatusChanged } from '@/lib/notifications'
import { getJobBillingStatus } from '@/lib/jobs/billing-status'
import { assertCanAccessJobType, resolveJobTypeForWrite } from '@/lib/jobs/job-type-scope'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireWebOrMobilePermission(
    request,
    'jobs.view',
    'mobile.jobs.view_all'
  )
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const job = await prisma.job.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        client: {
          include: {
            contacts: {
              where: { isPrimary: true },
              take: 1,
            },
          },
        },
        addresses: true,
        estimates: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            estimateNumber: true,
            title: true,
            status: true,
            total: true,
            createdAt: true,
          },
        },
        invoices: {
          orderBy: { createdAt: 'desc' },
          include: {
            lineItems: true,
          },
        },
        purchaseOrders: {
          orderBy: { createdAt: 'desc' },
          include: {
            lineItems: true,
          },
        },
        assignments: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        tasks: {
          orderBy: { createdAt: 'desc' },
          include: {
            assignee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        issues: {
          orderBy: { createdAt: 'desc' },
          include: {
            assignee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        calls: {
          orderBy: { startedAt: 'desc' },
          take: 20,
        },
        smsMessages: {
          orderBy: { sentAt: 'desc' },
          take: 20,
        },
        emails: {
          orderBy: { sentAt: 'desc' },
          take: 20,
        },
        notes: {
          orderBy: { createdAt: 'desc' },
        },
        attachments: {
          orderBy: { createdAt: 'desc' },
        },
        schedules: {
          orderBy: { startTime: 'asc' },
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
        _count: {
          select: {
            tasks: true,
            issues: true,
            invoices: true,
            estimates: true,
          },
        },
      },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const typeAccess = await assertCanAccessJobType(user.id, user.tenantId, job.jobType)
    if (!typeAccess.ok) {
      return NextResponse.json({ error: typeAccess.error }, { status: 403 })
    }

    const summary = await getJobTimeSummary(user.tenantId, job.id, job.hourlyRateCents ?? null)
    const activeTimers = await prisma.timeEntry.findMany({
      where: {
        tenantId: user.tenantId,
        jobId: job.id,
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: {
        worker: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { startedAt: 'asc' },
    })

    // Financial aggregates for visibility on job detail and related screens.
    const [jobInvoiceAgg, clientOpenAgg] = await Promise.all([
      prisma.invoice.aggregate({
        where: {
          tenantId: user.tenantId,
          jobId: job.id,
          status: { notIn: ['CANCELLED', 'REFUNDED'] as any },
        } as any,
        _sum: {
          total: true,
          balance: true,
        },
        _count: {
          id: true,
        },
      }),
      prisma.invoice.aggregate({
        where: {
          tenantId: user.tenantId,
          clientId: job.clientId,
          balance: { gt: 0 },
          status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
        } as any,
        _sum: {
          balance: true,
        },
      }),
    ])

    // Find job site address
    const addresses = job.addresses || []
    const jobSite = addresses.find(addr => addr.type === 'job_site') || null
    const jobSiteAddress = formatAddressParts(jobSite)
    const parsedJobSite = parseAddressParts(jobSiteAddress)
    const missingJobSiteParts =
      !!jobSiteAddress &&
      (!parsedJobSite || !parsedJobSite.city || !parsedJobSite.state || !parsedJobSite.zipCode)
    const geo = missingJobSiteParts ? await geocodeAddressPartsFromString(jobSiteAddress!) : null

    const derivedJobSite = {
      city: (jobSite?.city || geo?.city || '').trim() || null,
      state: (jobSite?.state || geo?.state || '').trim() || null,
      zipCode: (jobSite?.zipCode || geo?.zipCode || '').trim() || null,
      street: (jobSite?.street || geo?.street || '').trim() || null,
      country: (jobSite?.country || geo?.country || '').trim() || null,
    }

    const { estimates: linkedEstimates = [], ...jobRecord } = job

    // Ensure arrays are initialized
    const safeJob = {
      ...jobRecord,
      addresses: addresses,
      assignments: job.assignments || [],
      tasks: job.tasks || [],
      issues: job.issues || [],
      invoices: job.invoices || [],
      notes: job.notes || [],
      schedules: job.schedules || [],
      client: {
        ...job.client,
        contacts: job.client.contacts || [],
      },
    }

    // Transform job to match frontend expectations
    const jobResponse = {
      ...safeJob,
      jobSiteAddress,
      jobSiteCity: (parsedJobSite?.city || derivedJobSite.city || '').trim() || null,
      jobSiteState: (parsedJobSite?.state || derivedJobSite.state || '').trim() || null,
      jobSiteZipCode: (parsedJobSite?.zipCode || derivedJobSite.zipCode || '').trim() || null,
      jobSite: jobSite ? {
        id: jobSite.id,
        street: derivedJobSite.street || jobSite.street,
        city: derivedJobSite.city || jobSite.city,
        state: derivedJobSite.state || jobSite.state,
        zipCode: derivedJobSite.zipCode || jobSite.zipCode,
        country: derivedJobSite.country || jobSite.country,
      } : null,
      estimateAmount: job.estimateAmount ? job.estimateAmount.toString() : null,
      actualAmount: job.actualAmount ? job.actualAmount.toString() : null,
      laborCost: job.laborCost ? job.laborCost.toString() : null,
      materialCost: job.materialCost ? job.materialCost.toString() : null,
      chargeByHour: job.chargeByHour,
      hourlyRateCents: job.hourlyRateCents,
      billableMinutesTotal: summary.totalMinutes,
      billableHours: summary.billableHours,
      billableAmountCents: summary.billableAmountCents,
      activeTimers,
      totalCost: job.actualAmount ? job.actualAmount.toString() : (job.estimateAmount ? job.estimateAmount.toString() : null),
      totalInvoicedAmount: jobInvoiceAgg._sum.total?.toString() || '0',
      openInvoiceBalance: jobInvoiceAgg._sum.balance?.toString() || '0',
      openInvoiceCount: Number(jobInvoiceAgg._count?.id || 0),
      clientOpenInvoiceBalance: clientOpenAgg._sum.balance?.toString() || '0',
      billingStatus: getJobBillingStatus({
        estimateAmount: job.estimateAmount,
        actualAmount: job.actualAmount,
        totalInvoicedAmount: jobInvoiceAgg._sum.total?.toString() || '0',
        invoices: safeJob.invoices || [],
      }),
      invoices: safeJob.invoices.map(inv => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        total: inv.total.toString(),
        balance: inv.balance.toString(),
        paidAmount: inv.paidAmount?.toString?.() || String(inv.paidAmount ?? '0'),
        dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
        status: inv.status,
      })),
      estimates: linkedEstimates.map((est) => ({
        id: est.id,
        estimateNumber: est.estimateNumber,
        title: est.title,
        status: est.status,
        total: est.total.toString(),
        createdAt: est.createdAt.toISOString(),
      })),
    }

    return NextResponse.json({ job: jobResponse })
  } catch (error) {
    console.error('Get job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.edit')
  if (permError) return permError

  const user = getAuthUser(request)
  const isMobile = isMobileRequest(request)

  try {
    const body = await request.json()
    const {
      title,
      description,
      status,
      priority,
      scheduledStart,
      scheduledEnd,
      actualStart,
      actualEnd,
      estimateAmount,
      actualAmount,
      laborCost,
      materialCost,
      chargeByHour,
      hourlyRateCents,
      jobSite,
      jobType,
    } = body

    // If mobile request, enforce permissions based on what's being changed
    if (isMobile) {
      // Check if user has edit permission
      const permError = await requireMobilePermission(request, 'mobile.jobs.edit')
      if (permError) return permError

      // Check specific permissions for specific fields
      if (status !== undefined && status !== null) {
        const statusPermError = await requireMobilePermission(request, 'mobile.jobs.status')
        if (statusPermError) return statusPermError
      }

      if (scheduledStart !== undefined || scheduledEnd !== undefined) {
        const schedulePermError = await requireMobilePermission(request, 'mobile.jobs.schedule')
        if (schedulePermError) return schedulePermError
      }
    }

    // Get existing job
    const existing = await prisma.job.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const existingTypeAccess = await assertCanAccessJobType(user.id, user.tenantId, existing.jobType)
    if (!existingTypeAccess.ok) {
      return NextResponse.json({ error: existingTypeAccess.error }, { status: 403 })
    }

    let nextJobType = existing.jobType
    if (jobType !== undefined) {
      const nextTypeAccess = await resolveJobTypeForWrite(user.id, user.tenantId, jobType, existing.jobType)
      if (!nextTypeAccess.ok) {
        return NextResponse.json({ error: nextTypeAccess.error }, { status: 403 })
      }
      nextJobType = nextTypeAccess.jobType
    }

    // Track status change for activity
    const statusChanged = status && status !== existing.status
    const hasHourlyBillingPermission =
      user.role === 'ADMIN' || (await hasPermission(user.id, user.tenantId, 'web.jobs.set_hourly_billing'))
    const wantsBillingUpdate = chargeByHour !== undefined || hourlyRateCents !== undefined
    if (wantsBillingUpdate && !hasHourlyBillingPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (hourlyRateCents !== undefined && hourlyRateCents !== null && hourlyRateCents !== '' && Number(hourlyRateCents) < 0) {
      return NextResponse.json({ error: 'Hourly rate cannot be negative' }, { status: 400 })
    }

    // Update job
    const sanitizedTitle =
      title !== undefined ? String(title).replace(/[\r\n\t]+/g, ' ').trim() : undefined
    const job = await prisma.job.update({
      where: { id: params.id },
      data: {
        title: sanitizedTitle !== undefined ? sanitizedTitle : existing.title,
        description: description !== undefined ? description : existing.description,
        status: status !== undefined ? status : existing.status,
        jobType: nextJobType,
        priority: priority !== undefined ? priority : existing.priority,
        scheduledStart: scheduledStart !== undefined ? (scheduledStart ? new Date(scheduledStart) : null) : existing.scheduledStart,
        scheduledEnd: scheduledEnd !== undefined ? (scheduledEnd ? new Date(scheduledEnd) : null) : existing.scheduledEnd,
        actualStart: actualStart !== undefined ? (actualStart ? new Date(actualStart) : null) : existing.actualStart,
        actualEnd: actualEnd !== undefined ? (actualEnd ? new Date(actualEnd) : null) : existing.actualEnd,
        estimateAmount: estimateAmount !== undefined ? parseFloat(estimateAmount) : existing.estimateAmount,
        actualAmount: actualAmount !== undefined ? parseFloat(actualAmount) : existing.actualAmount,
        laborCost: laborCost !== undefined ? parseFloat(laborCost) : existing.laborCost,
        materialCost: materialCost !== undefined ? parseFloat(materialCost) : existing.materialCost,
        chargeByHour: chargeByHour !== undefined ? Boolean(chargeByHour) : existing.chargeByHour,
        hourlyRateCents:
          hourlyRateCents !== undefined
            ? (hourlyRateCents === null || hourlyRateCents === '' ? null : Number(hourlyRateCents))
            : existing.hourlyRateCents,
      },
    })

    // Upsert job site address (type: job_site) when provided.
    // - jobSite: null => delete existing job_site address
    // - jobSite: { street... } => upsert
    if (jobSite === null) {
      await prisma.address.deleteMany({
        where: { jobId: job.id, type: 'job_site' },
      })
    } else if (jobSite && typeof jobSite === 'object' && String(jobSite.street || '').trim()) {
      const existingJobSite = await prisma.address.findFirst({
        where: { jobId: job.id, type: 'job_site' },
      })
      const data = {
        street: String(jobSite.street || '').trim(),
        city: String(jobSite.city || '').trim(),
        state: String(jobSite.state || '').trim(),
        zipCode: String(jobSite.zipCode || '').trim(),
        country: String(jobSite.country || 'US').trim() || 'US',
        notes: jobSite.notes ? String(jobSite.notes) : null,
      }
      if (existingJobSite) {
        await prisma.address.update({
          where: { id: existingJobSite.id },
          data,
        })
      } else {
        await prisma.address.create({
          data: {
            jobId: job.id,
            type: 'job_site',
            ...data,
          },
        })
      }
    }

    // Keep auto-generated schedule rows in sync for assigned users.
    const scheduleChanged = scheduledStart !== undefined || scheduledEnd !== undefined
    if (scheduleChanged) {
      const assignments = await prisma.jobAssignment.findMany({
        where: {
          jobId: job.id,
          job: { tenantId: user.tenantId },
        },
        select: { userId: true },
      })
      const assignedUserIds = assignments.map((a) => a.userId)
      await syncAutoJobSchedules(prisma, {
        tenantId: user.tenantId,
        jobId: job.id,
        jobNumber: job.jobNumber,
        jobTitle: job.title,
        userIds: assignedUserIds,
        scheduledStart: job.scheduledStart,
        scheduledEnd: job.scheduledEnd,
      })

      const scheduleLabel = job.scheduledStart
        ? new Date(job.scheduledStart).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : null
      if (assignedUserIds.length > 0) {
        await createNotificationsForUsers(user.tenantId, assignedUserIds, {
          type: 'JOB_UPDATED',
          title: 'Job Schedule Updated',
          message: scheduleLabel
            ? `${job.jobNumber} is scheduled for ${scheduleLabel}.`
            : `${job.jobNumber} schedule was updated.`,
          linkUrl: `/dashboard/jobs/${job.id}`,
          linkType: 'job',
          linkId: job.id,
          actorUserId: user.id,
          action: 'job_schedule_updated',
        })
      }
    }

    // Create activity if status changed
    if (statusChanged) {
      await prisma.activity.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          type: 'JOB_STATUS_CHANGED',
          description: `Job "${job.title}" status changed from ${existing.status} to ${job.status}`,
          jobId: job.id,
          clientId: job.clientId,
        },
      })

      await notifyJobStatusChanged({
        tenantId: user.tenantId,
        jobId: job.id,
        jobNumber: job.jobNumber,
        jobTitle: job.title,
        oldStatus: existing.status,
        newStatus: job.status,
        actorUserId: user.id,
      })
    }

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Job',
        entityId: job.id,
        changes: {
          before: {
            status: existing.status,
            title: existing.title,
            chargeByHour: existing.chargeByHour,
            hourlyRateCents: existing.hourlyRateCents,
          },
          after: {
            status: job.status,
            title: job.title,
            chargeByHour: job.chargeByHour,
            hourlyRateCents: job.hourlyRateCents,
          },
        },
      },
    })

    return NextResponse.json({ job })
  } catch (error) {
    console.error('Update job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const job = await prisma.job.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // Don't delete if job has invoices
    const hasInvoices = await prisma.invoice.count({
      where: { jobId: params.id },
    })

    if (hasInvoices > 0) {
      return NextResponse.json(
        { error: 'Cannot delete job with invoices. Cancel it instead.' },
        { status: 400 }
      )
    }

    // Delete related data first (cascade should handle most, but being explicit for safety)
    await prisma.jobAssignment.deleteMany({
      where: { jobId: params.id },
    })

    await prisma.address.deleteMany({
      where: { jobId: params.id },
    })

    // Actually delete the job
    await prisma.job.delete({
      where: { id: params.id },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entityType: 'Job',
        entityId: job.id,
      },
    })

    return NextResponse.json({ message: 'Job deleted successfully' })
  } catch (error) {
    console.error('Delete job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
