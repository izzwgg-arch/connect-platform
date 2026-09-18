import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const type = searchParams.get('type') || 'all'
  const kind = searchParams.get('kind') || 'all' // 'all' | 'SINGLE' | 'BUNDLE'
  const categoryId = searchParams.get('categoryId') || ''
  const vendorId = searchParams.get('vendorId') || ''
  const active = searchParams.get('active')
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
        { name: ilike(term) },
        { sku: ilike(term) },
        { description: ilike(term) },
        { vendor: { name: ilike(term) } },
        { category: { name: ilike(term) } },
      ])
    )

    if (type !== 'all') {
      where.type = type
    }

    if (kind !== 'all') {
      where.kind = kind
    }

    if (categoryId) {
      where.categoryId = categoryId
    }

    if (vendorId) {
      where.vendorId = vendorId
    }

    if (active !== null && active !== undefined && active !== '') {
      where.isActive = active === 'true'
    }

    const [items, total, activeCount, sumAgg] = await Promise.all([
      prisma.item.findMany({
        where,
        include: {
          vendor: {
            select: {
              id: true,
              name: true,
            },
          },
          category: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: {
          name: 'asc',
        },
        skip,
        take: limit,
      }),
      prisma.item.count({ where }),
      prisma.item.count({ where: { ...where, isActive: true } }),
      prisma.item.aggregate({
        where,
        _sum: { defaultUnitPrice: true },
      }),
    ])

    return NextResponse.json({
      items,
      stats: {
        total,
        activeCount,
        totalValue: Number((sumAgg as any)?._sum?.defaultUnitPrice ?? 0),
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error: any) {
    console.error('Get items error:', error)
    return NextResponse.json({ 
      error: error?.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      name,
      sku,
      type,
      description,
      unit,
      defaultUnitCost,
      defaultUnitPrice,
      taxable,
      taxRate,
      isActive,
      vendorId,
      categoryId,
      tags,
      notes,
      pricingMode,
      percentOfAboveRate,
    } = body

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const isPercentMode = pricingMode === 'PERCENT_OF_ABOVE'
    if (isPercentMode) {
      const rate = percentOfAboveRate !== undefined && percentOfAboveRate !== '' ? Number(percentOfAboveRate) : NaN
      if (!Number.isFinite(rate) || rate <= 0) {
        return NextResponse.json({ error: 'Enter a percentage greater than 0' }, { status: 400 })
      }
    }

    // Check for duplicate SKU if provided
    if (sku) {
      const existing = await prisma.item.findFirst({
        where: {
          tenantId: user.tenantId,
          sku,
        },
      })
      if (existing) {
        return NextResponse.json({ error: 'SKU already exists' }, { status: 400 })
      }
    }

    // Validate and convert data
    const itemData: any = {
      tenantId: user.tenantId,
      name: name.trim(),
      sku: sku && sku.trim() ? sku.trim() : null,
      type: type || 'PRODUCT',
      description: description && description.trim() ? description.trim() : null,
      unit: unit || 'ea',
      defaultUnitCost: defaultUnitCost && defaultUnitCost !== '' ? parseFloat(String(defaultUnitCost)) : null,
      // In PERCENT_OF_ABOVE mode, price is computed when the item is added to a
      // document, not stored here — defaultUnitPrice is unused in that mode.
      defaultUnitPrice: isPercentMode
        ? 0
        : defaultUnitPrice && defaultUnitPrice !== ''
          ? parseFloat(String(defaultUnitPrice))
          : 0,
      pricingMode: isPercentMode ? 'PERCENT_OF_ABOVE' : 'FIXED',
      percentOfAboveRate: isPercentMode ? Number(percentOfAboveRate) : null,
      taxable: taxable !== undefined ? Boolean(taxable) : true,
      taxRate: taxRate && taxRate !== '' ? parseFloat(String(taxRate)) : null,
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      vendorId: vendorId && vendorId !== '' ? vendorId : null,
      categoryId: categoryId && categoryId !== '' ? categoryId : null,
      tags: tags && Array.isArray(tags) ? tags.filter(t => t && t.trim()) : [],
      notes: notes && notes.trim() ? notes.trim() : null,
    }

    // Ensure defaultUnitPrice is not null or 0 if not provided
    if (!itemData.defaultUnitPrice || itemData.defaultUnitPrice === 0) {
      itemData.defaultUnitPrice = 0
    }

    const item = await prisma.item.create({
      data: itemData,
      include: {
        vendor: {
          select: {
            id: true,
            name: true,
          },
        },
        category: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })

    // Create activity (non-blocking)
    try {
      await prisma.activity.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          type: 'OTHER',
          description: `Item "${name}" created`,
        },
      })
    } catch (activityError) {
      // Log but don't fail the request if activity creation fails
      console.error('Failed to create activity for item:', activityError)
    }

    return NextResponse.json({ item }, { status: 201 })
  } catch (error: any) {
    console.error('Create item error:', error)
    console.error('Error details:', JSON.stringify(error, null, 2))
    // Return more detailed error message
    const errorMessage = error?.message || 'Internal server error'
    // Check for Prisma errors
    if (error?.code === 'P2002') {
      return NextResponse.json({ error: 'A record with this SKU already exists' }, { status: 400 })
    }
    if (error?.code === 'P2003') {
      return NextResponse.json({ error: 'Invalid vendor or category reference' }, { status: 400 })
    }
    return NextResponse.json({ 
      error: errorMessage,
      code: error?.code,
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  // Bulk-deleting catalog items is a settings-level mutation — match POST (create).
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const ids = Array.isArray(body?.ids) ? body.ids.map((x: any) => String(x)) : []
    const uniqueIds = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)))

    if (uniqueIds.length === 0) {
      return NextResponse.json({ error: 'No item ids provided' }, { status: 400 })
    }

    const items = await prisma.item.findMany({
      where: {
        tenantId: user.tenantId,
        id: { in: uniqueIds },
      },
      select: {
        id: true,
        name: true,
        kind: true,
        _count: {
          select: {
            estimateLineItems: true,
            invoiceLineItems: true,
            purchaseOrderLineItems: true,
            bundleComponents: true,
          },
        },
      },
    })

    const foundIds = new Set(items.map((i) => i.id))
    const notFound = uniqueIds.filter((id) => !foundIds.has(id))

    const blocked = items
      .filter(
        (i) =>
          (i._count.estimateLineItems || 0) > 0 ||
          (i._count.invoiceLineItems || 0) > 0 ||
          (i._count.purchaseOrderLineItems || 0) > 0 ||
          (i._count.bundleComponents || 0) > 0
      )
      .map((i) => ({
        id: i.id,
        name: i.name,
        estimates: i._count.estimateLineItems,
        invoices: i._count.invoiceLineItems,
        purchaseOrders: i._count.purchaseOrderLineItems,
        bundles: i._count.bundleComponents,
      }))

    const deletable = items.filter((i) => !blocked.some((b) => b.id === i.id))
    const deletableIds = deletable.map((i) => i.id)

    if (deletableIds.length === 0) {
      return NextResponse.json(
        {
          success: false,
          deletedCount: 0,
          blocked,
          notFound,
          error: 'No items could be deleted (all selected items are in use).',
        },
        { status: 400 }
      )
    }

    const bundleItemIds = deletable.filter((i) => i.kind === 'BUNDLE').map((i) => i.id)

    const now = new Date()
    const [bundleDefDeleteResult, deleteResult, _audit] = await prisma.$transaction([
      prisma.bundleDefinition.deleteMany({
        where: {
          tenantId: user.tenantId,
          itemId: { in: bundleItemIds },
        },
      }),
      prisma.item.deleteMany({
        where: {
          tenantId: user.tenantId,
          id: { in: deletableIds },
        },
      }),
      prisma.auditLog.createMany({
        data: deletableIds.map((id) => ({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'DELETE',
          entityType: 'Item',
          entityId: id,
          createdAt: now,
        })),
      }),
    ])

    return NextResponse.json({
      success: true,
      deletedCount: deleteResult.count,
      deletedBundleDefinitions: bundleDefDeleteResult.count,
      blocked,
      notFound,
    })
  } catch (error: any) {
    console.error('Bulk delete items error:', error)
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 500 })
  }
}