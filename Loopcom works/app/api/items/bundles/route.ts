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

async function recalculateAndPersistBundleTotals(bundleId: string, tenantId: string, itemId: string) {
  const flattened = await flattenBundle(bundleId, tenantId)
  let totalCost = 0
  let totalPrice = 0

  for (const line of flattened) {
    totalCost += (line.unitCost || 0) * line.quantity
    totalPrice += line.unitPrice * line.quantity
  }

  await prisma.item.update({
    where: { id: itemId },
    data: {
      defaultUnitCost: totalCost > 0 ? totalCost : null,
      defaultUnitPrice: totalPrice > 0 ? totalPrice : 0,
    },
  })

  return { totalCost, totalPrice }
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const bundleId = searchParams.get('bundleId')

  if (bundleId) {
    // Get bundle details with components
    try {
      const bundle = await prisma.bundleDefinition.findFirst({
        where: {
          id: bundleId,
          tenantId: user.tenantId,
        },
        include: {
          item: true,
          components: {
            include: {
              componentItem: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  defaultUnitPrice: true,
                  defaultUnitCost: true,
                  description: true,
                  unit: true,
                },
              },
              componentBundle: {
                include: {
                  item: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
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
        return NextResponse.json({ error: 'Bundle not found' }, { status: 404 })
      }

      // Calculate totals
      let totalCost = 0
      let totalPrice = 0

      for (const component of bundle.components) {
        const qty = Number(component.quantity)
        if (component.componentType === 'ITEM' && component.componentItem) {
          const price = component.defaultUnitPriceOverride
            ? Number(component.defaultUnitPriceOverride)
            : Number(component.componentItem.defaultUnitPrice)
          const cost = component.defaultUnitCostOverride
            ? Number(component.defaultUnitCostOverride)
            : component.componentItem.defaultUnitCost
              ? Number(component.componentItem.defaultUnitCost)
              : 0
          totalPrice += price * qty
          totalCost += cost * qty
        } else if (component.componentType === 'BUNDLE' && component.componentBundle) {
          // For nested bundles, we'd need to calculate recursively
          // For now, just note it's a nested bundle
        }
      }

      return NextResponse.json({
        bundle: {
          ...bundle,
          totals: {
            cost: totalCost,
            price: totalPrice,
          },
        },
      })
    } catch (error) {
      console.error('Get bundle error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // List bundles
  try {
    const bundles = await prisma.bundleDefinition.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
      },
      include: {
        item: {
          select: {
            id: true,
            name: true,
            sku: true,
            description: true,
            defaultUnitPrice: true,
            defaultUnitCost: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    })

    // Auto-heal stale stored bundle totals so UI reflects correct values immediately.
    const normalizedBundles = await Promise.all(
      bundles.map(async (bundle) => {
        const { totalCost, totalPrice } = await recalculateAndPersistBundleTotals(
          bundle.id,
          user.tenantId,
          bundle.itemId
        )

        return {
          ...bundle,
          item: {
            ...bundle.item,
            defaultUnitCost: totalCost > 0 ? totalCost : null,
            defaultUnitPrice: totalPrice > 0 ? totalPrice : 0,
          },
        }
      })
    )

    return NextResponse.json({ bundles: normalizedBundles })
  } catch (error) {
    console.error('List bundles error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
      description,
      sku,
      type,
      categoryId,
      vendorId,
      tags,
      notes,
      pricingStrategy,
      components,
    } = body

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    if (!components || !Array.isArray(components) || components.length === 0) {
      return NextResponse.json(
        { error: 'Bundle must have at least one component' },
        { status: 400 }
      )
    }

    // Validate no circular references
    const bundleIds = new Set<string>()
    for (const comp of components) {
      if (comp.componentType === 'BUNDLE' && comp.componentBundleId) {
        bundleIds.add(comp.componentBundleId)
      }
    }

    // Create the item first (as a bundle)
    const item = await prisma.item.create({
      data: {
        tenantId: user.tenantId,
        name: name.trim(),
        sku: sku && sku.trim() ? sku.trim() : null,
        type: type || 'PRODUCT',
        kind: 'BUNDLE',
        description: description && description.trim() ? description.trim() : null,
        unit: 'ea',
        defaultUnitCost: null, // Will be calculated from components
        defaultUnitPrice: 0, // Will be calculated or overridden
        taxable: true,
        isActive: true,
        vendorId: vendorId && vendorId !== '' ? vendorId : null,
        categoryId: categoryId && categoryId !== '' ? categoryId : null,
        tags: tags && Array.isArray(tags) ? tags.filter((t: string) => t && t.trim()) : [],
        notes: notes && notes.trim() ? notes.trim() : null,
      },
    })

    // Create bundle definition
    const bundleDef = await prisma.bundleDefinition.create({
      data: {
        itemId: item.id,
        tenantId: user.tenantId,
        name: name.trim(),
        description: description && description.trim() ? description.trim() : null,
        pricingStrategy: pricingStrategy || 'SUM_COMPONENTS',
        isActive: true,
      },
    })

    // Create components
    for (let i = 0; i < components.length; i++) {
      const comp = components[i]
      
      // Check for circular reference
      if (comp.componentType === 'BUNDLE' && comp.componentBundleId === bundleDef.id) {
        // Clean up and return error
        await prisma.bundleDefinition.delete({ where: { id: bundleDef.id } })
        await prisma.item.delete({ where: { id: item.id } })
        return NextResponse.json(
          { error: 'Bundle cannot include itself' },
          { status: 400 }
        )
      }

      await prisma.bundleComponent.create({
        data: {
          bundleId: bundleDef.id,
          tenantId: user.tenantId,
          componentType: comp.componentType,
          componentItemId: comp.componentType === 'ITEM' ? comp.componentItemId : null,
          componentBundleId: comp.componentType === 'BUNDLE' ? comp.componentBundleId : null,
          quantity: parseFloat(comp.quantity) || 1,
          sortOrder: i,
          defaultUnitPriceOverride: comp.defaultUnitPriceOverride
            ? parseFloat(comp.defaultUnitPriceOverride)
            : null,
          defaultUnitCostOverride: comp.defaultUnitCostOverride
            ? parseFloat(comp.defaultUnitCostOverride)
            : null,
          vendorId: comp.vendorId && comp.vendorId !== '' ? comp.vendorId : null,
          notes: comp.notes && comp.notes.trim() ? comp.notes.trim() : null,
        },
      })
    }

    // Calculate and update bundle totals
    const flattened = await flattenBundle(bundleDef.id, user.tenantId)
    let totalCost = 0
    let totalPrice = 0

    for (const item of flattened) {
      totalCost += (item.unitCost || 0) * item.quantity
      totalPrice += item.unitPrice * item.quantity
    }

    await prisma.item.update({
      where: { id: item.id },
      data: {
        defaultUnitCost: totalCost > 0 ? totalCost : null,
        defaultUnitPrice: totalPrice > 0 ? totalPrice : 0,
      },
    })

    const bundle = await prisma.bundleDefinition.findFirst({
      where: { id: bundleDef.id },
      include: {
        item: true,
        components: {
          include: {
            componentItem: {
              select: {
                id: true,
                name: true,
                sku: true,
              },
            },
            componentBundle: {
              include: {
                item: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    return NextResponse.json({ bundle }, { status: 201 })
  } catch (error: any) {
    console.error('Create bundle error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
