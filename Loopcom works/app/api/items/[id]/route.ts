import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const item = await prisma.item.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        vendor: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        category: {
          select: {
            id: true,
            name: true,
          },
        },
        bundleDefinition: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })

    if (!item) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    // Get usage counts (stub for now - would need to query line items)
    const usageCounts = {
      estimates: 0,
      invoices: 0,
      purchaseOrders: 0,
    }

    return NextResponse.json({
      item: {
        ...item,
        usageCounts,
      },
    })
  } catch (error) {
    console.error('Get item error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

    const isPercentMode = pricingMode !== undefined
      ? pricingMode === 'PERCENT_OF_ABOVE'
      : undefined
    if (isPercentMode) {
      const rate = percentOfAboveRate !== undefined && percentOfAboveRate !== '' ? Number(percentOfAboveRate) : NaN
      if (!Number.isFinite(rate) || rate <= 0) {
        return NextResponse.json({ error: 'Enter a percentage greater than 0' }, { status: 400 })
      }
    }

    const existing = await prisma.item.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    // Check for duplicate SKU if changed
    if (sku && sku !== existing.sku) {
      const duplicate = await prisma.item.findFirst({
        where: {
          tenantId: user.tenantId,
          sku,
          id: { not: params.id },
        },
      })
      if (duplicate) {
        return NextResponse.json({ error: 'SKU already exists' }, { status: 400 })
      }
    }

    const item = await prisma.item.update({
      where: { id: params.id },
      data: {
        name: name !== undefined ? name : existing.name,
        sku: sku !== undefined ? (sku || null) : existing.sku,
        type: type !== undefined ? type : existing.type,
        description: description !== undefined ? (description || null) : existing.description,
        unit: unit !== undefined ? unit : existing.unit,
        defaultUnitCost: defaultUnitCost !== undefined ? (defaultUnitCost ? parseFloat(defaultUnitCost) : null) : existing.defaultUnitCost,
        defaultUnitPrice: isPercentMode === true
          ? 0
          : defaultUnitPrice !== undefined
            ? parseFloat(defaultUnitPrice)
            : existing.defaultUnitPrice,
        pricingMode: pricingMode !== undefined ? (isPercentMode ? 'PERCENT_OF_ABOVE' : 'FIXED') : existing.pricingMode,
        percentOfAboveRate: pricingMode !== undefined
          ? (isPercentMode ? Number(percentOfAboveRate) : null)
          : existing.percentOfAboveRate,
        taxable: taxable !== undefined ? taxable : existing.taxable,
        taxRate: taxRate !== undefined ? (taxRate ? parseFloat(taxRate) : null) : existing.taxRate,
        isActive: isActive !== undefined ? isActive : existing.isActive,
        vendorId: vendorId !== undefined ? (vendorId || null) : existing.vendorId,
        categoryId: categoryId !== undefined ? (categoryId || null) : existing.categoryId,
        tags: tags !== undefined ? (tags && Array.isArray(tags) ? tags : []) : existing.tags,
        notes: notes !== undefined ? (notes || null) : existing.notes,
      },
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

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Item "${item.name}" updated`,
      },
    })

    return NextResponse.json({ item })
  } catch (error) {
    console.error('Update item error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const item = await prisma.item.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        _count: {
          select: {
            estimateLineItems: true,
            invoiceLineItems: true,
            bundleComponents: true,
          },
        },
      },
    })

    if (!item) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    // Prevent deletion if item is used in estimates, invoices, or bundles
    if (item._count.estimateLineItems > 0 || item._count.invoiceLineItems > 0 || item._count.bundleComponents > 0) {
      return NextResponse.json(
        { error: 'Cannot delete item that is used in estimates, invoices, or bundles. Please remove it from all documents first.' },
        { status: 400 }
      )
    }

    // Delete bundle definition if this is a bundle item
    if (item.kind === 'BUNDLE') {
      await prisma.bundleDefinition.deleteMany({
        where: { itemId: params.id },
      })
    }

    // Delete item
    await prisma.item.delete({
      where: { id: params.id },
    })

    // Create activity
    void prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Item "${item.name}" deleted`,
      },
    })

    return NextResponse.json({ message: 'Item deleted successfully' })
  } catch (error: any) {
    console.error('Delete item error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
