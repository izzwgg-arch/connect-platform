import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const creditMemo = await prisma.creditMemo.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
    })
    if (!creditMemo) {
      return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 })
    }
    if (Number(creditMemo.appliedAmount) > 0) {
      return NextResponse.json(
        { error: 'Cannot void a credit memo after it has been applied' },
        { status: 400 }
      )
    }
    if (creditMemo.status === 'VOID') {
      return NextResponse.json({ creditMemo })
    }

    const updated = await prisma.creditMemo.update({
      where: { id: creditMemo.id },
      data: {
        status: 'VOID',
        voidedAt: new Date(),
        remainingCredit: 0,
      },
    })

    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Credit memo ${creditMemo.creditMemoNumber} voided`,
        creditMemoId: creditMemo.id,
        clientId: creditMemo.clientId,
      },
    })

    return NextResponse.json({
      creditMemo: {
        ...updated,
        subtotal: Number(updated.subtotal),
        taxAmount: Number(updated.taxAmount || 0),
        total: Number(updated.total),
        appliedAmount: Number(updated.appliedAmount),
        remainingCredit: Number(updated.remainingCredit),
      },
    })
  } catch (error) {
    console.error('Void credit memo error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
