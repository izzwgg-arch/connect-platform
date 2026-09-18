import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { jobRecordJobSiteAddressSearchClauses } from '@/lib/search/job-site-address'
import { applySmartSearch, buildSmartSearchAnd, clientIdentityClauses, ilike } from '@/lib/search/prisma-filters'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'dispatch.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0]
  const statusFilter = (searchParams.get('status') || 'all').toLowerCase()
  const search = (searchParams.get('search') || '').trim()
  const dateOnly = searchParams.get('dateOnly') === '1'

  try {
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)
    const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const where: any = {
      tenantId: user.tenantId,
    }

    if (dateOnly) {
      where.AND = [
        {
          OR: [
            { scheduledStart: { gte: startOfDay, lte: endOfDay } },
            { scheduledStart: null },
          ],
        },
      ]
    }

    if (statusFilter === 'assigned') where.assignments = { some: {} }
    else if (statusFilter === 'unassigned') where.assignments = { none: {} }
    else if (statusFilter === 'in_progress') where.status = 'IN_PROGRESS'
    else if (statusFilter === 'completed') where.status = 'COMPLETED'

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { jobNumber: ilike(term) },
        { title: ilike(term) },
        ...clientIdentityClauses(term),
        ...jobRecordJobSiteAddressSearchClauses(term),
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
      ])
    )

    const jobs = await prisma.job.findMany({
      where,
      take: 300,
      include: {
        assignments: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
        client: {
          select: {
            id: true,
            name: true,
          },
        },
        addresses: {
          take: 3,
        },
        _count: {
          select: {
            attachments: true,
            tasks: true,
            issues: true,
          },
        },
      },
      orderBy: [{ priority: 'desc' }, { scheduledStart: 'asc' }, { createdAt: 'desc' }],
    })

    const jobIds = jobs.map((j) => j.id)
    const [recentAttachments, openIssueCounts, completedTaskCounts, conversations, recentEvents] = await Promise.all([
      prisma.attachment.findMany({
        where: { jobId: { in: jobIds }, createdAt: { gte: recentCutoff } },
        select: { jobId: true, mimeType: true, createdAt: true },
      }),
      prisma.issue.groupBy({
        by: ['jobId'],
        where: {
          tenantId: user.tenantId,
          jobId: { in: jobIds },
          status: { in: ['OPEN', 'IN_PROGRESS'] as any[] },
        },
        _count: { _all: true },
      }),
      prisma.task.groupBy({
        by: ['jobId'],
        where: { tenantId: user.tenantId, jobId: { in: jobIds }, status: 'COMPLETED', completedAt: { gte: recentCutoff } },
        _count: { _all: true },
      }),
      prisma.conversation.findMany({
        where: { tenantId: user.tenantId, jobId: { in: jobIds } },
        select: { jobId: true, lastMessageAt: true },
      }),
      prisma.dispatchEvent.findMany({
        where: { tenantId: user.tenantId, jobId: { in: jobIds }, timestamp: { gte: recentCutoff } },
        select: { jobId: true },
      }),
    ])

    const mediaByJob = new Map<string, { photo: number; video: number; file: number }>()
    for (const item of recentAttachments) {
      const jid = item.jobId || ''
      if (!jid) continue
      const prev = mediaByJob.get(jid) || { photo: 0, video: 0, file: 0 }
      if (item.mimeType.startsWith('image/')) prev.photo += 1
      else if (item.mimeType.startsWith('video/')) prev.video += 1
      else prev.file += 1
      mediaByJob.set(jid, prev)
    }

    const openIssuesByJob = new Map<string, number>(openIssueCounts.map((r) => [r.jobId || '', r._count._all]))
    const tasksByJob = new Map<string, number>(completedTaskCounts.map((r) => [r.jobId || '', r._count._all]))
    const recentMessagesByJob = new Map<string, boolean>()
    for (const c of conversations) {
      if (c.jobId && c.lastMessageAt && c.lastMessageAt >= recentCutoff) recentMessagesByJob.set(c.jobId, true)
    }
    const eventsByJob = new Map<string, number>()
    for (const e of recentEvents) {
      const jid = String(e.jobId || '')
      eventsByJob.set(jid, (eventsByJob.get(jid) || 0) + 1)
    }

    const formattedJobs = jobs.map((job) => ({
      id: job.id,
      jobNumber: job.jobNumber,
      title: job.title,
      status: job.status,
      priority: job.priority,
      scheduledStart: job.scheduledStart?.toISOString() || null,
      scheduledEnd: job.scheduledEnd?.toISOString() || null,
      assignments: job.assignments.map((a) => ({
        id: a.user.id,
        firstName: a.user.firstName,
        lastName: a.user.lastName,
        email: a.user.email,
      })),
      assignedTo: job.assignments[0]
        ? {
            id: job.assignments[0].user.id,
            firstName: job.assignments[0].user.firstName,
            lastName: job.assignments[0].user.lastName,
          }
        : null,
      client: {
        id: job.client.id,
        name: job.client.name,
      },
      jobSite:
        (job.addresses.find((a) => String(a.type || '').toLowerCase().includes('job')) || job.addresses[0])
        ? {
            street: (job.addresses.find((a) => String(a.type || '').toLowerCase().includes('job')) || job.addresses[0])!.street,
            city: (job.addresses.find((a) => String(a.type || '').toLowerCase().includes('job')) || job.addresses[0])!.city,
            state: (job.addresses.find((a) => String(a.type || '').toLowerCase().includes('job')) || job.addresses[0])!.state,
            zipCode: (job.addresses.find((a) => String(a.type || '').toLowerCase().includes('job')) || job.addresses[0])!.zipCode,
          }
        : null,
      indicators: {
        newPhoto: (mediaByJob.get(job.id)?.photo || 0) > 0,
        newVideo: (mediaByJob.get(job.id)?.video || 0) > 0,
        newFile: (mediaByJob.get(job.id)?.file || 0) > 0,
        newMessage: Boolean(recentMessagesByJob.get(job.id)),
        issueReported: (openIssuesByJob.get(job.id) || 0) > 0,
        taskCompleted: (tasksByJob.get(job.id) || 0) > 0,
        recentActivityCount: eventsByJob.get(job.id) || 0,
      },
      counts: {
        attachments: job._count.attachments,
        tasks: job._count.tasks,
        issues: job._count.issues,
        openIssues: openIssuesByJob.get(job.id) || 0,
      },
    }))

    return NextResponse.json({ jobs: formattedJobs, generatedAt: new Date().toISOString() })
  } catch (error) {
    console.error('Dispatch jobs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
