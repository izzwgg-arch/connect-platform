import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

// POST - Ungroup items (remove groupId from line items, delete group)
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

    // Remove groupId from all line items in the group
    await prisma.invoiceLineItem.updateMany({
      where: {
        groupId: params.groupId,
      },
      data: {
        groupId: null,
      },
    })

    // Delete the group
    await prisma.documentLineGroup.delete({
      where: {
        id: params.groupId,
      },
    })

    // Recalculate invoice totals
    const allLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: params.id },
    })

    const subtotal = allLineItems.reduce((sum, item) => sum + Number(item.total), 0)
    const taxAmount = subtotal * Number(invoice.taxRate || 0)
    const discount = Number(invoice.discount || 0)
    const total = subtotal - discount + taxAmount

    await prisma.invoice.update({
      where: { id: params.id },
      data: {
        subtotal,
        taxAmount,
        total,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Ungroup error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
