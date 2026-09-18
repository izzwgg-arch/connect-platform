import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'
import { scoreHaystack, topN } from '@/lib/search/scoring'

/**
 * GET /api/items/picker
 * Returns items and bundles formatted for FastPicker component
 * Used by Estimates, Invoices, Purchase Orders for line item selection
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, [
    'settings.view',
    'estimates.view',
    'estimates.create',
    'invoices.view',
    'invoices.create',
    'purchase_orders.view',
    'purchase_orders.create',
    'jobs.view',
  ])
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const activeOnly = searchParams.get('activeOnly') !== 'false' // Default true

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    if (activeOnly) {
      where.isActive = true
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { name: ilike(term) },
        { sku: ilike(term) },
        { description: ilike(term) },
        { notes: ilike(term) },
        { vendor: { name: ilike(term) } },
      ])
    )

    // Fetch all items first, then split by kind.
    // This is resilient to legacy rows where kind may be null/unknown:
    // anything not explicitly BUNDLE is treated as a regular selectable item.
    const allItems = await prisma.item.findMany({
      where,
      include: {
        vendor: {
          select: {
            id: true,
            name: true,
          },
        },
        bundleDefinition: {
          include: {
            components: {
              include: {
                componentItem: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
                componentBundle: {
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
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
      take: 1000, // Reasonable limit for picker
    })

    const items = allItems.filter((item) => item.kind !== 'BUNDLE')
    const bundleItems = allItems.filter((item) => item.kind === 'BUNDLE')

    const rank = <T extends { name: string; sku: string | null; description: string | null; notes?: string | null; vendorName?: string | null }>(
      rows: T[]
    ) => {
      if (!search.trim()) return rows
      return topN(
        rows.map((row) => ({
          ...row,
          score: scoreHaystack(
            search,
            [row.name, row.sku],
            [row.description, row.notes, row.vendorName]
          ),
        })),
        rows.length
      )
    }

    // Format items for FastPicker
    const formattedItems = rank(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        kind: 'SINGLE' as const,
        defaultUnitPrice: Number(item.defaultUnitPrice),
        defaultUnitCost: item.defaultUnitCost ? Number(item.defaultUnitCost) : null,
        pricingMode: item.pricingMode,
        percentOfAboveRate: item.percentOfAboveRate ? Number(item.percentOfAboveRate) : null,
        unit: item.unit,
        vendorId: item.vendorId,
        vendorName: item.vendor?.name || null,
        taxable: item.taxable,
        taxRate: item.taxRate ? Number(item.taxRate) : null,
        description: item.description,
        notes: item.notes,
        tag: Array.isArray(item.tags) && item.tags.length > 0 ? item.tags.join(', ') : null,
      }))
    )

    // Format bundles for FastPicker
    const formattedBundles = rank(
      bundleItems.map((item) => ({
        id: item.id, // Item ID
        name: item.name,
        sku: item.sku,
        kind: 'BUNDLE' as const,
        defaultUnitPrice: Number(item.defaultUnitPrice),
        defaultUnitCost: item.defaultUnitCost ? Number(item.defaultUnitCost) : null,
        unit: item.unit,
        vendorId: item.vendorId,
        vendorName: item.vendor?.name || null,
        taxable: item.taxable,
        taxRate: item.taxRate ? Number(item.taxRate) : null,
        description: item.description,
        notes: item.notes,
        bundleId: item.bundleDefinition?.id || null, // BundleDefinition ID (for API calls)
        tag: Array.isArray(item.tags) && item.tags.length > 0 ? item.tags.join(', ') : null,
      }))
    )

    return NextResponse.json({
      items: formattedItems,
      bundles: formattedBundles,
    })
  } catch (error: any) {
    console.error('Get items for picker error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
