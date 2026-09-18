import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { bundleFlattenedItemToLineData } from '@/lib/bundles/expand-line-items'

// Helper to flatten bundle (reuse from bundles API)
async function flattenBundle(
  bundleId: string,
  tenantId: string,
  visited: Set<string> = new Set(),
  multiplier: number = 1
): Promise<Array<{
  itemId: string
  quantity: number
  name: string
  unitPrice: number
  unitCost: number | null
  description: string | null
  unit: string
}>> {
  if (visited.has(bundleId)) {
    throw new Error('Circular bundle reference detected')
  }
  visited.add(bundleId)

  const bundle = await prisma.bundleDefinition.findFirst({
    where: {
      id: bundleId,
      tenantId,
    },
    include: {
      components: {
        include: {
          componentItem: true,
          componentBundle: {
            include: {
              item: true,
            },
          },
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  })

  if (!bundle) {
    return []
  }

  const flattened: Array<{
    itemId: string
    quantity: number
    name: string
    unitPrice: number
    unitCost: number | null
    description: string | null
    unit: string
  }> = []

  for (const component of bundle.components) {
    const qty = Number(component.quantity) * multiplier

    if (component.componentType === 'ITEM' && component.componentItem) {
      flattened.push({
        itemId: component.componentItem.id,
        quantity: qty,
        name: component.componentItem.name,
        unitPrice: component.defaultUnitPriceOverride
          ? Number(component.defaultUnitPriceOverride)
          : Number(component.componentItem.defaultUnitPrice),
        unitCost: component.defaultUnitCostOverride
          ? Number(component.defaultUnitCostOverride)
          : component.componentItem.defaultUnitCost
            ? Number(component.componentItem.defaultUnitCost)
            : null,
        description: component.componentItem.description,
        unit: component.componentItem.unit,
      })
    } else if (component.componentType === 'BUNDLE' && component.componentBundle) {
      const nested = await flattenBundle(
        component.componentBundle.id,
        tenantId,
        new Set(visited),
        qty
      )
      flattened.push(...nested)
    }
  }

  return flattened
}

// POST - Update group from template (rebuild from current bundle definition)
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; groupId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    // Verify invoice exists and user has access
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Verify group exists and belongs to this invoice
    const group = await prisma.documentLineGroup.findFirst({
      where: {
        id: params.groupId,
        documentType: 'INVOICE',
        documentId: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    if (!group.sourceBundleId) {
      return NextResponse.json(
        { error: 'Group is not linked to a bundle template' },
        { status: 400 }
      )
    }

    // Get current bundle definition
    const bundle = await prisma.bundleDefinition.findFirst({
      where: {
        id: group.sourceBundleId,
        tenantId: user.tenantId,
      },
      include: {
        item: true,
      },
    })

    if (!bundle) {
      return NextResponse.json({ error: 'Bundle template not found' }, { status: 404 })
    }

    // Delete existing line items in the group
    await prisma.invoiceLineItem.deleteMany({
      where: {
        groupId: params.groupId,
      },
    })

    // Flatten bundle and create new line items
    const flattened = await flattenBundle(group.sourceBundleId, user.tenantId)

    const lineItems = []
    for (let i = 0; i < flattened.length; i++) {
      const item = flattened[i]
      const total = item.unitPrice * item.quantity
      const lineData = bundleFlattenedItemToLineData(item)
      const lineItem = await prisma.invoiceLineItem.create({
        data: {
          invoiceId: params.id,
          groupId: params.groupId,
          ...lineData,
          total,
          sortOrder: i,
        },
      })
      lineItems.push(lineItem)
    }

    // Update group metadata
    await prisma.documentLineGroup.update({
      where: { id: params.groupId },
      data: {
        name: bundle.name,
        sourceBundleName: bundle.name,
        sourceBundleUpdatedAt: bundle.updatedAt,
      },
    })

    // Recalculate invoice totals
    const allLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: params.id },
    })

    const subtotal = allLineItems.reduce((sum, item) => sum + Number(item.total), 0)
    const taxAmount = subtotal * Number(invoice.taxRate || 0)
    const discount = Number(invoice.discount || 0)
    const total = subtotal - discount + taxAmount

    await prisma.invoice.update({
      where: { id: params.id },
      data: {
        subtotal,
        taxAmount,
        total,
      },
    })

    return NextResponse.json({
      success: true,
      lineItems: lineItems.map(item => ({
        ...item,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        total: item.total.toString(),
      })),
    })
  } catch (error: any) {
    console.error('Update from template error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
