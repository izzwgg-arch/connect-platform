import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { rateLimitOrThrow } from '@/lib/security/rate-limit'
import { hashApprovalToken } from '@/lib/estimate-approval'
import { buildCustomerFacingApprovalItems } from '@/lib/estimates/customer-approval-view'

export const runtime = 'nodejs'

const paramsSchema = z.object({
  token: z.string().trim().min(20),
})

export async function GET(request: NextRequest, ctx: { params: { token: string } }) {
  try {
    rateLimitOrThrow(request, { key: 'public-estimate-approval:get', limit: 60, windowMs: 60_000 })

    const parsed = paramsSchema.safeParse(ctx.params)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const tokenHash = hashApprovalToken(parsed.data.token)
    const now = new Date()
    const tokenRow = await prisma.estimateApprovalToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, tenantId: true, estimateId: true, expiresAt: true },
    })
    if (!tokenRow) {
      return NextResponse.json({ error: 'Approval link is invalid or expired.' }, { status: 404 })
    }

    await prisma.estimateApprovalToken.update({
      where: { id: tokenRow.id },
      data: { lastViewedAt: now },
    })

    const estimate = await prisma.estimate.findFirst({
      where: { id: tokenRow.estimateId, tenantId: tokenRow.tenantId },
      include: {
        client: { select: { id: true, name: true, companyName: true } },
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: { group: true },
        },
        optionalItems: { orderBy: { sortOrder: 'asc' } },
      },
    })
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const approvals = await prisma.estimateItemApproval.findMany({
      where: {
        tenantId: tokenRow.tenantId,
        estimateId: estimate.id,
      },
      select: {
        estimateLineItemId: true,
        status: true,
        approvedAt: true,
        approvedByName: true,
      },
    })
    const approvedMap = new Map(
      approvals
        .filter((a) => a.status === 'APPROVED')
        .map((a) => [a.estimateLineItemId, a])
    )

    const sources = await prisma.invoiceLineItemSource.findMany({
      where: {
        tenantId: tokenRow.tenantId,
        estimateId: estimate.id,
      },
      select: { estimateLineItemId: true, invoiceId: true, createdAt: true },
    })
    const invoicedMap = new Map<string, { invoiceId: string; createdAt: Date }>()
    for (const s of sources) {
      if (!invoicedMap.has(s.estimateLineItemId)) {
        invoicedMap.set(s.estimateLineItemId, { invoiceId: s.invoiceId, createdAt: s.createdAt })
      }
    }

    const { viewMode, items: customerFacingItems } = buildCustomerFacingApprovalItems(
      estimate.lineItems as any[]
    )

    const allVisibleOptionalItems = (estimate.optionalItems || []).filter(
      (li) => li.isVisibleToClient !== false
    )
    const pendingOptionalItems = allVisibleOptionalItems.filter((li) => !approvedMap.has(li.id))
    const approvedOptionalItems = allVisibleOptionalItems.filter((li) => approvedMap.has(li.id))

    const decorate = (
      row: {
        id: string
        description: string
        notes: string
        quantity: string
        unitPrice: string
        unitCost: string | null
        total: string
        showPriceToCustomer: boolean
        sourceLineItemIds: string[]
        isCustomerBundle: boolean
        isSubtotal: boolean
      },
      isOptional: boolean
    ) => {
      const sources = row.sourceLineItemIds.length ? row.sourceLineItemIds : [row.id]
      const approvalsForRow = sources.map((id) => approvedMap.get(id) || null)
      const approved = sources.length > 0 && approvalsForRow.every((a) => Boolean(a))
      const firstApproval = approvalsForRow.find(Boolean) || null
      const invoiced = sources.length > 0 && sources.every((id) => invoicedMap.has(id))
      const firstInvoiced = sources.map((id) => invoicedMap.get(id)).find(Boolean) || null
      return {
        id: row.id,
        description: row.description,
        notes: row.notes,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        unitCost: row.unitCost,
        total: row.total,
        showPriceToCustomer: row.showPriceToCustomer,
        sourceLineItemIds: row.sourceLineItemIds,
        isCustomerBundle: row.isCustomerBundle,
        isOptional,
        isSubtotal: row.isSubtotal,
        approved,
        approvedAt: firstApproval?.approvedAt || null,
        approvedByName: firstApproval?.approvedByName || null,
        invoiced,
        invoicedAt: firstInvoiced?.createdAt || null,
      }
    }

    const optionalRow = (li: (typeof allVisibleOptionalItems)[0]) => ({
      id: li.id,
      description: li.showDescriptionToCustomer !== false ? li.description : '',
      notes: li.showNotesToCustomer !== false ? li.notes || '' : '',
      quantity: String(li.quantity),
      unitPrice: li.showPriceToCustomer !== false ? String(li.unitPrice) : '0',
      unitCost: li.showCostToCustomer === true ? (li.unitCost ? String(li.unitCost) : null) : null,
      total: String(li.total),
      showPriceToCustomer: li.showPriceToCustomer !== false,
      sourceLineItemIds: [li.id],
      isCustomerBundle: false,
      isSubtotal: false,
    })

    // Approved optional add-ons appear in the main Items list (same as before).
    const mainItems = [
      ...customerFacingItems.map((row) => decorate(row, false)),
      ...approvedOptionalItems.map((li) => decorate(optionalRow(li), true)),
    ]

    return NextResponse.json({
      estimate: {
        id: estimate.id,
        estimateNumber: estimate.estimateNumber,
        title: estimate.title,
        createdAt: estimate.createdAt,
        jobSiteAddress: estimate.jobSiteAddress,
        client: estimate.client ? { name: estimate.client.companyName || estimate.client.name } : null,
        expiresAt: tokenRow.expiresAt,
      },
      viewMode,
      items: mainItems,
      optionalItems: pendingOptionalItems.map((li) => decorate(optionalRow(li), true)),
    })
  } catch (err: any) {
    if (err instanceof NextResponse) return err
    if (err?.status === 429) return err
    console.error('Public estimate approval GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
