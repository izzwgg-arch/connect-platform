import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.export')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const vendors = await prisma.vendor.findMany({
      where: {
        tenantId: user.tenantId,
      },
      include: {
        contacts: {
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        },
      },
      orderBy: {
        name: 'asc',
      },
    })

    const headers = [
      'Name',
      'Vendor Code',
      'Status',
      'Email',
      'Phone',
      'Website',
      'Primary Contact',
      'Primary Contact Email',
      'Primary Contact Phone',
      'Payment Terms',
      'Notes',
      'Billing Street',
      'Billing City',
      'Billing State',
      'Billing Zip',
      'Billing Country',
      'Shipping Street',
      'Shipping City',
      'Shipping State',
      'Shipping Zip',
      'Shipping Country',
    ]

    const rows = vendors.map((vendor) => {
      const primary = vendor.contacts.find((c) => c.isPrimary) || vendor.contacts[0] || null
      return [
        vendor.name,
        vendor.vendorCode || '',
        vendor.status,
        vendor.email || '',
        vendor.phone || '',
        vendor.website || '',
        primary?.name || '',
        primary?.email || '',
        primary?.phone || '',
        vendor.paymentTerms,
        vendor.notes || '',
        vendor.billingStreet || '',
        vendor.billingCity || '',
        vendor.billingState || '',
        vendor.billingZip || '',
        vendor.billingCountry || '',
        vendor.shippingStreet || '',
        vendor.shippingCity || '',
        vendor.shippingState || '',
        vendor.shippingZip || '',
        vendor.shippingCountry || '',
      ]
    })

    const csv = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="vendors-export-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (error) {
    console.error('Export vendors error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
