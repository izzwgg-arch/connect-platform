import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { purchaseOrderJobSiteAddressSearchClauses } from '@/lib/search/job-site-address'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'
import {
  allocateNextPurchaseOrderNumber,
  normalizePurchaseOrderNumber,
} from '@/lib/qbo/doc-numbers'

function formatJobSiteAddress(parts?: {
  street?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
} | null) {
  if (!parts) return ''
  const street = String(parts.street || '').trim()
  const city = String(parts.city || '').trim()
  const state = String(parts.state || '').replace(/\b\d{5}(?:-\d{4})?\b/g, '').trim()
  return [street, city || state].filter(Boolean).join(', ').trim()
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || 'all'
  const vendorId = searchParams.get('vendorId') || ''
  const jobId = searchParams.get('jobId') || ''
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const skip = (page - 1) * limit

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { poNumber: ilike(term) },
        { vendor: ilike(term) },
        { job: { jobNumber: ilike(term) } },
        { job: { title: ilike(term) } },
        { vendorRef: { name: ilike(term) } },
        { client: { name: ilike(term) } },
        { client: { companyName: ilike(term) } },
        ...purchaseOrderJobSiteAddressSearchClauses(term),
      ])
    )

    if (status !== 'all') {
      where.status = status
    }

    if (vendorId) {
      where.vendorId = vendorId
    }

    if (jobId) {
      where.jobId = jobId
    }

    const [purchaseOrders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
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
            select: {
              id: true,
              jobNumber: true,
              title: true,
              addresses: {
                where: { type: 'job_site' },
                take: 1,
                select: {
                  street: true,
                  city: true,
                  state: true,
                  zipCode: true,
                },
              },
            },
          },
          lineItems: {
            orderBy: {
              sortOrder: 'asc',
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      prisma.purchaseOrder.count({ where }),
    ])

    // Calculate totals
    const purchaseOrdersWithTotals = purchaseOrders.map((po) => {
      const subtotal = po.lineItems.reduce((sum, item) => {
        return sum + (Number(item.quantity) * Number(item.unitPrice))
      }, 0)
      const total = subtotal

      return {
        ...po,
        subtotal,
        total,
        jobSiteAddress: formatJobSiteAddress(po.job?.addresses?.[0]),
      }
    })

    return NextResponse.json({
      purchaseOrders: purchaseOrdersWithTotals,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get purchase orders error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.create')
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

    // Get vendor info if vendorId provided
    let vendorName = vendor
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
    }

    if (!vendorName && !vendorId) {
      return NextResponse.json({ error: 'Vendor is required' }, { status: 400 })
    }

    // Use provided PO number, or allocate the next sequential one
    const normalizedPoNumber = normalizePurchaseOrderNumber(poNumber)
    let finalPONumber = normalizedPoNumber
    if (!finalPONumber) {
      finalPONumber = await allocateNextPurchaseOrderNumber({ tenantId: user.tenantId })
    } else {
      const clash = await prisma.purchaseOrder.findFirst({
        where: { poNumber: finalPONumber },
        select: { id: true },
      })
      if (clash) {
        return NextResponse.json(
          { error: `Purchase order number ${finalPONumber} already exists. Use a different number.` },
          { status: 400 }
        )
      }
    }

    // Calculate totals from line items
    const subtotal = lineItems && Array.isArray(lineItems)
      ? lineItems.reduce((sum, item) => sum + (parseFloat(item.quantity || 0) * parseFloat(item.unitPrice || 0)), 0)
      : 0
    const taxAmount = parseFloat(tax || 0)
    const shippingAmount = parseFloat(shipping || 0)
    const total = subtotal + taxAmount + shippingAmount

    // Create purchase order
    let purchaseOrder
    try {
      purchaseOrder = await prisma.purchaseOrder.create({
        data: {
          tenantId: user.tenantId,
          poNumber: finalPONumber,
          vendor: vendorName,
          vendorId: vendorId || null,
          jobId: jobId || null,
          status: status || 'DRAFT',
          orderDate: orderDate ? new Date(orderDate) : new Date(),
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          notes: notes ? String(notes) : null,
          internalNotes: internalNotes ? String(internalNotes) : null,
          deliveryAddress: deliveryAddress ? String(deliveryAddress) : null,
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
            orderBy: {
              sortOrder: 'asc',
            },
          },
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002' && err?.meta?.target?.includes?.('poNumber')) {
        return NextResponse.json({ error: 'Purchase order number already exists' }, { status: 400 })
      }
      throw err
    }
    // Create document line groups first (for bundles)
    const groupMap = new Map<string, string>() // groupId -> database group ID
    if (groups && Array.isArray(groups)) {
      for (const group of groups) {
        const dbGroup = await prisma.documentLineGroup.create({
          data: {
            tenantId: user.tenantId,
            documentType: 'PURCHASE_ORDER',
            documentId: purchaseOrder.id,
            name: group.name || 'Bundle',
            sourceBundleId: group.sourceBundleId || null,
            sourceBundleName: group.name || null,
          },
        })
        groupMap.set(group.groupId, dbGroup.id)
      }
    }

    // Create line items
    if (lineItems && Array.isArray(lineItems)) {
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
            poId: purchaseOrder.id,
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
        description: `Purchase order ${finalPONumber} created`,
      },
    })

    // Calculate totals for response
    const responseSubtotal = purchaseOrder.lineItems.reduce((sum, item) => {
      return sum + (Number(item.quantity) * Number(item.unitPrice))
    }, 0)

    try {
      await enqueueQboSync(user.tenantId, 'purchase_order', purchaseOrder.id)
    } catch (error) {
      console.error('QuickBooks purchase order sync trigger error:', error)
    }

    return NextResponse.json({
      purchaseOrder: {
        ...purchaseOrder,
        subtotal: responseSubtotal,
        tax: taxAmount,
        shipping: shippingAmount,
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Create purchase order error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
