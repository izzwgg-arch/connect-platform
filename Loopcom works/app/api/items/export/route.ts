import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const items = await prisma.item.findMany({
      where: {
        tenantId: user.tenantId,
      },
      include: {
        vendor: {
          select: {
            name: true,
          },
        },
        category: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    })

    // Generate CSV
    const headers = ['Name', 'SKU', 'Type', 'Description', 'Unit', 'Unit Cost', 'Unit Price', 'Taxable', 'Tax Rate', 'Active', 'Vendor', 'Category', 'Tags', 'Notes']
    const rows = items.map((item) => [
      item.name,
      item.sku || '',
      item.type,
      item.description || '',
      item.unit,
      item.defaultUnitCost?.toString() || '',
      item.defaultUnitPrice.toString(),
      item.taxable ? 'Yes' : 'No',
      item.taxRate?.toString() || '',
      item.isActive ? 'Yes' : 'No',
      item.vendor?.name || '',
      item.category?.name || '',
      item.tags.join('; '),
      item.notes || '',
    ])

    const csv = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="items-export-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (error) {
    console.error('Export items error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
