import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getOrCreateEstimateApprovalToken, revokeAndRotateEstimateApprovalToken } from '@/lib/estimate-approval'

const postSchema = z.object({
  action: z.enum(['regenerate']).optional(),
})

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const estimate = await prisma.estimate.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      select: {
        id: true,
        tenantId: true,
        estimateNumber: true,
        clientId: true,
        createdAt: true,
      },
    })
    if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })

    const token = await getOrCreateEstimateApprovalToken({ tenantId: user.tenantId, estimateId: estimate.id })

    const approvals = await prisma.estimateItemApproval.findMany({
      where: { tenantId: user.tenantId, estimateId: estimate.id, status: 'APPROVED' },
      orderBy: { approvedAt: 'desc' },
    })

    const lineItems = await prisma.estimateLineItem.findMany({
      where: { estimateId: estimate.id },
      select: { id: true, description: true, quantity: true, unitPrice: true, total: true },
    })
    // Also look up optional items so approvals on add-ons show their descriptions
    const optionalLineItems = await prisma.estimateOptionalLineItem.findMany({
      where: { estimateId: estimate.id },
      select: { id: true, description: true, quantity: true, unitPrice: true, total: true },
    })
    const itemMap = new Map([
      ...lineItems.map((li) => [li.id, { ...li, isOptional: false }] as const),
      ...optionalLineItems.map((li) => [li.id, { ...li, isOptional: true }] as const),
    ])

    const sources = await prisma.invoiceLineItemSource.findMany({
      where: { tenantId: user.tenantId, estimateId: estimate.id },
      orderBy: { createdAt: 'desc' },
    })
    const invoiceIds = Array.from(new Set(sources.map((s) => s.invoiceId)))
    const invoices = await prisma.invoice.findMany({
      where: { id: { in: invoiceIds }, tenantId: user.tenantId },
      select: { id: true, invoiceNumber: true, status: true, total: true, createdAt: true },
    })
    const invMap = new Map(invoices.map((i) => [i.id, i]))

    return NextResponse.json({
      approveUrl: token.url,
      expiresAt: token.expiresAt,
      approvals: approvals.map((a) => ({
        ...a,
        item: itemMap.get(a.estimateLineItemId) || null,
        isOptionalItem: optionalLineItems.some((li) => li.id === a.estimateLineItemId),
      })),
      invoiceHistory: sources.map((s) => ({
        ...s,
        invoice: invMap.get(s.invoiceId) || null,
      })),
    })
  } catch (error) {
    console.error('Get estimate approvals error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const estimate = await prisma.estimate.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      select: { id: true },
    })
    if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })

    if (parsed.data.action === 'regenerate') {
      const token = await revokeAndRotateEstimateApprovalToken({ tenantId: user.tenantId, estimateId: estimate.id })
      return NextResponse.json({ approveUrl: token.url, expiresAt: token.expiresAt })
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
  } catch (error) {
    console.error('Update estimate approvals error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

