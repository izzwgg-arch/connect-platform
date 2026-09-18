import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { computeCreditMemoTotals } from '@/lib/credit-memos/apply-credit'

function serializeCreditMemo(cm: any) {
  return {
    ...cm,
    subtotal: Number(cm.subtotal),
    taxRate: cm.taxRate != null ? Number(cm.taxRate) : 0,
    taxAmount: cm.taxAmount != null ? Number(cm.taxAmount) : 0,
    total: Number(cm.total),
    appliedAmount: Number(cm.appliedAmount),
    remainingCredit: Number(cm.remainingCredit),
    lineItems: Array.isArray(cm.lineItems)
      ? cm.lineItems.map((li: any) => ({
          ...li,
          quantity: Number(li.quantity),
          unitPrice: Number(li.unitPrice),
          total: Number(li.total),
        }))
      : [],
    applications: Array.isArray(cm.applications)
      ? cm.applications.map((a: any) => ({
          ...a,
          amount: Number(a.amount),
        }))
      : [],
  }
}

const detailInclude = {
  client: {
    select: {
      id: true,
      name: true,
      companyName: true,
      email: true,
      phone: true,
      contacts: { where: { isPrimary: true }, take: 1 },
    },
  },
  job: { select: { id: true, jobNumber: true, title: true } },
  sourceInvoice: { select: { id: true, invoiceNumber: true, balance: true, status: true } },
  lineItems: { orderBy: { sortOrder: 'asc' as const } },
  applications: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      invoice: { select: { id: true, invoiceNumber: true } },
      payment: { select: { id: true, amount: true, method: true } },
    },
  },
  activities: {
    orderBy: { createdAt: 'desc' as const },
    take: 20,
    include: { user: { select: { firstName: true, lastName: true } } },
  },
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const creditMemo = await prisma.creditMemo.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      include: detailInclude,
    })
    if (!creditMemo) {
      return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 })
    }
    return NextResponse.json({ creditMemo: serializeCreditMemo(creditMemo) })
  } catch (error) {
    console.error('Get credit memo error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const existing = await prisma.creditMemo.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 })
    }
    if (existing.status === 'VOID') {
      return NextResponse.json({ error: 'Cannot edit a voided credit memo' }, { status: 400 })
    }
    if (Number(existing.appliedAmount) > 0) {
      return NextResponse.json(
        { error: 'Cannot edit a credit memo after it has been applied' },
        { status: 400 }
      )
    }

    const body = await request.json()
    const { title, notes, memo, taxRate, lineItems, jobId, creditMemoDate } = body || {}

    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return NextResponse.json({ error: 'At least one line item is required' }, { status: 400 })
    }

    const normalizedLines = lineItems.map((li: any, index: number) => {
      const quantity = Number(li.quantity || 0)
      const unitPrice = Number(li.unitPrice || 0)
      return {
        description: String(li.description || '').trim() || 'Credit',
        quantity,
        unitPrice,
        total: Math.round(quantity * unitPrice * 100) / 100,
        sortOrder: index,
        notes: li.notes || null,
        taxable: li.taxable !== false,
      }
    })

    const totals = computeCreditMemoTotals(
      normalizedLines,
      taxRate != null ? Number(taxRate) : Number(existing.taxRate || 0)
    )

    await prisma.creditMemoLineItem.deleteMany({ where: { creditMemoId: existing.id } })

    const updated = await prisma.creditMemo.update({
      where: { id: existing.id },
      data: {
        title: title != null ? String(title).trim() || 'Credit Memo' : undefined,
        notes: notes !== undefined ? notes || null : undefined,
        memo: memo !== undefined ? memo || null : undefined,
        jobId: jobId !== undefined ? jobId || null : undefined,
        creditMemoDate: creditMemoDate ? new Date(creditMemoDate) : undefined,
        taxRate: taxRate != null ? Number(taxRate) : undefined,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        total: totals.total,
        remainingCredit: totals.remainingCredit,
        appliedAmount: 0,
        lineItems: {
          create: normalizedLines.map(({ taxable, ...rest }) => rest),
        },
      },
      include: detailInclude,
    })

    try {
      await enqueueQboSync(user.tenantId, 'credit_memo', updated.id)
    } catch (e) {
      console.error('QBO credit memo sync trigger error (update):', e)
    }

    return NextResponse.json({ creditMemo: serializeCreditMemo(updated) })
  } catch (error: any) {
    console.error('Update credit memo error:', error)
    return NextResponse.json(
      { error: error?.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
