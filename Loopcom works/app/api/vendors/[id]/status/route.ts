import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { status } = body

    if (!status || !['ACTIVE', 'INACTIVE'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    // Verify vendor exists
    const vendor = await prisma.vendor.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!vendor) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    // Update status
    const updated = await prisma.vendor.update({
      where: { id: params.id },
      data: {
        status,
        isActive: status === 'ACTIVE',
      },
    })

    // Create activity
    void prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Vendor "${vendor.name}" ${status === 'ACTIVE' ? 'activated' : 'archived'}`,
      },
    })

    return NextResponse.json({ vendor: updated })
  } catch (error: any) {
    console.error('Update vendor status error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
