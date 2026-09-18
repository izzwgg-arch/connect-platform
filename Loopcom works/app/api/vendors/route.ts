import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission, requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  // Vendor is a required field when creating a PO, so anyone who can create or
  // edit a PO must be able to read the vendor list — not just those with view.
  const permError = await requireAnyPermission(request, [
    'purchase_orders.view',
    'purchase_orders.create',
    'purchase_orders.edit',
  ])
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || 'all'
  const paymentTerms = searchParams.get('paymentTerms') || ''
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const skip = (page - 1) * limit

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    // Status filter
    if (status === 'active') {
      where.status = 'ACTIVE'
      where.isActive = true // Also check legacy field
    } else if (status === 'inactive') {
      where.status = 'INACTIVE'
      where.isActive = false
    } else if (status === 'all') {
      // Show all
    }

    // Payment terms filter
    if (paymentTerms) {
      where.paymentTerms = paymentTerms
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { name: ilike(term) },
        { email: ilike(term) },
        { phone: ilike(term) },
        { vendorCode: ilike(term) },
        { notes: ilike(term) },
        { contactPerson: ilike(term) },
        { address: ilike(term) },
        { city: ilike(term) },
        { state: ilike(term) },
        { zipCode: ilike(term) },
        { billingStreet: ilike(term) },
        { billingCity: ilike(term) },
        { billingZip: ilike(term) },
      ])
    )

    const [vendors, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        include: {
          contacts: {
            where: { isPrimary: true },
            take: 1,
          },
          _count: {
            select: {
              purchaseOrders: true,
              items: true,
            },
          },
        },
        orderBy: {
          name: 'asc',
        },
        skip,
        take: limit,
      }),
      prisma.vendor.count({ where }),
    ])

    return NextResponse.json({
      vendors,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get vendors error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.create')
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
      // Legacy fields for backward compatibility
      address,
      city,
      state,
      zipCode,
      country,
      contactPerson,
    } = body

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    // Check for duplicate vendorCode if provided
    if (vendorCode && vendorCode.trim()) {
      const existing = await prisma.vendor.findFirst({
        where: {
          vendorCode: vendorCode.trim(),
          tenantId: user.tenantId,
        },
      })
      if (existing) {
        return NextResponse.json({ error: 'Vendor code already exists' }, { status: 400 })
      }
    }

    // Create vendor
    const vendor = await prisma.vendor.create({
      data: {
        tenantId: user.tenantId,
        name: name.trim(),
        vendorCode: vendorCode && vendorCode.trim() ? vendorCode.trim() : null,
        status: status || 'ACTIVE',
        email: email && email.trim() ? email.trim() : null,
        phone: phone && phone.trim() ? phone.trim() : null,
        website: website && website.trim() ? website.trim() : null,
        notes: notes && notes.trim() ? notes.trim() : null,
        billingStreet: billingStreet && billingStreet.trim() ? billingStreet.trim() : (address && address.trim() ? address.trim() : null),
        billingCity: billingCity && billingCity.trim() ? billingCity.trim() : (city && city.trim() ? city.trim() : null),
        billingState: billingState && billingState.trim() ? billingState.trim() : (state && state.trim() ? state.trim() : null),
        billingZip: billingZip && billingZip.trim() ? billingZip.trim() : (zipCode && zipCode.trim() ? zipCode.trim() : null),
        billingCountry: billingCountry && billingCountry.trim() ? billingCountry.trim() : (country && country.trim() ? country.trim() : 'USA'),
        shippingStreet: shippingStreet && shippingStreet.trim() ? shippingStreet.trim() : null,
        shippingCity: shippingCity && shippingCity.trim() ? shippingCity.trim() : null,
        shippingState: shippingState && shippingState.trim() ? shippingState.trim() : null,
        shippingZip: shippingZip && shippingZip.trim() ? shippingZip.trim() : null,
        shippingCountry: shippingCountry && shippingCountry.trim() ? shippingCountry.trim() : null,
        paymentTerms: paymentTerms || 'NET_30',
        customTermsText: customTermsText && customTermsText.trim() ? customTermsText.trim() : null,
        taxId: taxId && taxId.trim() ? taxId.trim() : null,
        defaultCurrency: defaultCurrency && defaultCurrency.trim() ? defaultCurrency.trim() : 'USD',
        isActive: status !== 'INACTIVE',
        // Legacy fields
        address: address && address.trim() ? address.trim() : null,
        city: city && city.trim() ? city.trim() : null,
        state: state && state.trim() ? state.trim() : null,
        zipCode: zipCode && zipCode.trim() ? zipCode.trim() : null,
        country: country && country.trim() ? country.trim() : 'USA',
        contactPerson: contactPerson && contactPerson.trim() ? contactPerson.trim() : null,
      },
    })

    // Create contacts if provided
    if (contacts && Array.isArray(contacts)) {
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
    } else if (contactPerson && contactPerson.trim()) {
      // Legacy: create a contact from contactPerson
      await prisma.vendorContact.create({
        data: {
          vendorId: vendor.id,
          tenantId: user.tenantId,
          name: contactPerson.trim(),
          isPrimary: true,
        },
      })
    }

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Vendor "${name}" created`,
      },
    })

    try {
      await enqueueQboSync(user.tenantId, 'vendor', vendor.id)
    } catch (error) {
      console.error('QuickBooks vendor sync trigger error:', error)
    }

    return NextResponse.json({ vendor }, { status: 201 })
  } catch (error) {
    console.error('Create vendor error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
