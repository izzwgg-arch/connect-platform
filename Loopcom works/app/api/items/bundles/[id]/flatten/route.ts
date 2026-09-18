import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

// Helper function to flatten a bundle (handles nested bundles)
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
      // Recursively flatten nested bundle
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

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const flattened = await flattenBundle(params.id, user.tenantId)
    return NextResponse.json({ items: flattened })
  } catch (error: any) {
    console.error('Flatten bundle error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
