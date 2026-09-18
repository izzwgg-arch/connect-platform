import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireMobilePermission, hasMobilePermission } from '@/lib/authorization'
import { normalizePublicFileUrl } from '@/lib/public-url'
import { getJobTimeSummary } from '@/lib/time-tracking'
import { getJobBillingStatus } from '@/lib/jobs/billing-status'

/**
 * Mobile API: Get single job details (parity with web job detail payload).
 * - mobile.jobs.view_all: any job
 * - otherwise: assigned jobs only
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requireMobilePermission(request, 'mobile.jobs.view_assigned')
  if (permError) return permError

  const user = getAuthUser(request)
  const jobId = params.id

  try {
    const canViewAll = await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.view_all')

    const where: any = {
      id: jobId,
      tenantId: user.tenantId,
    }

    if (!canViewAll) {
      where.assignments = {
        some: {
          userId: user.id,
        },
      }
    }

    const job = await prisma.job.findFirst({
      where,
      include: {
        client: {
          select: {
            id: true,
            name: true,
            companyName: true,
            email: true,
            phone: true,
            contacts: {
              where: { isPrimary: true },
              take: 1,
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
                title: true,
              },
            },
          },
        },
        addresses: {
          where: { type: 'job_site' },
          take: 1,
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
          select: {
            id: true,
            invoiceNumber: true,
            total: true,
            balance: true,
            status: true,
            createdAt: true,
          },
        },
        purchaseOrders: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            poNumber: true,
            status: true,
            total: true,
            createdAt: true,
          },
        },
        notes: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            content: true,
            createdAt: true,
            createdById: true,
          },
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

    const taskWhere = { tenantId: user.tenantId, jobId: job.id }
    const issueWhere = { tenantId: user.tenantId, jobId: job.id }

    const [tasks, issues, attachments, summary, activeTimers, jobInvoiceAgg, clientOpenAgg, payments] =
      await Promise.all([
        prisma.task.findMany({
          where: taskWhere,
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            dueDate: true,
            description: true,
            createdAt: true,
            updatedAt: true,
            assignee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
          orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
          take: 200,
        }),
        prisma.issue.findMany({
          where: issueWhere,
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            description: true,
            createdAt: true,
            updatedAt: true,
            assignee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
          orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
          take: 200,
        }),
        prisma.attachment.findMany({
          where: { jobId: job.id },
          select: {
            id: true,
            fileName: true,
            url: true,
            mimeType: true,
            fileSize: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 300,
        }),
        getJobTimeSummary(user.tenantId, job.id, job.hourlyRateCents ?? null),
        prisma.timeEntry.findMany({
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
        }),
        prisma.invoice.aggregate({
          where: {
            tenantId: user.tenantId,
            jobId: job.id,
            status: { notIn: ['CANCELLED', 'REFUNDED'] as any },
          } as any,
          _sum: { total: true, balance: true },
          _count: { id: true },
        }),
        prisma.invoice.aggregate({
          where: {
            tenantId: user.tenantId,
            clientId: job.clientId,
            balance: { gt: 0 },
            status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
          } as any,
          _sum: { balance: true },
        }),
        prisma.payment.findMany({
          where: {
            invoice: {
              tenantId: user.tenantId,
              jobId: job.id,
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            amount: true,
            status: true,
            processedAt: true,
            createdAt: true,
            method: true,
            reference: true,
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
              },
            },
          },
        }),
      ])

    const noteAuthorIds = Array.from(
      new Set(job.notes.map((note) => note.createdById).filter(Boolean) as string[])
    )
    const noteAuthors =
      noteAuthorIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: noteAuthorIds }, tenantId: user.tenantId },
            select: { id: true, firstName: true, lastName: true },
          })
        : []
    const noteAuthorById = new Map(noteAuthors.map((author) => [author.id, author]))

    const activeSession = activeTimers.find((entry) => entry.workerId === user.id) || null
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todaySummary = await prisma.timeEntry.aggregate({
      where: {
        tenantId: user.tenantId,
        jobId: job.id,
        workerId: user.id,
        status: 'STOPPED',
        deletedAt: null,
        createdAt: { gte: todayStart },
      },
      _sum: {
        durationMinutes: true,
      },
    })

    const address = job.addresses[0] || null

    return NextResponse.json({
      job: {
        id: job.id,
        jobNumber: job.jobNumber,
        title: job.title,
        description: job.description,
        status: job.status,
        jobType: job.jobType || null,
        priority: job.priority,
        scheduledStart: job.scheduledStart?.toISOString() || null,
        scheduledEnd: job.scheduledEnd?.toISOString() || null,
        actualStart: job.actualStart?.toISOString() || null,
        actualEnd: job.actualEnd?.toISOString() || null,
        estimateAmount: job.estimateAmount?.toString() || null,
        actualAmount: job.actualAmount?.toString() || null,
        laborCost: job.laborCost?.toString() || null,
        materialCost: job.materialCost?.toString() || null,
        totalCost: job.actualAmount?.toString() || job.estimateAmount?.toString() || null,
        totalInvoicedAmount: jobInvoiceAgg._sum.total?.toString() || '0',
        openInvoiceBalance: jobInvoiceAgg._sum.balance?.toString() || '0',
        openInvoiceCount: Number(jobInvoiceAgg._count?.id || 0),
        clientOpenInvoiceBalance: clientOpenAgg._sum.balance?.toString() || '0',
        billingStatus: getJobBillingStatus({
          estimateAmount: job.estimateAmount,
          actualAmount: job.actualAmount,
          totalInvoicedAmount: jobInvoiceAgg._sum.total?.toString() || '0',
          invoices: job.invoices || [],
        }),
        chargeByHour: job.chargeByHour,
        hourlyRateCents: job.hourlyRateCents,
        billableMinutesTotal: summary.totalMinutes,
        billableHours: summary.billableHours,
        billableAmountCents: summary.billableAmountCents,
        createdAt: job.createdAt.toISOString(),
        client: job.client,
        address,
        jobSite: address
          ? {
              id: address.id,
              street: address.street,
              city: address.city,
              state: address.state,
              zipCode: address.zipCode,
              country: address.country,
            }
          : null,
        assignedTo: job.assignments[0]?.user || null,
        assignments: job.assignments.map((assignment) => ({
          id: assignment.id,
          role: assignment.role,
          notes: assignment.notes,
          user: assignment.user,
        })),
        estimates: job.estimates.map((est) => ({
          id: est.id,
          estimateNumber: est.estimateNumber,
          title: est.title,
          status: est.status,
          total: est.total.toString(),
          createdAt: est.createdAt.toISOString(),
        })),
        invoices: job.invoices.map((inv) => ({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          total: inv.total.toString(),
          balance: inv.balance.toString(),
          paidAmount: inv.paidAmount?.toString?.() || String(inv.paidAmount ?? '0'),
          dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
          status: inv.status,
          createdAt: inv.createdAt.toISOString(),
        })),
        purchaseOrders: job.purchaseOrders.map((po) => ({
          id: po.id,
          poNumber: po.poNumber,
          status: po.status,
          total: po.total?.toString?.() ?? String(po.total ?? '0'),
          createdAt: po.createdAt.toISOString(),
        })),
        payments: payments.map((payment) => ({
          id: payment.id,
          amount: payment.amount.toString(),
          status: payment.status,
          paymentDate: (payment.processedAt || payment.createdAt).toISOString(),
          method: payment.method,
          reference: payment.reference,
          invoiceNumber: payment.invoice?.invoiceNumber || null,
          invoiceId: payment.invoice?.id || null,
        })),
        notes: job.notes.map((note) => {
          const author = note.createdById ? noteAuthorById.get(note.createdById) : null
          return {
            id: note.id,
            content: note.content,
            createdAt: note.createdAt.toISOString(),
            createdBy: author
              ? {
                  id: author.id,
                  name: `${author.firstName || ''} ${author.lastName || ''}`.trim(),
                }
              : null,
          }
        }),
        schedules: job.schedules.map((schedule) => ({
          id: schedule.id,
          startTime: schedule.startTime.toISOString(),
          endTime: schedule.endTime.toISOString(),
          user: schedule.user
            ? {
                id: schedule.user.id,
                firstName: schedule.user.firstName,
                lastName: schedule.user.lastName,
              }
            : null,
        })),
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate?.toISOString() || null,
          createdAt: task.createdAt.toISOString(),
          updatedAt: task.updatedAt.toISOString(),
          shortDescription: (task.description || '').slice(0, 160),
          assignedTo: task.assignee
            ? {
                id: task.assignee.id,
                name: `${task.assignee.firstName} ${task.assignee.lastName}`.trim(),
              }
            : null,
        })),
        issues: issues.map((issue) => ({
          id: issue.id,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          createdAt: issue.createdAt.toISOString(),
          updatedAt: issue.updatedAt.toISOString(),
          shortDescription: (issue.description || '').slice(0, 160),
          assignedTo: issue.assignee
            ? {
                id: issue.assignee.id,
                name: `${issue.assignee.firstName} ${issue.assignee.lastName}`.trim(),
              }
            : null,
        })),
        attachments: attachments.map((attachment) => ({
          ...attachment,
          url: normalizePublicFileUrl(attachment.url, request),
          createdAt: attachment.createdAt.toISOString(),
        })),
        activeTimers: activeTimers.map((entry) => ({
          id: entry.id,
          startedAt: entry.startedAt?.toISOString() || entry.createdAt.toISOString(),
          worker: entry.worker,
        })),
        currentUserActiveSession: activeSession
          ? {
              id: activeSession.id,
              startedAt: activeSession.startedAt?.toISOString() || activeSession.createdAt.toISOString(),
            }
          : null,
        currentUserTodayMinutes: Number(todaySummary._sum.durationMinutes || 0),
        _count: job._count,
      },
    })
  } catch (error) {
    console.error('Mobile job detail error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
