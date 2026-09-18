import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const source = await prisma.lead.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!source) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    }

    const duplicate = await prisma.lead.create({
      data: {
        tenantId: user.tenantId,
        firstName: source.firstName,
        lastName: source.lastName,
        email: source.email,
        phone: source.phone,
        company: source.company,
        source: source.source,
        status: 'NEW',
        jobType: source.jobType,
        value: source.value,
        probability: source.probability ?? 50,
        notes: source.notes,
        jobSiteAddress: source.jobSiteAddress,
        assignedToId: source.assignedToId,
        convertedToClientId: null,
        convertedAt: null,
      },
    })

    return NextResponse.json({ lead: duplicate, id: duplicate.id }, { status: 201 })
  } catch (error) {
    console.error('Duplicate request error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
