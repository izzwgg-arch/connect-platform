import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const purchaseOrder = await prisma.purchaseOrder.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!purchaseOrder) {
      return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 })
    }

    if (purchaseOrder.status === 'RECEIVED') {
      return NextResponse.json({ error: 'Purchase order is already marked as received' }, { status: 400 })
    }

    if (purchaseOrder.status === 'CANCELLED') {
      return NextResponse.json(
        { error: 'Cannot mark a cancelled purchase order as received' },
        { status: 400 }
      )
    }

    // Update status to RECEIVED and set receivedDate
    const updated = await prisma.purchaseOrder.update({
      where: { id: params.id },
      data: {
        status: 'RECEIVED',
        receivedDate: new Date(),
      },
      include: {
        vendorRef: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
          },
        },
        lineItems: {
          orderBy: {
            sortOrder: 'asc',
          },
        },
      },
    })

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Purchase order ${purchaseOrder.poNumber} marked as received by ${user.firstName} ${user.lastName}`,
      },
    })

    try {
      await enqueueQboSync(user.tenantId, 'purchase_order', params.id)
    } catch (error) {
      console.error('QuickBooks purchase order sync trigger error (receive):', error)
    }

    return NextResponse.json({ purchaseOrder: updated })
  } catch (error) {
    console.error('Receive purchase order error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
