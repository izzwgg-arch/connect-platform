import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { allocateNextPurchaseOrderNumber } from '@/lib/qbo/doc-numbers'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const source = await prisma.purchaseOrder.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        lineItems: {
          include: {
            group: true,
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!source) {
      return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 })
    }

    const poNumber = await allocateNextPurchaseOrderNumber({ tenantId: user.tenantId })

    const duplicate = await prisma.purchaseOrder.create({
      data: {
        tenantId: user.tenantId,
        clientId: source.clientId,
        jobId: source.jobId,
        poNumber,
        vendor: source.vendor,
        vendorId: source.vendorId,
        status: 'DRAFT',
        total: source.total,
        orderDate: new Date(),
        expectedDate: source.expectedDate,
        notes: source.notes,
        internalNotes: (source as any).internalNotes ?? null,
        deliveryAddress: (source as any).deliveryAddress ?? null,
      },
    })

    const uniqueGroups = new Map<string, { name: string; sourceBundleId: string | null; sourceBundleName: string | null }>()
    for (const item of source.lineItems) {
      if (item.groupId && item.group) {
        uniqueGroups.set(item.groupId, {
          name: item.group.name,
          sourceBundleId: item.group.sourceBundleId,
          sourceBundleName: item.group.sourceBundleName,
        })
      }
    }

    const groupMap = new Map<string, string>()
    for (const [oldGroupId, group] of uniqueGroups.entries()) {
      const createdGroup = await prisma.documentLineGroup.create({
        data: {
          tenantId: user.tenantId,
          documentType: 'PURCHASE_ORDER',
          documentId: duplicate.id,
          name: group.name,
          sourceBundleId: group.sourceBundleId,
          sourceBundleName: group.sourceBundleName,
        },
      })
      groupMap.set(oldGroupId, createdGroup.id)
    }

    if (source.lineItems.length > 0) {
      await prisma.purchaseOrderLineItem.createMany({
        data: source.lineItems.map((item) => ({
          poId: duplicate.id,
          groupId: item.groupId ? groupMap.get(item.groupId) || null : null,
          description: item.description,
          details: item.details,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          unitCost: item.unitCost,
          total: item.total,
          sortOrder: item.sortOrder,
          notes: item.notes,
          vendorId: item.vendorId,
          taxable: item.taxable,
          taxRate: item.taxRate,
          sourceItemId: item.sourceItemId,
          sourceBundleId: item.sourceBundleId,
          isNote: (item as any).isNote === true,
          isVisibleToClient: (item as any).isVisibleToClient !== false,
          showDescriptionToCustomer: (item as any).showDescriptionToCustomer !== false,
          showDetailsToCustomer: (item as any).showDetailsToCustomer !== false,
          showNotesToCustomer: (item as any).showNotesToCustomer !== false,
          showPriceToCustomer: (item as any).showPriceToCustomer !== false,
        })),
      })
    }

    return NextResponse.json({ purchaseOrder: duplicate, id: duplicate.id }, { status: 201 })
  } catch (error) {
    console.error('Duplicate purchase order error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
