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

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { bundleId } = body

    if (!bundleId) {
      return NextResponse.json({ error: 'Bundle ID is required' }, { status: 400 })
    }

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

    // Get bundle
    const bundle = await prisma.bundleDefinition.findFirst({
      where: {
        id: bundleId,
        tenantId: user.tenantId,
      },
      include: {
        item: true,
      },
    })

    if (!bundle) {
      return NextResponse.json({ error: 'Bundle not found' }, { status: 404 })
    }

    // Flatten bundle
    const flattened = await flattenBundle(bundleId, user.tenantId)

    // Get current max sortOrder for invoice
    const maxSort = await prisma.invoiceLineItem.findFirst({
      where: { invoiceId: params.id },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    })
    let currentSort = maxSort?.sortOrder ?? -1

    // Create document line group
    const group = await prisma.documentLineGroup.create({
      data: {
        tenantId: user.tenantId,
        documentType: 'INVOICE',
        documentId: params.id,
        name: bundle.name,
        sourceBundleId: bundle.id,
        sourceBundleName: bundle.name,
        sourceBundleUpdatedAt: bundle.updatedAt,
      },
    })

    // Create line items from flattened bundle
    const lineItems = []
    for (const item of flattened) {
      currentSort++
      const total = item.unitPrice * item.quantity
      const lineData = bundleFlattenedItemToLineData(item)
      const lineItem = await prisma.invoiceLineItem.create({
        data: {
          invoiceId: params.id,
          groupId: group.id,
          ...lineData,
          total,
          sortOrder: currentSort,
        },
      })
      lineItems.push(lineItem)
    }

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
      group,
      lineItems,
    })
  } catch (error: any) {
    console.error('Add bundle to invoice error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
