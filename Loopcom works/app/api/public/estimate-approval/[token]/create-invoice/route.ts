import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { rateLimitOrThrow } from '@/lib/security/rate-limit'
import { hashApprovalToken } from '@/lib/estimate-approval'
import { allocateNextInvoiceNumber, normalizeInvoiceNumber } from '@/lib/qbo/doc-numbers'
import { getEstimateConversionSummary } from '@/lib/documents/conversion'

export const runtime = 'nodejs'

const paramsSchema = z.object({
  token: z.string().trim().min(20),
})

function toNumber(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function POST(request: NextRequest, ctx: { params: { token: string } }) {
  try {
    rateLimitOrThrow(request, { key: 'public-estimate-approval:create-invoice', limit: 10, windowMs: 60_000 })

    const parsedParams = paramsSchema.safeParse(ctx.params)
    if (!parsedParams.success) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const tokenHash = hashApprovalToken(parsedParams.data.token)
    const now = new Date()
    const tokenRow = await prisma.estimateApprovalToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { tenantId: true, estimateId: true },
    })
    if (!tokenRow) {
      return NextResponse.json({ error: 'Approval link is invalid or expired.' }, { status: 404 })
    }

    const approvals = await prisma.estimateItemApproval.findMany({
      where: {
        tenantId: tokenRow.tenantId,
        estimateId: tokenRow.estimateId,
        status: 'APPROVED',
      },
      select: { estimateLineItemId: true },
    })
    const approvedIds = approvals.map((a) => a.estimateLineItemId)
    if (approvedIds.length === 0) {
      return NextResponse.json({ error: 'No approved items to invoice yet.' }, { status: 400 })
    }

    const alreadyInvoiced = await prisma.invoiceLineItemSource.findMany({
      where: { tenantId: tokenRow.tenantId, estimateId: tokenRow.estimateId, estimateLineItemId: { in: approvedIds } },
      select: { estimateLineItemId: true },
    })
    const invoicedSet = new Set(alreadyInvoiced.map((s) => s.estimateLineItemId))
    const toInvoiceIds = approvedIds.filter((id) => !invoicedSet.has(id))

    if (toInvoiceIds.length === 0) {
      return NextResponse.json({ error: 'No new approved items to invoice.' }, { status: 400 })
    }

    // Idempotency key derived from tokenHash + specific set of items being invoiced.
    const itemsKey = crypto.createHash('sha256').update(toInvoiceIds.slice().sort().join(',')).digest('hex')
    const idemKey = `ESTAPPINV:${tokenHash}:${itemsKey}`

    const existingIdem = await prisma.idempotencyKey.findFirst({
      where: { key: idemKey, scope: 'public-estimate-approval-invoice' },
      select: { response: true },
    })
    const existingInvoiceId = (existingIdem?.response as any)?.invoiceId as string | undefined
    if (existingInvoiceId) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: existingInvoiceId, tenantId: tokenRow.tenantId },
        select: { id: true, invoiceNumber: true, paymentToken: true },
      })
      if (invoice) {
        return NextResponse.json({
          ok: true,
          invoice: {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            portalPayUrl: `https://app.trimprony.com/portal/pay/${invoice.id}?token=${invoice.paymentToken}`,
          },
          idempotent: true,
        })
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findFirst({
        where: { id: tokenRow.estimateId, tenantId: tokenRow.tenantId },
        include: {
          client: true,
          lineItems: { orderBy: { sortOrder: 'asc' } },
        },
      })
      if (!estimate?.clientId) throw new Error('Estimate missing client')

      const lineItemsToInvoice = estimate.lineItems.filter((li) => toInvoiceIds.includes(li.id))
      if (lineItemsToInvoice.length === 0) throw new Error('No items to invoice')

      // Preserve exact qty/unitPrice from estimate line items.
      const subtotal = lineItemsToInvoice.reduce((sum, li) => sum + toNumber(li.quantity) * toNumber(li.unitPrice), 0)

      // If we are invoicing ALL estimate items, carry over discount/tax exactly.
      const isAllApproved =
        estimate.lineItems.filter((li) => li.isVisibleToClient !== false).length === approvedIds.length &&
        toInvoiceIds.length === approvedIds.length

      const discountAmount = isAllApproved ? toNumber(estimate.discount) : 0
      const taxRateValue = toNumber(estimate.taxRate)
      const subtotalAfterDiscount = subtotal - discountAmount
      const tax = subtotalAfterDiscount * taxRateValue
      const total = subtotalAfterDiscount + tax

      const invoiceNumber = await allocateNextInvoiceNumber({ tenantId: tokenRow.tenantId, db: tx })

      const invoice = await tx.invoice.create({
        data: {
          tenantId: tokenRow.tenantId,
          clientId: estimate.clientId,
          jobId: estimate.jobId || null,
          estimateId: estimate.id,
          invoiceNumber: normalizeInvoiceNumber(invoiceNumber) || invoiceNumber,
          title: `Invoice from approved items (${estimate.estimateNumber})`,
          status: 'DRAFT',
          subtotal,
          taxRate: taxRateValue,
          taxAmount: tax,
          discount: discountAmount,
          total,
          originalTotalAtConversion: total,
          balance: total,
          paidAmount: 0,
          invoiceDate: new Date(),
          dueDate: null,
          notes: null,
          terms: estimate.terms || null,
          memo: null,
          paymentToken: crypto.randomBytes(20).toString('hex'),
          qboAchEnabled: true,
        } as any,
        select: { id: true, invoiceNumber: true, paymentToken: true },
      })

      // Preserve group headers/bundles where possible by cloning estimate groups.
      const estimateGroups = await tx.documentLineGroup.findMany({
        where: {
          tenantId: tokenRow.tenantId,
          documentType: 'ESTIMATE',
          documentId: estimate.id,
        },
        select: { id: true, name: true, sourceBundleId: true, sourceBundleName: true },
      })
      const groupIdMap = new Map<string, string>()
      for (const g of estimateGroups) {
        const created = await tx.documentLineGroup.create({
          data: {
            tenantId: tokenRow.tenantId,
            documentType: 'INVOICE',
            documentId: invoice.id,
            name: g.name,
            sourceBundleId: g.sourceBundleId,
            sourceBundleName: g.sourceBundleName,
          },
          select: { id: true },
        })
        groupIdMap.set(g.id, created.id)
      }

      for (let i = 0; i < lineItemsToInvoice.length; i++) {
        const li = lineItemsToInvoice[i]
        const qty = toNumber(li.quantity)
        const unitPrice = toNumber(li.unitPrice)
        const itemTotal = qty * unitPrice
        const mappedGroupId = li.groupId ? groupIdMap.get(li.groupId) || null : null

        await tx.invoiceLineItem.create({
          data: {
            invoiceId: invoice.id,
            groupId: mappedGroupId,
            description: li.description,
            quantity: qty,
            unitPrice,
            unitCost: li.unitCost,
            total: itemTotal,
            sortOrder: i,
            isVisibleToClient: li.isVisibleToClient !== false,
            showDescriptionToCustomer: li.showDescriptionToCustomer ?? true,
            showCostToCustomer: li.showCostToCustomer ?? false,
            showPriceToCustomer: li.showPriceToCustomer ?? true,
            showTaxToCustomer: li.showTaxToCustomer ?? true,
            showNotesToCustomer: li.showNotesToCustomer ?? false,
            vendorId: li.vendorId || null,
            taxable: li.taxable ?? true,
            taxRate: li.taxRate,
            notes: li.notes || null,
            sourceItemId: li.sourceItemId || null,
            sourceBundleId: li.sourceBundleId || null,
          } as any,
        })
      }

      await tx.invoiceLineItemSource.createMany({
        data: toInvoiceIds.map((estimateLineItemId) => ({
          tenantId: tokenRow.tenantId,
          invoiceId: invoice.id,
          estimateId: estimate.id,
          estimateLineItemId,
        })),
        skipDuplicates: true,
      })

      await tx.idempotencyKey.create({
        data: {
          tenantId: tokenRow.tenantId,
          key: idemKey,
          scope: 'public-estimate-approval-invoice',
          response: { invoiceId: invoice.id },
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
        },
      })

      // Every path that creates an invoice from an estimate must keep the
      // estimate's converted-% tracking up to date — see approve/route.ts.
      const conversion = await getEstimateConversionSummary(tx, estimate.id, estimate.total, tokenRow.tenantId)
      await tx.estimate.update({
        where: { id: estimate.id },
        data: { status: 'CONVERTED', convertedPercent: conversion.convertedPercent },
      })

      return invoice
    })

    return NextResponse.json({
      ok: true,
      invoice: {
        id: result.id,
        invoiceNumber: result.invoiceNumber,
        portalPayUrl: `https://app.trimprony.com/portal/pay/${result.id}?token=${result.paymentToken}`,
      },
      invoicedLineItemIds: toInvoiceIds,
    })
  } catch (err: any) {
    if (err instanceof NextResponse) return err
    if (err?.status === 429) return err
    console.error('Public estimate approval create-invoice error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

