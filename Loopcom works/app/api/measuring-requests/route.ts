import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { createNotification } from '@/lib/notifications'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'

function toApiStatus(status: 'PENDING' | 'OPENED' | 'COMPLETED') {
  return status.toLowerCase()
}

function parseStatusFilter(value: string | null): 'PENDING' | 'OPENED' | 'COMPLETED' | 'ALL' {
  const normalized = String(value || 'ALL').trim().toUpperCase()
  if (normalized === 'PENDING' || normalized === 'OPENED' || normalized === 'COMPLETED') return normalized
  return 'ALL'
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.view')
  if (permError) return permError
  const user = getAuthUser(request)

  const searchParams = request.nextUrl.searchParams
  const statusFilter = parseStatusFilter(searchParams.get('status'))
  const assignedUserId = String(searchParams.get('assignedUserId') || '').trim()
  const search = String(searchParams.get('search') || '').trim()
  const pageRaw = Number.parseInt(String(searchParams.get('page') || '1'), 10)
  const limitRaw = Number.parseInt(String(searchParams.get('limit') || '50'), 10)
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50
  const skip = (page - 1) * limit

  const where: any = {
    tenantId: user.tenantId,
    ...(statusFilter === 'ALL' ? {} : { status: statusFilter }),
    ...(assignedUserId ? { assignedUserId } : {}),
  }

  applySmartSearch(
    where,
    buildSmartSearchAnd(search, (term) => [
      { request: { firstName: ilike(term) } },
      { request: { lastName: ilike(term) } },
      { request: { company: ilike(term) } },
      { request: { jobSiteAddress: ilike(term) } },
      { request: { phone: ilike(term) } },
      { request: { email: ilike(term) } },
      { notes: ilike(term) },
      { assignedUser: { firstName: ilike(term) } },
      { assignedUser: { lastName: ilike(term) } },
    ])
  )

  const [rows, total] = await Promise.all([
    prisma.measuringRequest.findMany({
      where,
      include: {
        request: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            company: true,
            jobSiteAddress: true,
          },
        },
        assignedUser: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        createdByUser: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.measuringRequest.count({ where }),
  ])

  return NextResponse.json({
    measuringRequests: rows.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      assignedUserId: row.assignedUserId,
      createdByUserId: row.createdByUserId,
      status: toApiStatus(row.status),
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      openedAt: row.openedAt?.toISOString() || null,
      completedAt: row.completedAt?.toISOString() || null,
      lastNotificationAt: row.lastNotificationAt?.toISOString() || null,
      notificationAttempts: row.notificationAttempts,
      request: {
        id: row.request.id,
        customerName: row.request.company || `${row.request.firstName} ${row.request.lastName}`.trim(),
        firstName: row.request.firstName,
        lastName: row.request.lastName,
        company: row.request.company,
        address: row.request.jobSiteAddress || null,
      },
      assignedUser: row.assignedUser,
      createdByUser: row.createdByUser,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  })
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.create')
  if (permError) return permError
  const user = getAuthUser(request)

  const body = await request.json().catch(() => ({}))
  const requestId = String(body?.requestId || '').trim()
  const assignedUserId = String(body?.assignedUserId || '').trim()
  const notes = String(body?.notes || '').trim()

  if (!requestId || !assignedUserId) {
    return NextResponse.json({ error: 'requestId and assignedUserId are required' }, { status: 400 })
  }

  const [lead, assignee] = await Promise.all([
    prisma.lead.findFirst({
      where: { id: requestId, tenantId: user.tenantId },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.user.findFirst({
      where: { id: assignedUserId, tenantId: user.tenantId, status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true },
    }),
  ])

  if (!lead) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  }
  if (!assignee) {
    return NextResponse.json({ error: 'Assigned user not found' }, { status: 404 })
  }

  const created = await prisma.measuringRequest.create({
    data: {
      tenantId: user.tenantId,
      requestId: lead.id,
      assignedUserId: assignee.id,
      createdByUserId: user.id,
      status: 'PENDING',
      notes: notes || null,
    },
  })

  const notificationResult = await createNotification({
    tenantId: user.tenantId,
    userId: assignee.id,
    type: 'OTHER',
    title: 'New measuring request assigned.',
    message: `${lead.firstName} ${lead.lastName}`,
    linkType: 'measuring_request',
    linkId: String(created.id),
    linkUrl: `/dashboard/requests/${lead.id}`,
    action: 'measuring_request_assigned',
    actorUserId: user.id,
  })

  await prisma.measuringRequest.update({
    where: { id: created.id },
    data: {
      lastNotificationAt: new Date(),
      notificationAttempts: 1,
    },
  })

  return NextResponse.json(
    {
      measuringRequest: {
        id: created.id,
        requestId: created.requestId,
        assignedUserId: created.assignedUserId,
        createdByUserId: created.createdByUserId,
        status: toApiStatus(created.status),
        notes: created.notes,
        createdAt: created.createdAt.toISOString(),
      },
      notification: {
        ok: notificationResult.ok,
      },
    },
    { status: 201 }
  )
}
