import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const vendor = await prisma.vendor.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        contacts: {
          orderBy: [
            { isPrimary: 'desc' },
            { name: 'asc' },
          ],
        },
        purchaseOrders: {
          select: {
            id: true,
            poNumber: true,
            status: true,
            total: true,
            orderDate: true,
            expectedDate: true,
            receivedDate: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 50,
        },
        items: {
          select: {
            id: true,
            name: true,
            sku: true,
            type: true,
            defaultUnitPrice: true,
            isActive: true,
          },
          where: {
            isActive: true,
          },
          take: 50,
        },
        attachments: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        _count: {
          select: {
            purchaseOrders: true,
            items: true,
          },
        },
      },
    })

    if (!vendor) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    // Calculate metrics
    const totalSpend = vendor.purchaseOrders.reduce((sum, po) => sum + Number(po.total), 0)
    const openPOs = vendor.purchaseOrders.filter(po => 
      ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED'].includes(po.status)
    )

    return NextResponse.json({
      vendor: {
        ...vendor,
        metrics: {
          totalSpend,
          openPOCount: openPOs.length,
          totalPOCount: vendor._count.purchaseOrders,
          itemsCount: vendor._count.items,
        },
      },
    })
  } catch (error) {
    console.error('Get vendor error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      name,
      vendorCode,
      status,
      email,
      phone,
      website,
      notes,
      billingStreet,
      billingCity,
      billingState,
      billingZip,
      billingCountry,
      shippingStreet,
      shippingCity,
      shippingState,
      shippingZip,
      shippingCountry,
      paymentTerms,
      customTermsText,
      taxId,
      defaultCurrency,
      contacts,
    } = body

    // Verify vendor exists
    const existing = await prisma.vendor.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    // Check for duplicate vendorCode if provided and changed
    if (vendorCode && vendorCode.trim() && vendorCode !== existing.vendorCode) {
      const duplicate = await prisma.vendor.findFirst({
        where: {
          vendorCode: vendorCode.trim(),
          tenantId: user.tenantId,
          id: { not: params.id },
        },
      })
      if (duplicate) {
        return NextResponse.json({ error: 'Vendor code already exists' }, { status: 400 })
      }
    }

    // Update vendor
    const vendor = await prisma.vendor.update({
      where: { id: params.id },
      data: {
        name: name !== undefined ? name.trim() : existing.name,
        vendorCode: vendorCode !== undefined ? (vendorCode && vendorCode.trim() ? vendorCode.trim() : null) : existing.vendorCode,
        status: status !== undefined ? status : existing.status,
        email: email !== undefined ? (email && email.trim() ? email.trim() : null) : existing.email,
        phone: phone !== undefined ? (phone && phone.trim() ? phone.trim() : null) : existing.phone,
        website: website !== undefined ? (website && website.trim() ? website.trim() : null) : existing.website,
        notes: notes !== undefined ? (notes && notes.trim() ? notes.trim() : null) : existing.notes,
        billingStreet: billingStreet !== undefined ? (billingStreet && billingStreet.trim() ? billingStreet.trim() : null) : existing.billingStreet,
        billingCity: billingCity !== undefined ? (billingCity && billingCity.trim() ? billingCity.trim() : null) : existing.billingCity,
        billingState: billingState !== undefined ? (billingState && billingState.trim() ? billingState.trim() : null) : existing.billingState,
        billingZip: billingZip !== undefined ? (billingZip && billingZip.trim() ? billingZip.trim() : null) : existing.billingZip,
        billingCountry: billingCountry !== undefined ? (billingCountry && billingCountry.trim() ? billingCountry.trim() : null) : existing.billingCountry,
        shippingStreet: shippingStreet !== undefined ? (shippingStreet && shippingStreet.trim() ? shippingStreet.trim() : null) : existing.shippingStreet,
        shippingCity: shippingCity !== undefined ? (shippingCity && shippingCity.trim() ? shippingCity.trim() : null) : existing.shippingCity,
        shippingState: shippingState !== undefined ? (shippingState && shippingState.trim() ? shippingState.trim() : null) : existing.shippingState,
        shippingZip: shippingZip !== undefined ? (shippingZip && shippingZip.trim() ? shippingZip.trim() : null) : existing.shippingZip,
        shippingCountry: shippingCountry !== undefined ? (shippingCountry && shippingCountry.trim() ? shippingCountry.trim() : null) : existing.shippingCountry,
        paymentTerms: paymentTerms !== undefined ? paymentTerms : existing.paymentTerms,
        customTermsText: customTermsText !== undefined ? (customTermsText && customTermsText.trim() ? customTermsText.trim() : null) : existing.customTermsText,
        taxId: taxId !== undefined ? (taxId && taxId.trim() ? taxId.trim() : null) : existing.taxId,
        defaultCurrency: defaultCurrency !== undefined ? (defaultCurrency && defaultCurrency.trim() ? defaultCurrency.trim() : 'USD') : existing.defaultCurrency,
        isActive: status !== undefined ? (status !== 'INACTIVE') : existing.isActive,
      },
      include: {
        contacts: true,
      },
    })

    // Update contacts if provided
    if (contacts && Array.isArray(contacts)) {
      // Delete existing contacts
      await prisma.vendorContact.deleteMany({
        where: { vendorId: params.id },
      })

      // Create new contacts
      for (const contact of contacts) {
        if (contact.name && contact.name.trim()) {
          await prisma.vendorContact.create({
            data: {
              vendorId: vendor.id,
              tenantId: user.tenantId,
              name: contact.name.trim(),
              title: contact.title && contact.title.trim() ? contact.title.trim() : null,
              email: contact.email && contact.email.trim() ? contact.email.trim() : null,
              phone: contact.phone && contact.phone.trim() ? contact.phone.trim() : null,
              isPrimary: contact.isPrimary === true,
              notes: contact.notes && contact.notes.trim() ? contact.notes.trim() : null,
            },
          })
        }
      }
    }

    // Create activity
    void prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Vendor "${vendor.name}" updated`,
      },
    })

    const updated = await prisma.vendor.findFirst({
      where: { id: params.id },
      include: {
        contacts: {
          orderBy: [
            { isPrimary: 'desc' },
            { name: 'asc' },
          ],
        },
      },
    })

    try {
      await enqueueQboSync(user.tenantId, 'vendor', params.id)
    } catch (error) {
      console.error('QuickBooks vendor sync trigger error (update):', error)
    }

    return NextResponse.json({ vendor: updated })
  } catch (error: any) {
    console.error('Update vendor error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const vendor = await prisma.vendor.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        _count: {
          select: {
            purchaseOrders: true,
            items: true,
          },
        },
      },
    })

    if (!vendor) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    // Prevent deletion if vendor has purchase orders
    if (vendor._count.purchaseOrders > 0) {
      return NextResponse.json(
        { error: 'Cannot delete vendor with existing purchase orders. Please delete or reassign purchase orders first.' },
        { status: 400 }
      )
    }

    // Delete vendor contacts first (cascade should handle this, but being explicit)
    await prisma.vendorContact.deleteMany({
      where: { vendorId: params.id },
    })

    // Delete vendor
    await prisma.vendor.delete({
      where: { id: params.id },
    })

    // Create activity
    void prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Vendor "${vendor.name}" deleted`,
      },
    })

    return NextResponse.json({ message: 'Vendor deleted successfully' })
  } catch (error: any) {
    console.error('Delete vendor error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
