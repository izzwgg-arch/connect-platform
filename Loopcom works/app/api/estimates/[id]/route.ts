import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { parseAddressParts } from '@/lib/address/parse'
import { geocodeAddressPartsFromString } from '@/lib/geocoding'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { calculateOrderedSubtotalRows } from '@/lib/documents/subtotals'
import { calculateEstimateConversionSummary, getEstimateConversionProgress, getEstimateConversionSummary } from '@/lib/documents/conversion'
import {
  assertEstimateNumberAvailableForCreate,
  mapEstimateDocNumberErrorToResponse,
  normalizeEstimateNumber,
} from '@/lib/qbo/doc-numbers'
import { syncJobCostFromLinkedDocuments } from '@/lib/jobs/sync-job-cost'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
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
            addresses: {
              where: { type: 'billing' },
              take: 1,
            },
          },
        },
        lead: true,
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
          },
        },
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: {
            group: true,
            vendor: { select: { id: true, name: true } },
            sourceItem: { select: { id: true, name: true, kind: true } },
          },
        },
        optionalItems: {
          orderBy: { sortOrder: 'asc' },
        },
        invoices: {
          where: {
            status: { notIn: ['CANCELLED', 'REFUNDED'] },
          },
          select: {
            total: true,
            originalTotalAtConversion: true,
          },
        },
        attachments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    })

    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    // Load approval records so optional items can be marked as approved
    const itemApprovals = await prisma.estimateItemApproval.findMany({
      where: { tenantId: user.tenantId, estimateId: params.id, status: 'APPROVED' },
      select: { estimateLineItemId: true, approvedAt: true, approvedByName: true },
    })
    const approvedItemIdSet = new Set(itemApprovals.map((a) => a.estimateLineItemId))

    // Convert Decimal fields to strings for frontend
    const jobSiteAddress = estimate.jobSiteAddress
      ? String(estimate.jobSiteAddress)
      : estimate.lead?.jobSiteAddress
        ? String(estimate.lead.jobSiteAddress)
        : null
    const parsed = parseAddressParts(jobSiteAddress)
    const missingParts = Boolean(
      jobSiteAddress && (!parsed?.city || !parsed?.state || !parsed?.zipCode)
    )
    const geo = missingParts ? await geocodeAddressPartsFromString(jobSiteAddress!) : null
    const derived = geo || { street: '', city: '', state: '', zipCode: '' }

    // If we only have a freeform street text, enrich the response with a resolved
    // "street, city, state zip" string so UI components/maps have a complete address.
    const resolvedJobSiteAddress =
      jobSiteAddress && geo
        ? `${derived.street || jobSiteAddress}, ${derived.city}, ${derived.state} ${derived.zipCode}`.trim()
        : jobSiteAddress

    // Use each invoice's immutable at-conversion snapshot when available, so a
    // discount applied to the invoice afterward doesn't shrink the estimate's
    // tracked conversion percentage. Falls back to the live total for
    // invoices created before this snapshot existed.
    const invoicedAmounts = estimate.invoices.map(
      (invoice) => invoice.originalTotalAtConversion ?? invoice.total
    )
    const conversion = calculateEstimateConversionSummary(estimate.total, invoicedAmounts)
    const conversionProgress = getEstimateConversionProgress(estimate.total, invoicedAmounts)

    const estimateResponse = {
      ...estimate,
      invoices: undefined,
      convertedPercent: conversion.convertedPercent > 0 ? conversion.convertedPercent : null,
      conversionProgress: {
        estimateTotal: conversionProgress.estimateTotal.toFixed(2),
        invoicedTotal: conversionProgress.invoicedTotal.toFixed(2),
        remainingAmount: conversionProgress.remainingAmount.toFixed(2),
        convertedPercent: conversionProgress.convertedPercent,
        remainingPercent: conversionProgress.remainingPercent,
        isFullyInvoiced: conversionProgress.isFullyInvoiced,
      },
      jobSiteAddress: resolvedJobSiteAddress,
      jobSiteCity: (parsed?.city || derived.city || '').trim() || null,
      jobSiteState: (parsed?.state || derived.state || '').trim() || null,
      jobSiteZipCode: (parsed?.zipCode || derived.zipCode || '').trim() || null,
      subtotal: estimate.subtotal.toString(),
      depositPercent: (estimate as any).depositPercent != null ? Number((estimate as any).depositPercent) : null,
      taxRate: estimate.taxRate?.toString() || '0',
      taxAmount: estimate.taxAmount?.toString() || '0',
      discount: estimate.discount?.toString() || '0',
      total: estimate.total.toString(),
      lineItems: calculateOrderedSubtotalRows(estimate.lineItems as any[]).map((item: any) => ({
        ...item,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        unitCost: item.unitCost ? item.unitCost.toString() : null,
        total: (item.isSubtotal ? item.calculatedSubtotalTotal : item.total).toString(),
        isVisibleToClient: item.isVisibleToClient,
        // New visibility fields
        showDescriptionToCustomer: item.showDescriptionToCustomer ?? true,
        showCostToCustomer: item.showCostToCustomer ?? false,
        showPriceToCustomer: item.showPriceToCustomer ?? true,
        showTaxToCustomer: item.showTaxToCustomer ?? true,
        showNotesToCustomer: item.showNotesToCustomer ?? false,
        // Additional fields
        vendorId: item.vendorId || null,
        vendorName: item.vendor?.name || null,
        taxable: item.taxable ?? true,
        taxRate: item.taxRate ? item.taxRate.toString() : null,
        notes: item.notes || null,
        groupId: item.groupId || null,
        group: item.group ? {
          id: item.group.id,
          name: item.group.name,
          sourceBundleId: item.group.sourceBundleId,
          sourceBundleName: item.group.sourceBundleName,
          customerDescription: item.group.customerDescription || null,
          customerTotal: item.group.customerTotal != null ? item.group.customerTotal.toString() : null,
          customerEdited: Boolean(item.group.customerEdited),
        } : null,
        sourceItemId: item.sourceItemId || null,
        sourceBundleId: item.sourceBundleId || null,
        sourceItem: item.sourceItem ? {
          id: item.sourceItem.id,
          name: item.sourceItem.name,
          kind: item.sourceItem.kind,
        } : null,
      })),
      optionalItems: estimate.optionalItems.map((item) => ({
        ...item,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        unitCost: item.unitCost ? item.unitCost.toString() : null,
        total: item.total.toString(),
        isVisibleToClient: item.isVisibleToClient,
        showDescriptionToCustomer: item.showDescriptionToCustomer ?? true,
        showCostToCustomer: item.showCostToCustomer ?? false,
        showPriceToCustomer: item.showPriceToCustomer ?? true,
        showTaxToCustomer: item.showTaxToCustomer ?? true,
        showNotesToCustomer: item.showNotesToCustomer ?? false,
        vendorId: item.vendorId || null,
        taxable: item.taxable ?? true,
        taxRate: item.taxRate ? item.taxRate.toString() : null,
        notes: item.notes || null,
        groupId: item.groupId || null,
        sourceItemId: item.sourceItemId || null,
        sourceBundleId: item.sourceBundleId || null,
        // True when customer has approved this optional item
        isApproved: approvedItemIdSet.has(item.id),
      })),
    }

    return NextResponse.json({ estimate: estimateResponse })
  } catch (error) {
    console.error('Get estimate error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      clientId,
      estimateNumber,
      title,
      jobSiteAddress,
      lineItems,
      optionalItems,
      groups, // Array of { groupId, name, sourceBundleId }
      taxRate,
      discount,
      status,
      validUntil,
      notes,
      isNotesVisibleToClient,
      terms,
      depositPercent,
    } = body

    const normalizedDepositPercent =
      depositPercent === undefined
        ? undefined
        : depositPercent === null || depositPercent === ''
          ? null
          : (() => {
              const n = Number(depositPercent)
              return Number.isFinite(n) && n > 0 && n <= 100 ? n : null
            })()

    // Get existing estimate
    const existing = await prisma.estimate.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        lineItems: true,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const normalizedEstimateNumber = normalizeEstimateNumber(estimateNumber)
    const estimateNumberChanging =
      normalizedEstimateNumber && normalizedEstimateNumber !== existing.estimateNumber

    if (estimateNumberChanging) {
      try {
        await assertEstimateNumberAvailableForCreate(user.tenantId, normalizedEstimateNumber, {
          excludeEstimateId: params.id,
        })
      } catch (err) {
        const mapped = mapEstimateDocNumberErrorToResponse(err)
        if (mapped) return NextResponse.json(mapped.body, { status: mapped.status })
        throw err
      }
    }

    let resolvedClientId: string | null | undefined = undefined
    if (clientId !== undefined) {
      const nextClientId = clientId ? String(clientId) : null
      if (nextClientId) {
        const client = await prisma.client.findFirst({
          where: { id: nextClientId, tenantId: user.tenantId },
          select: { id: true },
        })
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 })
        }
      }
      resolvedClientId = nextClientId
    }

    // Recalculate totals if line items changed
    let subtotal = Number(existing.subtotal)
    let discountAmount = Number(existing.discount || 0)
    let taxRateNum = Number(existing.taxRate || 0)

    if (lineItems && Array.isArray(lineItems)) {
      // Only regular (non-subtotal) rows contribute to the estimate subtotal
      subtotal = lineItems.reduce((sum: number, item: any) => {
        if (item.isSubtotal) return sum
        const qty = parseFloat(item.quantity || 0)
        const price = parseFloat(item.unitPrice || 0)
        return sum + (qty * price)
      }, 0)

      // Delete existing groups and line items
      await prisma.documentLineGroup.deleteMany({
        where: {
          tenantId: user.tenantId,
          documentType: 'ESTIMATE',
          documentId: params.id,
        },
      })
      await prisma.estimateLineItem.deleteMany({
        where: { estimateId: params.id },
      })
      await prisma.estimateOptionalLineItem.deleteMany({
        where: { estimateId: params.id },
      })

      // Create new groups
      const groupMap = new Map<string, string>() // groupId -> database group ID
      if (groups && Array.isArray(groups)) {
        for (const group of groups) {
          const dbGroup = await prisma.documentLineGroup.create({
            data: {
              tenantId: user.tenantId,
              documentType: 'ESTIMATE',
              documentId: params.id,
              name: group.name || 'Bundle',
              sourceBundleId: group.sourceBundleId || null,
              sourceBundleName: group.name || null,
              customerDescription: group.customerDescription || null,
              customerTotal:
                group.customerTotal != null && group.customerTotal !== ''
                  ? parseFloat(String(group.customerTotal))
                  : null,
              customerEdited: Boolean(group.customerEdited),
            },
          })
          groupMap.set(group.groupId, dbGroup.id)
        }
      }

      // Create new line items; subtotal rows are calculated from the preceding ordered segment.
      const calculatedLineItems = calculateOrderedSubtotalRows(lineItems as any[])
      for (let i = 0; i < calculatedLineItems.length; i++) {
        const item = calculatedLineItems[i]
        const isSubtotal = Boolean(item.isSubtotal)
        const itemTotal = item.calculatedSubtotalTotal

        const qty = isSubtotal ? 0 : parseFloat(item.quantity || 0)
        const price = isSubtotal ? 0 : parseFloat(item.unitPrice || 0)

        // Get groupId from map if item has a groupId
        const dbGroupId = item.groupId ? groupMap.get(item.groupId) || null : null

        await prisma.estimateLineItem.create({
          data: {
            estimateId: params.id,
            groupId: dbGroupId,
            description: item.description || 'Subtotal',
            quantity: qty,
            unitPrice: price,
            unitCost: item.unitCost ? parseFloat(item.unitCost) : null,
            total: itemTotal,
            sortOrder: i,
            isVisibleToClient: item.isVisibleToClient !== undefined ? Boolean(item.isVisibleToClient) : true,
            showDescriptionToCustomer:
              item.showDescriptionToCustomer !== undefined ? Boolean(item.showDescriptionToCustomer) : true,
            showCostToCustomer: item.showCostToCustomer !== undefined ? Boolean(item.showCostToCustomer) : false,
            showPriceToCustomer: item.showPriceToCustomer !== undefined ? Boolean(item.showPriceToCustomer) : true,
            showTaxToCustomer: item.showTaxToCustomer !== undefined ? Boolean(item.showTaxToCustomer) : true,
            showNotesToCustomer: item.showNotesToCustomer !== undefined ? Boolean(item.showNotesToCustomer) : false,
            vendorId: item.vendorId || null,
            taxable: isSubtotal ? false : (item.taxable !== undefined ? Boolean(item.taxable) : true),
            taxRate: item.taxRate ? parseFloat(item.taxRate) : null,
            notes: item.notes || null,
            sourceItemId: item.sourceItemId || null,
            sourceBundleId: item.sourceBundleId || null,
            isSubtotal,
          },
        })
      }

      if (optionalItems && Array.isArray(optionalItems) && optionalItems.length > 0) {
        for (let i = 0; i < optionalItems.length; i++) {
          const item = optionalItems[i]
          const qty = parseFloat(item.quantity || 0)
          const price = parseFloat(item.unitPrice || 0)
          const itemTotal = qty * price
          const dbGroupId = item.groupId ? groupMap.get(item.groupId) || null : null

          await prisma.estimateOptionalLineItem.create({
            data: {
              estimateId: params.id,
              groupId: dbGroupId,
              description: item.description,
              quantity: qty,
              unitPrice: price,
              unitCost: item.unitCost ? parseFloat(item.unitCost) : null,
              total: itemTotal,
              sortOrder: i,
              isVisibleToClient: item.isVisibleToClient !== undefined ? Boolean(item.isVisibleToClient) : true,
              showDescriptionToCustomer:
                item.showDescriptionToCustomer !== undefined ? Boolean(item.showDescriptionToCustomer) : true,
              showCostToCustomer: item.showCostToCustomer !== undefined ? Boolean(item.showCostToCustomer) : false,
              showPriceToCustomer: item.showPriceToCustomer !== undefined ? Boolean(item.showPriceToCustomer) : true,
              showTaxToCustomer: item.showTaxToCustomer !== undefined ? Boolean(item.showTaxToCustomer) : true,
              showNotesToCustomer: item.showNotesToCustomer !== undefined ? Boolean(item.showNotesToCustomer) : false,
              vendorId: item.vendorId || null,
              taxable: item.taxable !== undefined ? Boolean(item.taxable) : true,
              taxRate: item.taxRate ? parseFloat(item.taxRate) : null,
              notes: item.notes || null,
              sourceItemId: item.sourceItemId || null,
              sourceBundleId: item.sourceBundleId || null,
            },
          })
        }
      }
    }

    if (discount !== undefined) {
      discountAmount = parseFloat(discount)
    }

    if (taxRate !== undefined) {
      taxRateNum = parseFloat(taxRate)
    }

    const subtotalAfterDiscount = subtotal - discountAmount
    const tax = subtotalAfterDiscount * taxRateNum
    const total = subtotalAfterDiscount + tax
    const convertedPercentUpdate = status === 'CONVERTED'
      ? (await getEstimateConversionSummary(prisma, params.id, total, user.tenantId)).convertedPercent
      : undefined

    // Update estimate
    let estimateRecord: any = null
    try {
      estimateRecord = await prisma.estimate.update({
        where: { id: params.id },
        data: {
          estimateNumber:
            normalizedEstimateNumber && normalizedEstimateNumber !== existing.estimateNumber
              ? normalizedEstimateNumber
              : undefined,
          title: title !== undefined ? title : existing.title,
          clientId: resolvedClientId !== undefined ? resolvedClientId : undefined,
        jobSiteAddress:
          jobSiteAddress !== undefined
            ? (jobSiteAddress || null)
            : existing.jobSiteAddress,
        subtotal: subtotal,
        taxRate: taxRateNum,
        taxAmount: tax,
        discount: discountAmount,
        total: total,
        convertedPercent: convertedPercentUpdate,
        status: status !== undefined ? status : existing.status,
        depositPercent: normalizedDepositPercent !== undefined ? normalizedDepositPercent : (existing as any).depositPercent,
        validUntil: validUntil !== undefined ? (validUntil ? new Date(validUntil) : null) : existing.validUntil,
        notes: notes !== undefined ? notes : existing.notes,
        isNotesVisibleToClient:
          isNotesVisibleToClient !== undefined ? Boolean(isNotesVisibleToClient) : existing.isNotesVisibleToClient,
        terms: terms !== undefined ? terms : existing.terms,
        },
        include: {
          client: true,
          lineItems: {
            orderBy: { sortOrder: 'asc' },
          },
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002' && err?.meta?.target?.includes?.('estimateNumber')) {
        return NextResponse.json(
          {
            error: 'Estimate number already exists',
            code: 'ESTIMATE_NUMBER_LOCAL_CONFLICT',
            estimateNumber: normalizedEstimateNumber || existing.estimateNumber,
          },
          { status: 409 }
        )
      }
      throw err
    }

    // Best-effort: if this estimate is connected to QBO, push edits over as an update.
    try {
      await enqueueQboSync(user.tenantId, 'estimate', estimateRecord.id, { processImmediately: false })
    } catch (error) {
      console.error('QuickBooks estimate sync trigger error (estimate update):', error)
    }

    const jobIdForCost = estimateRecord.jobId || existing.jobId || null
    const nextStatus = String(estimateRecord.status || '')
    const prevStatus = String(existing.status || '')
    const costRelevant = ['ACCEPTED', 'CONVERTED']
    if (
      jobIdForCost &&
      (costRelevant.includes(nextStatus) || costRelevant.includes(prevStatus))
    ) {
      try {
        await syncJobCostFromLinkedDocuments(jobIdForCost)
      } catch (syncErr) {
        console.error('Failed to sync job cost after estimate update:', syncErr)
      }
    }

    return NextResponse.json({ estimate: estimateRecord })
  } catch (error) {
    console.error('Update estimate error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const estimate = await prisma.estimate.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    // Don't delete if converted to job or accepted
    if (estimate.status === 'CONVERTED' || estimate.status === 'ACCEPTED') {
      return NextResponse.json(
        { error: 'Cannot delete converted or accepted estimate' },
        { status: 400 }
      )
    }

    await prisma.estimate.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ message: 'Estimate deleted successfully' })
  } catch (error) {
    console.error('Delete estimate error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
