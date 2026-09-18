import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

// POST - Add a line item to a group
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; groupId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { description, quantity, unitPrice, sourceItemId } = body

    if (!description || !quantity || unitPrice === undefined) {
      return NextResponse.json(
        { error: 'Description, quantity, and unitPrice are required' },
        { status: 400 }
      )
    }

    // Verify invoice exists and user has access
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Verify group exists and belongs to this invoice
    const group = await prisma.documentLineGroup.findFirst({
      where: {
        id: params.groupId,
        documentType: 'INVOICE',
        documentId: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    // Get current max sortOrder for items in this group
    const maxSort = await prisma.invoiceLineItem.findFirst({
      where: { groupId: params.groupId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    })
    const sortOrder = (maxSort?.sortOrder ?? -1) + 1

    const qty = parseFloat(quantity)
    const price = parseFloat(unitPrice)
    const total = qty * price

    // Create line item
    const lineItem = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: params.id,
        groupId: params.groupId,
        sourceItemId: sourceItemId || null,
        description: description.trim(),
        quantity: qty,
        unitPrice: price,
        total,
        sortOrder,
      },
    })

    // Recalculate invoice totals
    const allLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: params.id },
    })

    const subtotal = allLineItems.reduce((sum, item) => sum + Number(item.total), 0)
    const taxAmount = subtotal * Number(invoice.taxRate || 0)
    const discount = Number(invoice.discount || 0)
    const totalAmount = subtotal - discount + taxAmount

    await prisma.invoice.update({
      where: { id: params.id },
      data: {
        subtotal,
        taxAmount,
        total: totalAmount,
      },
    })

    return NextResponse.json({
      lineItem: {
        ...lineItem,
        quantity: lineItem.quantity.toString(),
        unitPrice: lineItem.unitPrice.toString(),
        total: lineItem.total.toString(),
      },
    })
  } catch (error: any) {
    console.error('Add item to group error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
