import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'dispatch.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const job = await prisma.job.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      include: {
        client: {
          select: { id: true, name: true, phone: true, email: true },
        },
        assignments: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
        addresses: true,
        attachments: { orderBy: { createdAt: 'desc' }, take: 200 },
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: {
            assignee: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        issues: {
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: {
            assignee: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        dispatchEvents: { orderBy: { timestamp: 'desc' }, take: 300 },
        conversations: {
          take: 1,
          where: { metadata: { path: ['kind'], equals: 'DISPATCH_JOB_CHAT' } },
          include: {
            messages: { orderBy: { createdAt: 'asc' }, include: { media: true }, take: 300 },
          },
        },
      },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const jobSite = job.addresses.find((a) => String(a.type || '').toLowerCase().includes('job')) || job.addresses[0] || null

    return NextResponse.json({
      job: {
        id: job.id,
        jobNumber: job.jobNumber,
        title: job.title,
        description: job.description,
        status: job.status,
        priority: job.priority,
        scheduledStart: job.scheduledStart?.toISOString() || null,
        scheduledEnd: job.scheduledEnd?.toISOString() || null,
        client: job.client,
        assignments: job.assignments.map((a) => ({
          id: a.user.id,
          firstName: a.user.firstName,
          lastName: a.user.lastName,
          email: a.user.email,
        })),
        jobSite: jobSite
          ? {
              street: jobSite.street,
              city: jobSite.city,
              state: jobSite.state,
              zipCode: jobSite.zipCode,
            }
          : null,
      },
      media: job.attachments,
      tasks: job.tasks,
      issues: job.issues,
      activityLog: job.dispatchEvents,
      messages: job.conversations[0]?.messages || [],
      conversationId: job.conversations[0]?.id || null,
    })
  } catch (error) {
    console.error('Dispatch job detail error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

