import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { applySmartSearch, buildSmartSearchAnd, clientIdentityClauses, ilike } from '@/lib/search/prisma-filters'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'calls.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const direction = searchParams.get('direction') || 'all'
  const status = searchParams.get('status') || 'all'
  const clientId = searchParams.get('clientId') || ''
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const skip = (page - 1) * limit

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    if (direction !== 'all') {
      where.direction = direction
    }

    if (status !== 'all') {
      where.status = status
    }

    if (clientId) {
      where.clientId = clientId
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { fromNumber: ilike(term) },
        { toNumber: ilike(term) },
        ...clientIdentityClauses(term),
        { contact: { firstName: ilike(term) } },
        { contact: { lastName: ilike(term) } },
        { contact: { phone: ilike(term) } },
        { job: { jobNumber: ilike(term) } },
        { job: { title: ilike(term) } },
        { user: { firstName: ilike(term) } },
        { user: { lastName: ilike(term) } },
      ])
    )

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          client: {
            select: {
              id: true,
              name: true,
            },
          },
          contact: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          job: {
            select: {
              id: true,
              jobNumber: true,
            },
          },
        },
        orderBy: {
          startedAt: 'desc',
        },
        skip,
        take: limit,
      }),
      prisma.call.count({ where }),
    ])

    return NextResponse.json({
      calls,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get calls error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'calls.send')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      direction,
      status,
      fromNumber,
      toNumber,
      duration,
      recordingUrl,
      clientId,
      contactId,
      jobId,
      leadId,
      startedAt,
      answeredAt,
      endedAt,
    } = body

    if (!direction || !status || !fromNumber || !toNumber) {
      return NextResponse.json({ error: 'Direction, status, from, and to are required' }, { status: 400 })
    }

    // Create call record
    const call = await prisma.call.create({
      data: {
        tenantId: user.tenantId,
        direction,
        status,
        fromNumber,
        toNumber,
        duration: duration || null,
        recordingUrl: recordingUrl || null,
        userId: user.id,
        clientId: clientId || null,
        contactId: contactId || null,
        jobId: jobId || null,
        leadId: leadId || null,
        startedAt: startedAt ? new Date(startedAt) : new Date(),
        answeredAt: answeredAt ? new Date(answeredAt) : null,
        endedAt: endedAt ? new Date(endedAt) : null,
      },
      include: {
        client: true,
        contact: true,
        job: true,
      },
    })

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'CALL_MADE',
        description: `${direction === 'INBOUND' ? 'Inbound' : 'Outbound'} call ${status === 'ANSWERED' ? 'answered' : status.toLowerCase()}`,
        callId: call.id,
        clientId: clientId || undefined,
        jobId: jobId || undefined,
        leadId: leadId || undefined,
      },
    })

    // Create task for missed calls
    if (status === 'MISSED') {
      await prisma.task.create({
        data: {
          tenantId: user.tenantId,
          title: `Follow up on missed call from ${fromNumber}`,
          description: `Missed ${direction === 'INBOUND' ? 'inbound' : 'outbound'} call`,
          status: 'TODO',
          priority: 'HIGH',
          assigneeId: user.id,
          createdById: user.id,
          clientId: clientId || null,
          leadId: leadId || null,
          jobId: jobId || null,
          callId: call.id,
        },
      })

      // Create notification
      await prisma.notification.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          type: 'INCOMING_CALL',
          title: 'Missed Call',
          message: `Missed call from ${fromNumber}`,
          linkType: 'call',
          linkId: call.id,
          linkUrl: `/dashboard/calls/${call.id}`,
        },
      })
    }

    return NextResponse.json({ call }, { status: 201 })
  } catch (error) {
    console.error('Create call error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
