import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { rateLimitOrThrow } from '@/lib/security/rate-limit'
import { hashApprovalToken } from '@/lib/estimate-approval'
import { expandApprovalSelectionToLineItemIds } from '@/lib/estimates/customer-approval-view'
import { createNotificationsForUsers } from '@/lib/notifications'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { getEstimateConversionSummary } from '@/lib/documents/conversion'
import { allocateNextInvoiceNumber } from '@/lib/qbo/doc-numbers'
import { syncJobCostFromLinkedDocuments } from '@/lib/jobs/sync-job-cost'
import { toCents, fromCents, reconcileEstimateConversionLineItems } from '@/lib/documents/progress-billing'
import { sendInvoiceEmailForInvoice } from '@/lib/invoices/send-invoice-email'

export const runtime = 'nodejs'

const paramsSchema = z.object({
  token: z.string().trim().min(20),
})

const bodySchema = z.object({
  approveAll: z.boolean().optional(),
  selectedLineItemIds: z.array(z.string().trim().min(1)).optional(),
  signerName: z.string().trim().min(2, 'Signer name is required'),
  signerEmail: z.string().trim().email().optional(),
  eSign: z.boolean().optional(),
})

function getAppUrl(): string {
  return (
    String(process.env.NEXT_PUBLIC_APP_URL || '').trim() ||
    'https://app.trimprony.com'
  ).replace(/\/$/, '')
}

function toNumber(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function POST(request: NextRequest, ctx: { params: { token: string } }) {
  try {
    rateLimitOrThrow(request, { key: 'public-estimate-approval:approve', limit: 20, windowMs: 60_000 })

    const parsedParams = paramsSchema.safeParse(ctx.params)
    if (!parsedParams.success) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const rawBody = await request.text().catch(() => '')
    let bodyJson: any = null
    try {
      bodyJson = rawBody ? JSON.parse(rawBody) : null
    } catch {
      bodyJson = null
    }
    const parsedBody = bodySchema.safeParse(bodyJson)
    if (!parsedBody.success) {
      return NextResponse.json({ error: parsedBody.error.flatten() }, { status: 400 })
    }

    if (parsedBody.data.eSign === false) {
      return NextResponse.json({ error: 'You must confirm you approve this estimate.' }, { status: 400 })
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

    const estimate = await prisma.estimate.findFirst({
      where: { id: tokenRow.estimateId, tenantId: tokenRow.tenantId },
      include: {
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: { group: true },
        },
        optionalItems: { orderBy: { sortOrder: 'asc' } },
        client: { select: { name: true, companyName: true } },
      },
    })
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const visibleLineItemIds = estimate.lineItems
      .filter((li) => li.isVisibleToClient !== false)
      .map((li) => li.id)

    const visibleOptionalItemIds = (estimate.optionalItems || [])
      .filter((li) => li.isVisibleToClient !== false)
      .map((li) => li.id)

    const allVisibleIds = [...visibleLineItemIds, ...visibleOptionalItemIds]

    const approveAll = Boolean(parsedBody.data.approveAll)
    // Customer UI may send Line # / group ids; expand those to underlying company line items.
    const selectedRaw = approveAll
      ? allVisibleIds
      : expandApprovalSelectionToLineItemIds(
          parsedBody.data.selectedLineItemIds || [],
          estimate.lineItems as any[],
          (estimate.optionalItems || []) as any[]
        )
    const normalizedSelected = Array.from(
      new Set(selectedRaw.map((s) => String(s).trim()).filter(Boolean))
    )

    if (normalizedSelected.length === 0) {
      return NextResponse.json({ error: 'Select at least one item to approve.' }, { status: 400 })
    }

    const visibleSet = new Set(allVisibleIds)
    const invalid = normalizedSelected.filter((id) => !visibleSet.has(id))
    if (invalid.length) {
      return NextResponse.json({ error: 'Invalid line item selection.' }, { status: 400 })
    }

    const approvedIds: string[] = []

    await prisma.$transaction(async (tx) => {
      for (const estimateLineItemId of normalizedSelected) {
        const existing = await tx.estimateItemApproval.findUnique({
          where: {
            tenantId_estimateId_estimateLineItemId: {
              tenantId: tokenRow.tenantId,
              estimateId: estimate.id,
              estimateLineItemId,
            },
          },
        })

        if (existing && existing.status === 'APPROVED') {
          approvedIds.push(estimateLineItemId)
          continue
        }

        await tx.estimateItemApproval.upsert({
          where: {
            tenantId_estimateId_estimateLineItemId: {
              tenantId: tokenRow.tenantId,
              estimateId: estimate.id,
              estimateLineItemId,
            },
          },
          create: {
            tenantId: tokenRow.tenantId,
            estimateId: estimate.id,
            estimateLineItemId,
            status: 'APPROVED',
            approvedAt: now,
            approvedByName: parsedBody.data.signerName,
            approvedByEmail: parsedBody.data.signerEmail || null,
          },
          update: {
            status: 'APPROVED',
            approvedAt: now,
            revokedAt: null,
            approvedByName: parsedBody.data.signerName,
            approvedByEmail: parsedBody.data.signerEmail || null,
          },
        })

        approvedIds.push(estimateLineItemId)
      }
    })

    // --- Auto-create job + 50% invoice for this approval batch ---
    let autoCreatedJob: any = null
    let autoCreatedInvoice: any = null
    let paymentUrl: string | null = null

    if (approvedIds.length > 0 && estimate.clientId) {
      // Auto-create job if not already linked
      try {
        if (!estimate.jobId) {
          autoCreatedJob = await prisma.$transaction(async (tx) => {
            const jobCount = await tx.job.count({ where: { tenantId: tokenRow.tenantId } })
            const jobNumber = `JOB-${String(jobCount + 1).padStart(6, '0')}`
            const job = await tx.job.create({
              data: {
                tenantId: tokenRow.tenantId,
                clientId: estimate.clientId!,
                jobNumber,
                title: estimate.title,
                description: estimate.notes || null,
                status: 'QUOTE',
                priority: 3,
                estimateAmount: estimate.total,
              },
            })

            const addr = estimate.jobSiteAddress ? String(estimate.jobSiteAddress).trim() : null
            if (addr) {
              const parts = addr.split(',').map((p: string) => p.trim()).filter(Boolean)
              const street = parts[0] || addr
              const city = parts[1] || ''
              const stateZip = parts[2] || ''
              const m = stateZip.match(/^([A-Za-z]{2})\s+(.+)$/)
              await tx.address.create({
                data: {
                  jobId: job.id,
                  type: 'job_site',
                  street,
                  city,
                  state: m ? m[1] : stateZip,
                  zipCode: m ? m[2] : '',
                  country: 'US',
                },
              })
            }

            await tx.estimate.update({
              where: { id: estimate.id },
              data: { jobId: job.id },
            })

            return job
          })
        }
      } catch (jobErr) {
        console.error('Failed to auto-create job from approval:', jobErr)
      }

      // Auto-create an invoice for the approved work, billed at the estimate's
      // configured deposit/billing percentage — same "PERCENTAGE billing mode"
      // convention as the staff-facing "convert estimate to invoice" flow
      // (app/api/invoices/route.ts), so titles/fields stay consistent.
      const depositPct = (() => {
        const raw = Number((estimate as any).depositPercent)
        if (!Number.isFinite(raw) || raw <= 0 || raw > 100) return 50
        return raw
      })()
      const selectedForThisApproval = Array.from(new Set(normalizedSelected))
      const alreadyInvoiced = await prisma.invoiceLineItemSource.findMany({
        where: {
          tenantId: tokenRow.tenantId,
          estimateId: estimate.id,
          estimateLineItemId: { in: selectedForThisApproval },
        },
        select: { estimateLineItemId: true },
      })
      const alreadyInvoicedSet = new Set(alreadyInvoiced.map((row) => row.estimateLineItemId))
      const toInvoiceIds = selectedForThisApproval.filter((id) => !alreadyInvoicedSet.has(id))
      const approvedIdSet = new Set(toInvoiceIds)
      const approvedRegularItems = estimate.lineItems.filter(
        (li) => li.isVisibleToClient !== false && approvedIdSet.has(li.id)
      )
      const approvedOptionalItems = (estimate.optionalItems || []).filter(
        (li) => li.isVisibleToClient !== false && approvedIdSet.has(li.id)
      )
      const allApprovedItems = [...approvedRegularItems, ...approvedOptionalItems]

      if (allApprovedItems.length > 0) {
        try {
          autoCreatedInvoice = await prisma.$transaction(async (tx) => {
            const invoiceNumber = await allocateNextInvoiceNumber({ tenantId: tokenRow.tenantId, db: tx })
            const taxRate = Number(estimate.taxRate || 0)
            const isFullBilling = depositPct >= 99.995

            // Scale each approved line item down to the billing percentage.
            const scale = depositPct / 100
            const scaledDrafts = allApprovedItems.map((li) => {
              const fullUnitPrice = toNumber(li.unitPrice)
              const qty = toNumber(li.quantity || 1)
              const baseTotal = fullUnitPrice * qty
              const scaledTotal = baseTotal * scale
              const unitPrice = qty > 0 ? Number((scaledTotal / qty).toFixed(4)) : Number(scaledTotal.toFixed(4))
              return { li, quantity: qty, unitPrice }
            })

            // Cap against whatever headroom is left on the estimate (defends
            // against rounding drift and items already invoiced by other means
            // between approval batches) — same guard the staff conversion flow uses.
            const conversionBefore = await getEstimateConversionSummary(tx, estimate.id, estimate.total, tokenRow.tenantId)
            const reconciled = reconcileEstimateConversionLineItems(scaledDrafts, {
              taxRate,
              estimateTotalCents: toCents(toNumber(estimate.total)),
              existingInvoicedCents: toCents(conversionBefore.invoicedTotal),
            })

            const lineItemsData = reconciled.lineItems.map((draft, idx) => {
              const li = draft.li
              const unitPrice = Number(draft.unitPrice)
              const total = fromCents(toCents(draft.quantity * unitPrice))
              return {
                sourceId: li.id,
                description: li.description,
                quantity: draft.quantity,
                unitPrice,
                total,
                sortOrder: idx,
                isVisibleToClient: li.isVisibleToClient !== false,
                showDescriptionToCustomer: li.showDescriptionToCustomer ?? true,
                showCostToCustomer: li.showCostToCustomer ?? false,
                showPriceToCustomer: li.showPriceToCustomer ?? true,
                showTaxToCustomer: li.showTaxToCustomer ?? true,
                showNotesToCustomer: li.showNotesToCustomer ?? true,
                notes: li.notes || null,
                vendorId: li.vendorId || null,
                taxable: li.taxable ?? true,
                taxRate: li.taxRate ?? null,
                unitCost: li.unitCost ?? null,
                sourceItemId: li.sourceItemId || null,
                sourceBundleId: li.sourceBundleId || null,
              }
            })

            const subtotal = reconciled.subtotal
            const taxAmount = reconciled.taxAmount
            const total = reconciled.total
            const paymentToken = crypto.randomBytes(32).toString('hex')
            const billingSuffix = isFullBilling ? 'Full Billing' : `${depositPct.toFixed(2)}% Billing`

            const inv = await tx.invoice.create({
              data: {
                tenantId: tokenRow.tenantId,
                clientId: estimate.clientId!,
                jobId: autoCreatedJob?.id || estimate.jobId || null,
                estimateId: estimate.id,
                invoiceNumber,
                title: `${estimate.title} - ${billingSuffix}`,
                status: 'SENT',
                subtotal,
                taxRate,
                taxAmount,
                discount: 0,
                total,
                originalTotalAtConversion: total,
                paidAmount: 0,
                balance: total,
                invoiceDate: now,
                qboAchEnabled: true,
                paymentToken,
                progressBillingMode: isFullBilling ? 'FULL' : 'PERCENTAGE',
                progressBillingPercent: depositPct,
                notes: `Invoice from approved estimate ${estimate.estimateNumber} — ${depositPct.toFixed(2)}% billing.`,
              },
            })

            for (const lid of lineItemsData) {
              await tx.invoiceLineItem.create({
                data: {
                  invoiceId: inv.id,
                  description: lid.description,
                  quantity: lid.quantity,
                  unitPrice: lid.unitPrice,
                  total: lid.total,
                  sortOrder: lid.sortOrder,
                  isVisibleToClient: lid.isVisibleToClient,
                  showDescriptionToCustomer: lid.showDescriptionToCustomer,
                  showCostToCustomer: lid.showCostToCustomer,
                  showPriceToCustomer: lid.showPriceToCustomer,
                  showTaxToCustomer: lid.showTaxToCustomer,
                  showNotesToCustomer: lid.showNotesToCustomer,
                  notes: lid.notes,
                  vendorId: lid.vendorId,
                  taxable: lid.taxable,
                  taxRate: lid.taxRate,
                  unitCost: lid.unitCost,
                  sourceItemId: lid.sourceItemId,
                  sourceBundleId: lid.sourceBundleId,
                },
              })
            }

            await tx.invoiceLineItemSource.createMany({
              data: toInvoiceIds.map((estimateLineItemId) => ({
                tenantId: tokenRow.tenantId,
                invoiceId: inv.id,
                estimateId: estimate.id,
                estimateLineItemId,
              })),
              skipDuplicates: true,
            })

            const conversion = await getEstimateConversionSummary(tx, estimate.id, estimate.total, tokenRow.tenantId)
            await tx.estimate.update({
              where: { id: estimate.id },
              data: { status: 'CONVERTED', convertedPercent: conversion.convertedPercent },
            })

            paymentUrl = `${getAppUrl()}/portal/pay/${inv.id}?token=${paymentToken}`
            return { ...inv, paymentToken }
          })
        } catch (invoiceErr) {
          console.error('Failed to auto-create deposit invoice:', invoiceErr)
        }

        if (autoCreatedInvoice?.id) {
          try {
            const emailResult = await sendInvoiceEmailForInvoice({
              tenantId: tokenRow.tenantId,
              invoiceId: autoCreatedInvoice.id,
              message: `Thank you for approving estimate ${estimate.estimateNumber}. Your invoice is attached.`,
            })
            if (!emailResult.ok) {
              console.error('Failed to email auto-created invoice:', emailResult.error)
            }
          } catch (emailErr) {
            console.error('Failed to email auto-created invoice:', emailErr)
          }
        }
      } else {
        // No invoice was created, so do not mark the estimate as converted.
      }
    }

    // Notify admin/accounting/manager users
    if (approvedIds.length > 0) {
      try {
        const notifyUsers = await prisma.user.findMany({
          where: {
            tenantId: tokenRow.tenantId,
            role: { in: ['ADMIN', 'ACCOUNTING', 'MANAGER'] },
            status: 'ACTIVE',
          },
          select: { id: true },
        })
        if (notifyUsers.length > 0) {
          const clientName =
            estimate.client?.companyName || estimate.client?.name || parsedBody.data.signerName
          const extraInfo = [
            autoCreatedJob ? `Job ${autoCreatedJob.jobNumber} created.` : null,
            autoCreatedInvoice ? `Invoice ${autoCreatedInvoice.invoiceNumber} created.` : null,
          ].filter(Boolean).join(' ')
          await createNotificationsForUsers(
            tokenRow.tenantId,
            notifyUsers.map((u) => u.id),
            {
              type: 'SYSTEM',
              title: 'Estimate Approved',
              message: `${parsedBody.data.signerName} approved estimate ${estimate.estimateNumber} for ${clientName}. ${extraInfo}`.trim(),
              linkUrl: `/dashboard/estimates/${estimate.id}`,
              linkType: 'estimate',
              linkId: estimate.id,
              requiresAck: true,
            }
          )
        }
      } catch (notifyErr) {
        console.error('Failed to send estimate approval notification:', notifyErr)
      }
    }

    if (autoCreatedInvoice?.id) {
      try {
        await enqueueQboSync(tokenRow.tenantId, 'invoice', autoCreatedInvoice.id)
      } catch (error) {
        console.error('QuickBooks invoice sync trigger error (estimate approval):', error)
      }
    }

    // Sync estimate status to QB (Accepted/Closed) after public approval.
    if (approvedIds.length > 0) {
      try {
        await enqueueQboSync(tokenRow.tenantId, 'estimate', estimate.id, { processImmediately: false })
      } catch (error) {
        console.error('QuickBooks estimate sync trigger error (estimate approval):', error)
      }
    }

    const jobIdForCost =
      autoCreatedJob?.id ||
      autoCreatedInvoice?.jobId ||
      estimate.jobId ||
      null
    if (jobIdForCost && approvedIds.length > 0) {
      try {
        const current = await prisma.estimate.findUnique({
          where: { id: estimate.id },
          select: { status: true },
        })
        if (
          current &&
          current.status !== 'CONVERTED' &&
          current.status !== 'ACCEPTED'
        ) {
          await prisma.estimate.update({
            where: { id: estimate.id },
            data: { status: 'ACCEPTED' },
          })
        }
        await syncJobCostFromLinkedDocuments(jobIdForCost)
      } catch (syncErr) {
        console.error('Failed to sync job cost after public estimate approval:', syncErr)
      }
    }

    return NextResponse.json({
      ok: true,
      approvedCount: approvedIds.length,
      approvedLineItemIds: approvedIds,
      autoCreatedJob: autoCreatedJob ? { id: autoCreatedJob.id, jobNumber: autoCreatedJob.jobNumber } : null,
      autoCreatedInvoice: autoCreatedInvoice ? { id: autoCreatedInvoice.id, invoiceNumber: autoCreatedInvoice.invoiceNumber } : null,
      paymentUrl,
    })
  } catch (err: any) {
    if (err instanceof NextResponse) return err
    if (err?.status === 429) return err
    console.error('Public estimate approval POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
