import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { createPaginationResponse } from '@/lib/pagination'
import { validateRequest, createClientSchema } from '@/lib/validation'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || 'all'
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  // Client pickers on create/edit forms need more than the default 100-item cap.
  const limit = Math.min(5000, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)))
  const skip = (page - 1) * limit
  const take = limit

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { name: ilike(term) },
        { companyName: ilike(term) },
        { email: ilike(term) },
        { phone: ilike(term) },
        { notes: ilike(term) },
        {
          contacts: {
            some: {
              OR: [
                { firstName: ilike(term) },
                { lastName: ilike(term) },
                { email: ilike(term) },
                { phone: ilike(term) },
              ],
            },
          },
        },
        {
          addresses: {
            some: {
              OR: [
                { street: ilike(term) },
                { city: ilike(term) },
                { state: ilike(term) },
                { zipCode: ilike(term) },
              ],
            },
          },
        },
      ])
    )

    if (status !== 'all') {
      where.isActive = status === 'active'
    }

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        where,
        include: {
          parent: {
            select: {
              id: true,
              name: true,
            },
          },
          contacts: {
            where: { isPrimary: true },
            take: 1,
          },
          addresses: {
            orderBy: { isDefault: 'desc' },
            take: 1,
            select: {
              street: true,
              city: true,
              state: true,
              zipCode: true,
            },
          },
          _count: {
            select: {
              jobs: true,
              invoices: true,
            },
          },
        },
        orderBy: {
          updatedAt: 'desc',
        },
        skip,
        take,
      }),
      prisma.client.count({ where }),
    ])

    const clientIds = clients.map((c) => c.id)
    const openBalanceByClientId = new Map<string, string>()

    const parentIdsOnPage = clients.filter((c) => !c.parentId).map((c) => c.id)
    const childIdsByParent = new Map<string, string[]>()
    const rootParentByClientId = new Map<string, string>()
    for (const parentId of parentIdsOnPage) rootParentByClientId.set(parentId, parentId)

    let frontierParentIds = [...parentIdsOnPage]
    const allDescendants: Array<{ id: string; parentId: string | null }> = []
    while (frontierParentIds.length > 0) {
      const nextLayer = await prisma.client.findMany({
        where: { tenantId: user.tenantId, parentId: { in: frontierParentIds } },
        select: { id: true, parentId: true },
      })
      if (nextLayer.length === 0) break

      frontierParentIds = []
      for (const child of nextLayer) {
        if (!child.parentId) continue
        const rootParentId = rootParentByClientId.get(child.parentId) || child.parentId
        rootParentByClientId.set(child.id, rootParentId)
        const list = childIdsByParent.get(rootParentId) || []
        list.push(child.id)
        childIdsByParent.set(rootParentId, list)
        frontierParentIds.push(child.id)
        allDescendants.push(child)
      }
    }

    const extraChildIds = allDescendants.map((c) => c.id).filter((id) => !clientIds.includes(id))
    const balanceClientIds = [...clientIds, ...extraChildIds]

    if (balanceClientIds.length) {
      // "Open" means there is a remaining balance and it isn't closed/cancelled/refunded.
      const grouped = await prisma.invoice.groupBy({
        by: ['clientId'],
        where: {
          tenantId: user.tenantId,
          clientId: { in: balanceClientIds },
          balance: { gt: 0 },
          status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
        } as any,
        _sum: { balance: true },
      })

      for (const row of grouped) {
        openBalanceByClientId.set(String(row.clientId), row._sum.balance?.toString() || '0')
      }
    }

    const sumOpen = (clientId: string) => parseFloat(openBalanceByClientId.get(clientId) || '0')

    return NextResponse.json({
      clients: clients.map((c) => {
        const own = sumOpen(c.id)
        const childIds = childIdsByParent.get(c.id) || []
        const withSubs =
          childIds.length > 0 ? own + childIds.reduce((s, cid) => s + sumOpen(cid), 0) : own
        return {
          ...c,
          address: c.addresses?.[0]
            ? [c.addresses[0].street, [c.addresses[0].city, c.addresses[0].state, c.addresses[0].zipCode].filter(Boolean).join(' ')]
                .filter(Boolean)
                .join(', ')
            : null,
          openInvoiceBalance: own.toFixed(2),
          openInvoiceBalanceWithSubClients: childIds.length > 0 ? withSubs.toFixed(2) : null,
        }
      }),
      pagination: createPaginationResponse(total, limit, skip),
    })
  } catch (error) {
    console.error('Get clients error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.create')
  if (permError) return permError

  const user = getAuthUser(request)

  // Validate request body
  const validation = await validateRequest(request, createClientSchema)
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: validation.status })
  }

  const { name, parentId, companyName, email, phone, website, notes, tags, billingAddress, shippingAddress } = validation.data

  try {

    let resolvedParentId: string | null = null
    let inheritedBillingAddress: typeof billingAddress = null
    if (parentId) {
      const parent = await prisma.client.findFirst({
        where: {
          id: parentId,
          tenantId: user.tenantId,
        },
        include: {
          addresses: {
            where: { type: 'billing' },
            take: 1,
          },
        },
      })

      if (!parent) {
        return NextResponse.json({ error: 'Parent client not found' }, { status: 400 })
      }

      resolvedParentId = parent.id
      if (!billingAddress && parent.addresses[0]) {
        inheritedBillingAddress = {
          street: parent.addresses[0].street,
          city: parent.addresses[0].city,
          state: parent.addresses[0].state,
          zipCode: parent.addresses[0].zipCode,
          country: parent.addresses[0].country || 'US',
        }
      }
    }

    // Create client
    const client = await prisma.client.create({
      data: {
        tenantId: user.tenantId,
        parentId: resolvedParentId,
        name,
        companyName: companyName || null,
        email: email || null,
        phone: phone || null,
        website: website || null,
        notes: notes || null,
        tags: tags || [],
        isActive: true,
      },
      include: {
        contacts: true,
        addresses: true,
      },
    })

    // Create billing address if provided (or inherit from parent client)
    const finalBillingAddress = billingAddress || inheritedBillingAddress
    if (finalBillingAddress) {
      await prisma.address.create({
        data: {
          clientId: client.id,
          type: 'billing',
          street: finalBillingAddress.street,
          city: finalBillingAddress.city,
          state: finalBillingAddress.state,
          zipCode: finalBillingAddress.zipCode,
          country: finalBillingAddress.country || 'US',
          isDefault: true,
        },
      })
    }

    // Sub-clients use billing address only; skip shipping address when parent is set.
    if (!resolvedParentId && shippingAddress) {
      await prisma.address.create({
        data: {
          clientId: client.id,
          type: 'shipping',
          street: shippingAddress.street,
          city: shippingAddress.city,
          state: shippingAddress.state,
          zipCode: shippingAddress.zipCode,
          country: shippingAddress.country || 'US',
        },
      })
    }

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'CLIENT_CREATED',
        description: `Client "${name}" created`,
        clientId: client.id,
      },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'CREATE',
        entityType: 'Client',
        entityId: client.id,
        changes: {
          name,
          email,
          phone,
        },
      },
    })

    // Creating a client from Clients page should create/sync the customer in QuickBooks.
    try {
      await enqueueQboSync(user.tenantId, 'client', client.id)
    } catch (error) {
      console.error('QuickBooks client sync trigger error:', error)
    }

    return NextResponse.json({ client }, { status: 201 })
  } catch (error) {
    console.error('Create client error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const ids = Array.isArray(body?.ids) ? body.ids.map((x: any) => String(x)) : []
    const uniqueIds = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)))

    if (uniqueIds.length === 0) {
      return NextResponse.json({ error: 'No client ids provided' }, { status: 400 })
    }

    // Preload to validate tenant scope and detect blocked deletions.
    const clients = await prisma.client.findMany({
      where: {
        tenantId: user.tenantId,
        id: { in: uniqueIds },
      },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            jobs: true,
            invoices: true,
          },
        },
      },
    })

    const foundIds = new Set(clients.map((c) => c.id))
    const notFound = uniqueIds.filter((id) => !foundIds.has(id))

    const blocked = clients
      .filter((c) => (c._count.jobs || 0) > 0 || (c._count.invoices || 0) > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        jobs: c._count.jobs,
        invoices: c._count.invoices,
      }))

    const deletable = clients.filter((c) => !blocked.some((b) => b.id === c.id))
    const deletableIds = deletable.map((c) => c.id)

    if (deletableIds.length === 0) {
      return NextResponse.json(
        {
          success: false,
          deletedCount: 0,
          blocked,
          notFound,
          error: 'No clients could be deleted (all selected clients are blocked by jobs/invoices).',
        },
        { status: 400 }
      )
    }

    const now = new Date()

    const [deleteResult] = await prisma.$transaction([
      prisma.client.deleteMany({
        where: {
          tenantId: user.tenantId,
          id: { in: deletableIds },
        },
      }),
      prisma.auditLog.createMany({
        data: deletableIds.map((id) => ({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'DELETE',
          entityType: 'Client',
          entityId: id,
          createdAt: now,
        })),
      }),
    ])

    return NextResponse.json({
      success: true,
      deletedCount: deleteResult.count,
      blocked,
      notFound,
    })
  } catch (error: any) {
    console.error('Bulk delete clients error:', error)
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 500 })
  }
}
