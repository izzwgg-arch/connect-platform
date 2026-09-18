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
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const source = await prisma.item.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        bundleDefinition: {
          include: {
            components: {
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
      },
    })

    if (!source) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const duplicate = await prisma.item.create({
      data: {
        tenantId: user.tenantId,
        name: `${source.name} (Copy)`,
        sku: null,
        type: source.type,
        kind: source.kind,
        description: source.description,
        unit: source.unit,
        defaultUnitCost: source.defaultUnitCost,
        defaultUnitPrice: source.defaultUnitPrice,
        taxable: source.taxable,
        taxRate: source.taxRate,
        isActive: source.isActive,
        vendorId: source.vendorId,
        categoryId: source.categoryId,
        tags: source.tags,
        notes: source.notes,
      },
    })

    if (source.kind === 'BUNDLE' && source.bundleDefinition) {
      const newBundle = await prisma.bundleDefinition.create({
        data: {
          itemId: duplicate.id,
          tenantId: user.tenantId,
          name: `${source.bundleDefinition.name} (Copy)`,
          description: source.bundleDefinition.description,
          isActive: source.bundleDefinition.isActive,
          pricingStrategy: source.bundleDefinition.pricingStrategy,
        },
      })

      if (source.bundleDefinition.components.length > 0) {
        await prisma.bundleComponent.createMany({
          data: source.bundleDefinition.components.map((comp) => ({
            bundleId: newBundle.id,
            tenantId: user.tenantId,
            componentType: comp.componentType,
            componentItemId: comp.componentItemId,
            componentBundleId: comp.componentBundleId,
            quantity: comp.quantity,
            sortOrder: comp.sortOrder,
            defaultUnitPriceOverride: comp.defaultUnitPriceOverride,
            defaultUnitCostOverride: comp.defaultUnitCostOverride,
            vendorId: comp.vendorId,
            notes: comp.notes,
          })),
        })
      }
    }

    return NextResponse.json({ item: duplicate, id: duplicate.id }, { status: 201 })
  } catch (error) {
    console.error('Duplicate item error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
