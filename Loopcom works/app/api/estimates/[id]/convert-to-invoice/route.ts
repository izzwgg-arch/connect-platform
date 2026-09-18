import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { solaService } from '@/lib/services/sola'
import crypto from 'crypto'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { calculateOrderedSubtotalRows } from '@/lib/documents/subtotals'
import {
  assertEstimateWillNotOverConvert,
  getEstimateConversionSummary,
} from '@/lib/documents/conversion'
import { toCents, fromCents, reconcileProgressLines } from '@/lib/documents/progress-billing'
import { allocateNextInvoiceNumber } from '@/lib/qbo/doc-numbers'
import { ensureJobFromInvoice } from '@/lib/jobs/ensure-job-from-invoice'
import { syncJobCostFromLinkedDocuments } from '@/lib/jobs/sync-job-cost'
import { createNotificationsForUsers } from '@/lib/notifications'

type BillingMode = 'FULL' | 'PERCENTAGE' | 'MANUAL'

type LineBillingMode = 'GLOBAL_PCT' | 'FULL' | 'CUSTOM_PCT' | 'CUSTOM_AMT'

type LineBillingInput = {
  lineItemId: string
  mode?: LineBillingMode
  percent?: number
  amount?: number
}


export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.convert')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const billingMode: BillingMode = body.billingMode || 'FULL'
    const percentage = Number(body.percentage || 0)
    const selectedLineItemIds: string[] = Array.isArray(body.selectedLineItemIds)
      ? body.selectedLineItemIds
      : []
    const lineBillingsRaw: LineBillingInput[] = Array.isArray(body.lineItemBillings) ? body.lineItemBillings : []
    const lineBillingById = new Map<string, LineBillingInput>()
    for (const row of lineBillingsRaw) {
      if (row && typeof row.lineItemId === 'string' && row.lineItemId) lineBillingById.set(row.lineItemId, row)
    }

    const estimate = await prisma.estimate.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        client: {
          include: {
            contacts: {
              where: { isPrimary: true },
              take: 1,
            },
          },
        },
        lineItems: {
          orderBy: { sortOrder: 'asc' },
        },
        optionalItems: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    // Fetch approvals so we can promote approved optional items to regular invoice line items
    const itemApprovals = await prisma.estimateItemApproval.findMany({
      where: { tenantId: user.tenantId, estimateId: params.id, status: 'APPROVED' },
      select: { estimateLineItemId: true },
    })
    const approvedOptionalItemIds = new Set(itemApprovals.map((a) => a.estimateLineItemId))
    // Split optional items: approved ones become regular invoice line items, pending stay optional
    const approvedOptionalItems = estimate.optionalItems.filter((opt) => approvedOptionalItemIds.has(opt.id))
    const pendingOptionalItems = estimate.optionalItems.filter((opt) => !approvedOptionalItemIds.has(opt.id))

    if (!estimate.clientId || !estimate.client) {
      return NextResponse.json(
        { error: 'Estimate must be linked to a client before converting to invoice.' },
        { status: 400 }
      )
    }

    const estimateTotalCents = toCents(Number(estimate.total))
    let invoiceLineItems: Array<{
      description: string
      quantity: number
      unitPrice: number
      unitCost: number | null
      total: number
      sortOrder: number
      isSubtotal?: boolean
      isVisibleToClient: boolean
      showDescriptionToCustomer: boolean
      showCostToCustomer: boolean
      showPriceToCustomer: boolean
      showTaxToCustomer: boolean
      showNotesToCustomer: boolean
      notes: string | null
      vendorId: string | null
      taxable: boolean
      taxRate: number | null
      sourceItemId: string | null
      sourceBundleId: string | null
    }> = []
    let subtotalCents = 0
    let progressPercent = 0

    if (billingMode === 'PERCENTAGE') {
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
        return NextResponse.json({ error: 'Percentage must be between 0 and 100.' }, { status: 400 })
      }
      progressPercent = percentage
      const defaultScale = percentage / 100
      // Include approved optional items alongside regular line items for billing
      const sourceLines = [...estimate.lineItems, ...approvedOptionalItems].sort((a, b) => a.sortOrder - b.sortOrder)
      let sortOrder = 0

      const pushLine = (row: (typeof invoiceLineItems)[0]) => {
        subtotalCents += toCents(row.total)
        invoiceLineItems.push({ ...row, sortOrder: sortOrder++ })
      }

      for (const line of sourceLines) {
        const isSubtotal = Boolean((line as any).isSubtotal)
        // Itemized percentage billing: only chargeable lines; skip subtotal rows to avoid double-counting amounts.
        if (isSubtotal) continue

        const qty = Number(line.quantity)
        const baseUnit = Number(line.unitPrice)
        const baseTotal = Number(line.total)
        const bill = lineBillingById.get(line.id)
        const mode: LineBillingMode = bill?.mode || 'GLOBAL_PCT'

        let lineTotalCents = 0
        let unitPriceOut = 0
        let qtyOut = qty

        if (mode === 'FULL') {
          lineTotalCents = toCents(baseTotal)
          unitPriceOut = qty ? baseTotal / qty : baseUnit
        } else if (mode === 'CUSTOM_AMT' && bill && Number.isFinite(bill.amount)) {
          lineTotalCents = toCents(Math.max(0, Number(bill.amount)))
          unitPriceOut = qty ? fromCents(lineTotalCents) / qty : fromCents(lineTotalCents)
        } else if (mode === 'CUSTOM_PCT' && bill && Number.isFinite(bill.percent)) {
          const p = Math.max(0, Math.min(100, Number(bill.percent)))
          const scaled = baseTotal * (p / 100)
          lineTotalCents = toCents(scaled)
          unitPriceOut = qty ? scaled / qty : scaled
        } else {
          const scaled = baseTotal * defaultScale
          lineTotalCents = toCents(scaled)
          unitPriceOut = qty ? scaled / qty : scaled
        }

        pushLine({
          description: line.description,
          quantity: qtyOut,
          unitPrice: Number(unitPriceOut.toFixed(4)),
          unitCost: line.unitCost ? Number(line.unitCost) : null,
          total: fromCents(lineTotalCents),
          sortOrder: 0,
          isVisibleToClient: line.isVisibleToClient !== false,
          showDescriptionToCustomer: (line as any).showDescriptionToCustomer ?? true,
          showCostToCustomer: line.showCostToCustomer,
          showPriceToCustomer: line.showPriceToCustomer,
          showTaxToCustomer: line.showTaxToCustomer,
          showNotesToCustomer: line.showNotesToCustomer,
          notes: line.notes || null,
          vendorId: isSubtotal ? null : (line.vendorId || null),
          taxable: isSubtotal ? false : line.taxable,
          taxRate: isSubtotal ? null : (line.taxRate ? Number(line.taxRate) : null),
          sourceItemId: line.sourceItemId || null,
          sourceBundleId: line.sourceBundleId || null,
        })
      }

      if (invoiceLineItems.length === 0) {
        return NextResponse.json({ error: 'No billable line items for this percentage invoice.' }, { status: 400 })
      }
    } else {
      // For FULL billing: include all regular lines + all approved optional items
      // For MANUAL billing: include selected regular lines + any approved optional items whose IDs are in selectedLineItemIds
      let sourceLines: any[]
      if (billingMode === 'MANUAL') {
        const regularSelected = estimate.lineItems.filter((li) => selectedLineItemIds.includes(li.id))
        const optionalSelected = approvedOptionalItems.filter((li) => selectedLineItemIds.includes(li.id))
        sourceLines = [...regularSelected, ...optionalSelected]
      } else {
        // FULL: all regular lines + all approved optional items
        sourceLines = [...estimate.lineItems, ...approvedOptionalItems]
      }

      if (sourceLines.length === 0) {
        return NextResponse.json({ error: 'No line items selected to bill.' }, { status: 400 })
      }

      invoiceLineItems = calculateOrderedSubtotalRows(sourceLines as any[]).map((line: any, idx) => {
        const isSubtotal = Boolean(line.isSubtotal)
        const lineTotal = isSubtotal ? line.calculatedSubtotalTotal : Number(line.total)
        if (!isSubtotal) subtotalCents += toCents(lineTotal)
        return {
          description: line.description,
          quantity: isSubtotal ? 0 : Number(line.quantity),
          unitPrice: isSubtotal ? 0 : Number(line.unitPrice),
          unitCost: isSubtotal ? null : (line.unitCost ? Number(line.unitCost) : null),
          total: lineTotal,
          sortOrder: idx,
          isSubtotal,
          isVisibleToClient: line.isVisibleToClient,
          showDescriptionToCustomer: (line as any).showDescriptionToCustomer ?? true,
          showCostToCustomer: line.showCostToCustomer,
          showPriceToCustomer: line.showPriceToCustomer,
          showTaxToCustomer: line.showTaxToCustomer,
          showNotesToCustomer: line.showNotesToCustomer,
          notes: line.notes || null,
          vendorId: line.vendorId || null,
          taxable: line.taxable,
          taxRate: line.taxRate ? Number(line.taxRate) : null,
          sourceItemId: line.sourceItemId || null,
          sourceBundleId: line.sourceBundleId || null,
        }
      })
    }

    const taxRate = Number(estimate.taxRate || 0)
    const taxAmountDraft = fromCents(Math.round(subtotalCents * taxRate))
    const totalDraft = fromCents(subtotalCents + toCents(taxAmountDraft))
    const discount = 0
    const paymentToken = crypto.randomBytes(20).toString('hex')

    let result: any = null
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const invoiceNumber = await allocateNextInvoiceNumber({ tenantId: user.tenantId })
        result = await prisma.$transaction(async (tx) => {
          // --- FINAL-INVOICE RECONCILIATION ---
          // For PERCENTAGE billing: individually-rounded line items can sum to slightly more
          // than estimateTotal × pct/100. When the cumulative invoiced amount would exceed
          // the estimate total, cap this invoice to the exact remaining amount and adjust
          // the last line item so that sum(lineItems) == subtotal == total - tax exactly.
          let finalSubtotalCents = subtotalCents
          let finalTaxAmount = taxAmountDraft
          let finalTotal = totalDraft
          let finalInvoiceLineItems = invoiceLineItems

          if (billingMode === 'PERCENTAGE') {
            const existingConv = await getEstimateConversionSummary(
              tx, estimate.id, estimate.total, user.tenantId
            )
            const estimateCents = Math.round(Number(estimate.total) * 100)
            const existingCents = Math.round(existingConv.invoicedTotal * 100)
            const maxAllowedCents = Math.max(0, estimateCents - existingCents)

            if (toCents(totalDraft) > maxAllowedCents) {
              const reconciled = reconcileProgressLines(
                invoiceLineItems,
                subtotalCents,
                taxRate,
                maxAllowedCents
              )
              finalInvoiceLineItems = reconciled.lineItems
              finalSubtotalCents = reconciled.subtotalCents
              finalTaxAmount = fromCents(reconciled.taxCents)
              finalTotal = fromCents(reconciled.totalCents)
            }
          }
          // --- END RECONCILIATION ---

          await assertEstimateWillNotOverConvert(tx, {
            estimateId: estimate.id,
            tenantId: user.tenantId,
            estimateTotal: estimate.total,
            newInvoiceTotal: finalTotal,
          })

          const finalSubtotal = fromCents(finalSubtotalCents)

          const invoice = await tx.invoice.create({
            data: {
              tenantId: user.tenantId,
              clientId: estimate.clientId!,
              estimateId: estimate.id,
              invoiceNumber,
              title: `${estimate.title} - ${billingMode === 'FULL' ? 'Full Billing' : billingMode === 'PERCENTAGE' ? `${percentage.toFixed(2)}% Billing` : 'Partial Billing'}`,
              status: 'DRAFT',
              subtotal: finalSubtotal,
              taxRate,
              taxAmount: finalTaxAmount,
              discount,
              total: finalTotal,
              originalTotalAtConversion: finalTotal,
              paidAmount: 0,
              balance: finalTotal,
              progressBillingMode: billingMode,
              progressBillingPercent: progressPercent || null,
              paymentToken,
              invoiceDate: new Date(),
              notes: estimate.notes || null,
              terms: estimate.terms || null,
            },
          })

          for (const line of finalInvoiceLineItems) {
            await tx.invoiceLineItem.create({
              data: {
                invoiceId: invoice.id,
                ...line,
              },
            })
          }

          // Copy only non-approved optional items (approved ones are already in invoiceLineItems above)
          if (pendingOptionalItems.length > 0) {
            for (let i = 0; i < pendingOptionalItems.length; i++) {
              const opt = pendingOptionalItems[i] as any
              await tx.invoiceOptionalLineItem.create({
                data: {
                  invoiceId: invoice.id,
                  // DocumentLineGroup ids are scoped to the source estimate; don't carry them over.
                  groupId: null,
                  description: opt.description,
                  quantity: opt.quantity,
                  unitPrice: opt.unitPrice,
                  unitCost: opt.unitCost || null,
                  total: opt.total,
                  sortOrder: opt.sortOrder ?? i,
                  isVisibleToClient: opt.isVisibleToClient !== false,
                  showDescriptionToCustomer: opt.showDescriptionToCustomer !== false,
                  showCostToCustomer: opt.showCostToCustomer !== undefined ? Boolean(opt.showCostToCustomer) : false,
                  showPriceToCustomer: opt.showPriceToCustomer !== undefined ? Boolean(opt.showPriceToCustomer) : true,
                  showTaxToCustomer: opt.showTaxToCustomer !== undefined ? Boolean(opt.showTaxToCustomer) : true,
                  showNotesToCustomer: opt.showNotesToCustomer !== undefined ? Boolean(opt.showNotesToCustomer) : false,
                  notes: opt.notes || null,
                  vendorId: opt.vendorId || null,
                  taxable: opt.taxable !== undefined ? Boolean(opt.taxable) : true,
                  taxRate: opt.taxRate || null,
                  sourceItemId: opt.sourceItemId || null,
                  sourceBundleId: opt.sourceBundleId || null,
                },
              })
            }
          }

          await tx.activity.create({
            data: {
              tenantId: user.tenantId,
              userId: user.id,
              type: 'INVOICE_CREATED',
              description: `Estimate "${estimate.estimateNumber}" converted to invoice ${invoiceNumber} (${billingMode})`,
              clientId: estimate.clientId!,
              estimateId: estimate.id,
              invoiceId: invoice.id,
            },
          })

          const conversion = await getEstimateConversionSummary(tx, estimate.id, estimate.total, user.tenantId)
          await tx.estimate.update({
            where: { id: estimate.id },
            data: { status: 'CONVERTED', convertedPercent: conversion.convertedPercent },
          })

          return invoice
        }, { isolationLevel: 'Serializable' })
        break
      } catch (err: any) {
        if (err?.code === 'P2002' && err?.meta?.target?.includes?.('invoiceNumber')) {
          continue
        }
        throw err
      }
    }
    if (!result) {
      return NextResponse.json({ error: 'Unable to allocate a new invoice number. Please retry.' }, { status: 409 })
    }

    // Generate payment link immediately and store URL/transaction id
    try {
      const solaSecrets = await getIntegrationSecrets(user.tenantId, 'sola')
      if (!solaSecrets?.secretKey) {
        throw new Error('Sola integration is not configured (missing secret key).')
      }
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.PUBLIC_APP_URL ||
        process.env.APP_URL ||
        'https://app.trimprony.com'
      const link = await solaService.createPaymentLink({
        invoiceId: result.id,
        amount: Number(result.balance),
        description: `Invoice ${result.invoiceNumber} - ${result.title}`,
        clientEmail: estimate.client.email || estimate.client.contacts?.[0]?.email || undefined,
        clientName: estimate.client.name,
        returnUrl: `${appUrl}/portal/pay/${result.id}?token=${result.paymentToken}`,
        webhookUrl: `${appUrl}/api/webhooks/sola-payment`,
        apiKey: solaSecrets.secretKey,
      })

      await prisma.invoice.update({
        where: { id: result.id },
        data: {
          solaPaymentUrl: link.url || null,
          solaTransactionId: link.id || null,
        },
      })
    } catch (error) {
      console.error('Failed to pre-generate SOLA payment link for converted invoice:', error)
    }

    try {
      await enqueueQboSync(user.tenantId, 'invoice', result.id)
    } catch (error) {
      console.error('QuickBooks invoice sync trigger error (estimate convert):', error)
    }

    // Push estimate status Closed (CONVERTED) and keep invoice LinkedTxn to this estimate.
    try {
      await enqueueQboSync(user.tenantId, 'estimate', estimate.id, { processImmediately: false })
    } catch (error) {
      console.error('QuickBooks estimate sync trigger error (estimate convert):', error)
    }

    // Create the job immediately upon estimate→invoice conversion (not on payment).
    let jobIdForCost: string | null = estimate.jobId || null
    try {
      const { job, created } = await ensureJobFromInvoice(result.id)
      if (job?.id) jobIdForCost = job.id

      if (created && job) {
        // Notify staff that a new job has been created.
        const users = await prisma.user.findMany({
          where: {
            tenantId: user.tenantId,
            role: { in: ['ADMIN', 'ACCOUNTING', 'OFFICE', 'MANAGER'] },
            status: 'ACTIVE',
          },
          select: { id: true },
        })
        if (users.length > 0) {
          const clientName = estimate.client?.name || 'Unknown Client'
          const jobTitle = job.title || `Job ${job.jobNumber}`
          await createNotificationsForUsers(
            user.tenantId,
            users.map((u) => u.id),
            {
              type: 'SYSTEM',
              title: 'Job Created From Estimate Conversion',
              message: `Estimate converted to invoice ${result.invoiceNumber} (${clientName}). Job "${jobTitle}" has been automatically created.`,
              linkUrl: `/dashboard/jobs/${job.id}`,
              linkType: 'job',
              linkId: job.id,
              requiresAck: false,
            }
          )
        }

        // Job → QBO project/subcustomer sync is disabled.
      }
    } catch (jobErr) {
      // Job creation failure must not roll back the invoice — log and continue.
      console.error('Failed to auto-create job from estimate conversion:', jobErr)
    }

    if (jobIdForCost) {
      try {
        await syncJobCostFromLinkedDocuments(jobIdForCost)
      } catch (syncErr) {
        console.error('Failed to sync job cost after estimate convert-to-invoice:', syncErr)
      }
    }

    return NextResponse.json({ invoice: result }, { status: 201 })
  } catch (error: any) {
    console.error('Convert estimate to invoice error:', error)
    if (String(error?.message || '').includes('cannot exceed 100%')) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

