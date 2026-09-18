import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { normalizeEmailList, splitEmailList, isValidEmail } from '@/lib/email'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const client = await prisma.client.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        parent: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        subClients: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            companyName: true,
            email: true,
            phone: true,
            isActive: true,
            createdAt: true,
          },
        },
        contacts: {
          orderBy: [
            { isPrimary: 'desc' },
            { createdAt: 'asc' },
          ],
        },
        addresses: true,
        jobs: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            assignments: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
        },
        invoices: {
          where: {
            balance: { gt: 0 },
            status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
          },
          take: 100,
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
        },
        estimates: {
          take: 10,
          orderBy: { createdAt: 'desc' },
        },
        calls: {
          take: 20,
          orderBy: { startedAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        smsMessages: {
          take: 20,
          orderBy: { sentAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        emails: {
          take: 20,
          orderBy: { sentAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        notes_history: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        tasks: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            assignee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        issues: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            assignee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        _count: {
          select: {
            jobs: true,
            invoices: true,
            estimates: true,
            calls: true,
            smsMessages: true,
            emails: true,
          },
        },
      },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Compute client-level open invoice balance for clear visibility on detail page.
    const openInvoiceAgg = await prisma.invoice.aggregate({
      where: {
        tenantId: user.tenantId,
        clientId: client.id,
        balance: { gt: 0 },
        status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
      } as any,
      _sum: {
        balance: true,
      },
    })

    const directSubClients = client.subClients || []
    const directSubClientIds = directSubClients.map((subClient) => subClient.id)
    const descendantIdsByRootSubClient = new Map<string, string[]>()
    const rootSubClientByClientId = new Map<string, string>()
    for (const subClientId of directSubClientIds) {
      rootSubClientByClientId.set(subClientId, subClientId)
      descendantIdsByRootSubClient.set(subClientId, [subClientId])
    }

    let frontierParentIds = [...directSubClientIds]
    const visitedDescendantIds = new Set<string>(directSubClientIds)
    let descendantDepth = 0
    const maxDescendantDepth = 50
    while (frontierParentIds.length > 0 && descendantDepth < maxDescendantDepth) {
      descendantDepth += 1
      const nextLayer = await prisma.client.findMany({
        where: {
          tenantId: user.tenantId,
          parentId: { in: frontierParentIds },
        },
        select: { id: true, parentId: true },
      })
      if (nextLayer.length === 0) break
      frontierParentIds = []
      for (const child of nextLayer) {
        if (!child.parentId || visitedDescendantIds.has(child.id)) continue
        visitedDescendantIds.add(child.id)
        const rootSubClientId = rootSubClientByClientId.get(child.parentId) || child.parentId
        rootSubClientByClientId.set(child.id, rootSubClientId)
        const ids = descendantIdsByRootSubClient.get(rootSubClientId) || [rootSubClientId]
        ids.push(child.id)
        descendantIdsByRootSubClient.set(rootSubClientId, ids)
        frontierParentIds.push(child.id)
      }
    }

    const allSubClientIds = Array.from(
      new Set(Array.from(descendantIdsByRootSubClient.values()).flat())
    )
    const subClientBalanceRows = allSubClientIds.length
      ? await prisma.invoice.groupBy({
          by: ['clientId'],
          where: {
            tenantId: user.tenantId,
            clientId: { in: allSubClientIds },
            balance: { gt: 0 },
            status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
          } as any,
          _sum: {
            balance: true,
          },
        })
      : []
    const subClientBalanceById = new Map<string, string>()
    for (const row of subClientBalanceRows) {
      if (!row.clientId) continue
      subClientBalanceById.set(String(row.clientId), row._sum.balance?.toString() || '0')
    }
    const subClientsWithBalances = directSubClients.map((subClient) => {
      const descendantIds = descendantIdsByRootSubClient.get(subClient.id) || [subClient.id]
      const combinedOpenBalance = descendantIds.reduce(
        (sum, childId) => sum + Number(subClientBalanceById.get(childId) || 0),
        0
      )
      return {
        ...subClient,
        openInvoiceBalance: combinedOpenBalance.toFixed(2),
      }
    })
    const subClientsOpenInvoiceBalance = subClientsWithBalances.reduce(
      (sum, subClient) => sum + Number(subClient.openInvoiceBalance || 0),
      0
    )

    const [subClientEstimates, subClientInvoices] = allSubClientIds.length
      ? await Promise.all([
          prisma.estimate.findMany({
            where: {
              tenantId: user.tenantId,
              clientId: { in: allSubClientIds },
            },
            select: {
              id: true,
              estimateNumber: true,
              title: true,
              status: true,
              total: true,
              createdAt: true,
              clientId: true,
              client: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          }),
          prisma.invoice.findMany({
            where: {
              tenantId: user.tenantId,
              clientId: { in: allSubClientIds },
            },
            select: {
              id: true,
              invoiceNumber: true,
              title: true,
              status: true,
              total: true,
              balance: true,
              dueDate: true,
              createdAt: true,
              clientId: true,
              client: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          }),
        ])
      : [[], []]

    // Ensure all arrays are present (defensive)
    const safeClient = {
      ...client,
      contacts: client.contacts || [],
      addresses: client.addresses || [],
      jobs: client.jobs || [],
      invoices: client.invoices || [],
      estimates: client.estimates || [],
      calls: client.calls || [],
      smsMessages: client.smsMessages || [],
      emails: client.emails || [],
      // Keep `notes` as the client text field; expose history on a separate key.
      notes: client.notes || null,
      notesHistory: client.notes_history || [],
      tasks: client.tasks || [],
      issues: client.issues || [],
      parent: client.parent || null,
      subClients: subClientsWithBalances,
      subClientEstimates: subClientEstimates.map((estimate) => ({
        ...estimate,
        total: estimate.total.toString(),
      })),
      subClientInvoices: subClientInvoices.map((invoice) => ({
        ...invoice,
        total: invoice.total.toString(),
        balance: invoice.balance.toString(),
      })),
      _count: client._count || {
        jobs: 0,
        invoices: 0,
        estimates: 0,
        calls: 0,
        smsMessages: 0,
        emails: 0,
      },
      openInvoiceBalance: openInvoiceAgg._sum.balance?.toString() || '0',
      subClientsOpenInvoiceBalance: subClientsOpenInvoiceBalance.toFixed(2),
    }

    return NextResponse.json({ client: safeClient })
  } catch (error) {
    console.error('Get client error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { name, companyName, email, phone, website, notes, tags, isActive, billingAddress, shippingAddress, parentId } = body

    let normalizedEmail: string | null | undefined = undefined
    if (email !== undefined) {
      normalizedEmail = normalizeEmailList(email)
      const parts = splitEmailList(normalizedEmail)
      if (parts.some((e) => !isValidEmail(e))) {
        return NextResponse.json(
          { error: 'Invalid email address (use comma-separated emails like a@x.com, b@y.com)' },
          { status: 400 }
        )
      }
    }

    // Get existing client
    const existing = await prisma.client.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        addresses: true,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    let normalizedParentId: string | null | undefined = undefined
    if (parentId !== undefined) {
      normalizedParentId = typeof parentId === 'string' && parentId.trim() ? parentId.trim() : null

      if (normalizedParentId === params.id) {
        return NextResponse.json({ error: 'A client cannot be its own parent.' }, { status: 400 })
      }

      if (normalizedParentId) {
        const parentClient = await prisma.client.findFirst({
          where: {
            id: normalizedParentId,
            tenantId: user.tenantId,
          },
          select: { id: true, parentId: true },
        })

        if (!parentClient) {
          return NextResponse.json({ error: 'Selected parent client was not found.' }, { status: 400 })
        }

        let cursorParentId = parentClient.parentId
        let guard = 0
        while (cursorParentId && guard < 50) {
          if (cursorParentId === params.id) {
            return NextResponse.json(
              { error: 'You cannot move a client under one of its own descendants.' },
              { status: 400 }
            )
          }
          const nextParent = await prisma.client.findFirst({
            where: {
              id: cursorParentId,
              tenantId: user.tenantId,
            },
            select: { parentId: true },
          })
          cursorParentId = nextParent?.parentId || null
          guard += 1
        }
      }
    }

    // Update client
    const client = await prisma.client.update({
      where: { id: params.id },
      data: {
        name: name !== undefined ? name : existing.name,
        companyName: companyName !== undefined ? companyName : existing.companyName,
        email: normalizedEmail !== undefined ? normalizedEmail : existing.email,
        phone: phone !== undefined ? phone : existing.phone,
        website: website !== undefined ? website : existing.website,
        notes: notes !== undefined ? notes : existing.notes,
        tags: tags !== undefined ? tags : existing.tags,
        isActive: isActive !== undefined ? isActive : existing.isActive,
        parentId: normalizedParentId !== undefined ? normalizedParentId : existing.parentId,
      },
    })

    // Upsert billing/shipping addresses (match create-client behavior)
    const upsertAddress = async (type: 'billing' | 'shipping', addr: any) => {
      const existingAddr = (existing.addresses || []).find((a) => a.type === type)

      const isEmpty =
        !addr ||
        typeof addr !== 'object' ||
        typeof addr.street !== 'string' ||
        addr.street.trim() === ''

      if (isEmpty) {
        // If cleared, delete existing address of this type (if any)
        if (existingAddr) {
          await prisma.address.delete({ where: { id: existingAddr.id } })
        }
        return
      }

      const data = {
        clientId: client.id,
        type,
        street: String(addr.street || '').trim(),
        city: String(addr.city || '').trim(),
        state: String(addr.state || '').trim(),
        zipCode: String(addr.zipCode || '').trim(),
        country: String(addr.country || 'US').trim() || 'US',
        ...(type === 'billing' ? { isDefault: true } : {}),
      }

      if (existingAddr) {
        await prisma.address.update({
          where: { id: existingAddr.id },
          data,
        })
      } else {
        await prisma.address.create({ data })
      }
    }

    await upsertAddress('billing', billingAddress)
    await upsertAddress('shipping', shippingAddress)

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Client',
        entityId: client.id,
        changes: {
          before: {
            name: existing.name,
            email: existing.email,
            phone: existing.phone,
          },
          after: {
            name: client.name,
            email: client.email,
            phone: client.phone,
          },
        },
      },
    })

    // Best-effort: keep QBO customer in sync after every client edit.
    try {
      await enqueueQboSync(user.tenantId, 'client', client.id)
    } catch (error) {
      console.error('QuickBooks client sync trigger error (client update):', error)
    }

    return NextResponse.json({ client })
  } catch (error) {
    console.error('Update client error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const client = await prisma.client.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
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

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Hard delete is blocked by DB constraints when jobs/invoices exist (onDelete: Restrict).
    if (client._count.jobs > 0 || client._count.invoices > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete client "${client.name}" because it has ${client._count.jobs} job(s) and ${client._count.invoices} invoice(s). Remove those records first.`,
        },
        { status: 400 }
      )
    }

    await prisma.client.delete({
      where: { id: params.id },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entityType: 'Client',
        entityId: client.id,
      },
    })

    return NextResponse.json({ message: 'Client deleted successfully' })
  } catch (error) {
    console.error('Delete client error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
