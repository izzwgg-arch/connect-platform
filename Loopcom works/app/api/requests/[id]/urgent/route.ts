import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireWebOrAnyMobilePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { buildUrgentUpdateData } from '@/lib/requests/urgent'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireWebOrAnyMobilePermission(request, 'leads.edit', [
    'mobile.requests.edit',
    'mobile.requests.view',
  ])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const isUrgent = Boolean(body?.isUrgent)

    const existing = await prisma.lead.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: {
        id: true,
        isUrgent: true,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: "You don't have access to this request" }, { status: 404 })
    }

    const lead = await prisma.lead.update({
      where: { id: params.id },
      data: buildUrgentUpdateData(isUrgent, user.id),
      include: {
        assignedTo: {
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
        _count: {
          select: {
            estimates: true,
            calls: true,
            smsMessages: true,
            emails: true,
          },
        },
      },
    })

    return NextResponse.json({
      lead,
      requestId: lead.id,
      isUrgent: lead.isUrgent,
      urgentAt: lead.urgentAt,
      urgentByUserId: lead.urgentByUserId,
    })
  } catch (error) {
    console.error('Update request urgent error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
