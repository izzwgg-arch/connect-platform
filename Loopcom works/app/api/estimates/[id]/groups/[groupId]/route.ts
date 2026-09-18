import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

// DELETE - Remove a group (and all its line items)
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; groupId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    // Verify estimate exists and user has access
    const estimate = await prisma.estimate.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    // Verify group exists and belongs to this estimate
    const group = await prisma.documentLineGroup.findFirst({
      where: {
        id: params.groupId,
        documentType: 'ESTIMATE',
        documentId: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    // Delete all line items in the group
    await prisma.estimateLineItem.deleteMany({
      where: {
        groupId: params.groupId,
      },
    })

    // Delete the group
    await prisma.documentLineGroup.delete({
      where: {
        id: params.groupId,
      },
    })

    // Recalculate estimate totals
    const allLineItems = await prisma.estimateLineItem.findMany({
      where: { estimateId: params.id },
    })

    const subtotal = allLineItems.reduce((sum, item) => sum + Number(item.total), 0)
    const taxAmount = subtotal * Number(estimate.taxRate || 0)
    const discount = Number(estimate.discount || 0)
    const total = subtotal - discount + taxAmount

    await prisma.estimate.update({
      where: { id: params.id },
      data: {
        subtotal,
        taxAmount,
        total,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Delete group error:', error)
    return NextResponse.json(
      {
        error: error?.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 }
    )
  }
}
