import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { formatAddressParts } from '@/lib/address/parse'
import { normalizePurchaseOrderNumber } from '@/lib/qbo/doc-numbers'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const purchaseOrder = await prisma.purchaseOrder.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        vendorRef: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            state: true,
            zipCode: true,
            contactPerson: true,
          },
        },
        job: {
          include: {
            addresses: {
              where: { type: 'job_site' },
              take: 1,
            },
            client: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        lineItems: {
          include: {
            group: true,
            sourceItem: {
              select: {
                id: true,
                name: true,
                kind: true,
              },
            },
            vendor: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    })

    if (!purchaseOrder) {
      return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 })
    }

    // Calculate totals
    const subtotal = purchaseOrder.lineItems.reduce((sum, item) => {
      return sum + (Number(item.quantity) * Number(item.unitPrice))
    }, 0)
    const total = Number(purchaseOrder.total)
    const tax = 0 // Tax not stored in schema, would need migration
    const shipping = 0 // Shipping not stored in schema, would need migration
    const receivedTotal = 0 // Receipts tracking would require a separate model
    const jobSiteAddress = formatAddressParts(purchaseOrder.job?.addresses?.[0] || null)

    return NextResponse.json({
      purchaseOrder: {
        ...purchaseOrder,
        jobSiteAddress,
        subtotal,
        tax,
        shipping,
        total,
        receivedTotal,
        balance: total - receivedTotal,
      },
    })
  } catch (error) {
    console.error('Get purchase order error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
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
    const {
      vendor,
      vendorId,
      poNumber,
      jobId,
      status,
      expectedDate,
      orderDate,
      notes,
      internalNotes,
      deliveryAddress,
      lineItems,
      groups, // Array of { groupId, name, sourceBundleId }
      tax,
      shipping,
    } = body

    // Get existing PO
    const existing = await prisma.purchaseOrder.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 })
    }

    const normalizedPoNumber = normalizePurchaseOrderNumber(poNumber)
    if (normalizedPoNumber && normalizedPoNumber !== existing.poNumber) {
      const clash = await prisma.purchaseOrder.findFirst({
        where: { poNumber: normalizedPoNumber },
        select: { id: true },
      })
      if (clash) {
        return NextResponse.json(
          { error: `Purchase order number ${normalizedPoNumber} already exists. Use a different number.` },
          { status: 400 }
        )
      }
    }

    // Get vendor info if vendorId provided
    let vendorName = existing.vendor
    if (vendorId !== undefined) {
      if (vendorId) {
        const vendorRecord = await prisma.vendor.findFirst({
          where: {
            id: vendorId,
            tenantId: user.tenantId,
          },
        })
        if (!vendorRecord) {
          return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
        }
        vendorName = vendorRecord.name
      } else {
        vendorName = vendor || existing.vendor
      }
    } else if (vendor !== undefined) {
      vendorName = vendor
    }

    // Calculate totals if line items updated
    let total = Number(existing.total)
    if (lineItems && Array.isArray(lineItems)) {
      const subtotal = lineItems.reduce((sum, item) => {
        return sum + (parseFloat(item.quantity || 0) * parseFloat(item.unitPrice || 0))
      }, 0)
      const taxAmount = parseFloat(tax || 0)
      const shippingAmount = parseFloat(shipping || 0)
      total = subtotal + taxAmount + shippingAmount
    }

    // Update purchase order
    let purchaseOrder
    try {
      purchaseOrder = await prisma.purchaseOrder.update({
      where: { id: params.id },
      data: {
        vendor: vendorName,
        vendorId: vendorId !== undefined ? (vendorId || null) : existing.vendorId,
        jobId: jobId !== undefined ? (jobId || null) : existing.jobId,
        poNumber:
          normalizedPoNumber && normalizedPoNumber !== existing.poNumber
            ? normalizedPoNumber
            : existing.poNumber,
        status: status !== undefined ? status : existing.status,
        orderDate: orderDate !== undefined ? (orderDate ? new Date(orderDate) : null) : existing.orderDate,
        expectedDate: expectedDate !== undefined ? (expectedDate ? new Date(expectedDate) : null) : existing.expectedDate,
        notes: notes !== undefined ? (notes ? String(notes) : null) : existing.notes,
        internalNotes:
          internalNotes !== undefined
            ? (internalNotes ? String(internalNotes) : null)
            : (existing as any).internalNotes,
        deliveryAddress:
          deliveryAddress !== undefined
            ? (deliveryAddress ? String(deliveryAddress) : null)
            : (existing as any).deliveryAddress,
        total,
      },
      include: {
        vendorRef: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            state: true,
            zipCode: true,
            contactPerson: true,
          },
        },
        job: {
          include: {
            client: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        lineItems: {
          include: {
            group: true,
            sourceItem: {
              select: {
                id: true,
                name: true,
                kind: true,
              },
            },
            vendor: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    })
    } catch (err: any) {
      if (err?.code === 'P2002' && err?.meta?.target?.includes?.('poNumber')) {
        return NextResponse.json({ error: 'Purchase order number already exists' }, { status: 400 })
      }
      throw err
    }
    // Update line items if provided
    if (lineItems && Array.isArray(lineItems)) {
      // Delete existing groups and line items
      await prisma.documentLineGroup.deleteMany({
        where: {
          tenantId: user.tenantId,
          documentType: 'PURCHASE_ORDER',
          documentId: params.id,
        },
      })
      await prisma.purchaseOrderLineItem.deleteMany({
        where: { poId: params.id },
      })

      // Create new groups
      const groupMap = new Map<string, string>() // groupId -> database group ID
      if (groups && Array.isArray(groups)) {
        for (const group of groups) {
          const dbGroup = await prisma.documentLineGroup.create({
            data: {
              tenantId: user.tenantId,
              documentType: 'PURCHASE_ORDER',
              documentId: params.id,
              name: group.name || 'Bundle',
              sourceBundleId: group.sourceBundleId || null,
              sourceBundleName: group.name || null,
            },
          })
          groupMap.set(group.groupId, dbGroup.id)
        }
      }

      // Create new line items
      for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i]
        const isNote = item.isNote === true
        const qty = isNote ? 0 : parseFloat(item.quantity || 0)
        const price = isNote ? 0 : parseFloat(item.unitPrice || 0) // PO uses unitPrice for cost
        const itemTotal = qty * price

        // Get groupId from map if item has a groupId
        const dbGroupId = item.groupId ? groupMap.get(item.groupId) || null : null

        await prisma.purchaseOrderLineItem.create({
          data: {
            poId: params.id,
            groupId: dbGroupId,
            description: item.description || '',
            details: item.details || null,
            quantity: isNote ? 0 : qty || 1,
            unitPrice: price || 0,
            unitCost: isNote ? null : item.unitCost ? parseFloat(item.unitCost) : null,
            total: itemTotal,
            sortOrder: i,
            vendorId: isNote ? null : item.vendorId || null,
            notes: item.notes || null,
            sourceItemId: item.sourceItemId || null,
            sourceBundleId: item.sourceBundleId || null,
            isNote,
            isVisibleToClient: item.isVisibleToClient !== false,
            showDescriptionToCustomer: item.showDescriptionToCustomer !== false,
            showDetailsToCustomer: item.showDetailsToCustomer !== false,
            showNotesToCustomer: item.showNotesToCustomer !== false,
            showPriceToCustomer: item.showPriceToCustomer !== false,
          },
        })
      }
    }

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Purchase order ${purchaseOrder.poNumber} updated`,
      },
    })

    // Calculate totals for response
    const responseSubtotal = purchaseOrder.lineItems.reduce((sum, item) => {
      return sum + (Number(item.quantity) * Number(item.unitPrice))
    }, 0)
    const taxAmount = parseFloat(tax || 0)
    const shippingAmount = parseFloat(shipping || 0)

    try {
      await enqueueQboSync(user.tenantId, 'purchase_order', params.id)
    } catch (error) {
      console.error('QuickBooks purchase order sync trigger error (update):', error)
    }

    return NextResponse.json({
      purchaseOrder: {
        ...purchaseOrder,
        subtotal: responseSubtotal,
        tax: taxAmount,
        shipping: shippingAmount,
      },
    })
  } catch (error) {
    console.error('Update purchase order error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.delete')
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

    // Don't delete if there are receipts
    // Note: Receipt tracking would require a separate PurchaseOrderReceipt model
    const receiptCount = 0

    if (receiptCount > 0) {
      return NextResponse.json(
        { error: 'Cannot delete purchase order with receipts' },
        { status: 400 }
      )
    }

    await prisma.purchaseOrder.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ message: 'Purchase order deleted successfully' })
  } catch (error) {
    console.error('Delete purchase order error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
