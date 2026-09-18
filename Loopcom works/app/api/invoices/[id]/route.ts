import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { notifyInvoiceOverdue } from '@/lib/notifications'
import { formatAddressParts, parseAddressParts } from '@/lib/address/parse'
import { geocodeAddressPartsFromString } from '@/lib/geocoding'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { calculateOrderedSubtotalRows } from '@/lib/documents/subtotals'
import {
  assertInvoiceNumberAvailableInQuickBooks,
  normalizeInvoiceNumber,
} from '@/lib/qbo/doc-numbers'
import { syncJobCostFromLinkedDocuments } from '@/lib/jobs/sync-job-cost'

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
    const invoice = await prisma.invoice.findFirst({
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
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
            addresses: {
              where: { type: 'job_site' },
              take: 1,
            },
          },
        },
        estimate: {
          select: {
            id: true,
            estimateNumber: true,
            total: true,
            jobSiteAddress: true,
          },
        },
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: {
            group: true,
            vendor: { select: { name: true } },
            sourceItem: { select: { id: true, name: true, kind: true } },
          },
        },
        optionalItems: {
          orderBy: { sortOrder: 'asc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          include: {
            invoice: {
              select: {
                invoiceNumber: true,
              },
            },
          },
        },
        attachments: {
          orderBy: { createdAt: 'desc' },
        },
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Convert Decimal fields to strings for frontend
    const jobSiteAddressRaw =
      formatAddressParts(invoice.job?.addresses?.[0]) ||
      (invoice.estimate?.jobSiteAddress ? String(invoice.estimate.jobSiteAddress) : null)
    const parsed = parseAddressParts(jobSiteAddressRaw)
    const missingJobSiteParts = Boolean(
      jobSiteAddressRaw && (!parsed?.city || !parsed?.state || !parsed?.zipCode)
    )
    const geo = missingJobSiteParts ? await geocodeAddressPartsFromString(jobSiteAddressRaw!) : null
    const derived = geo || { street: '', city: '', state: '', zipCode: '' }
    const jobSiteAddress =
      jobSiteAddressRaw && geo
        ? `${derived.street || jobSiteAddressRaw}, ${derived.city}, ${derived.state} ${derived.zipCode}`.trim()
        : jobSiteAddressRaw

    const invoiceResponse = {
      ...invoice,
      jobSiteAddress,
      jobSiteCity: (parsed?.city || derived.city || '').trim() || null,
      jobSiteState: (parsed?.state || derived.state || '').trim() || null,
      jobSiteZipCode: (parsed?.zipCode || derived.zipCode || '').trim() || null,
      subtotal: invoice.subtotal.toString(),
      taxRate: invoice.taxRate.toString(),
      taxAmount: invoice.taxAmount.toString(),
      discount: invoice.discount?.toString() || '0',
      total: invoice.total.toString(),
      balance: invoice.balance.toString(),
      paidAmount: invoice.paidAmount.toString(),
      progressBillingMode: invoice.progressBillingMode || null,
      progressBillingPercent: invoice.progressBillingPercent ? invoice.progressBillingPercent.toString() : null,
      lineItems: calculateOrderedSubtotalRows(invoice.lineItems as any[]).map((item: any) => ({
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
          customerDescription: item.group.customerDescription ?? null,
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
      optionalItems: invoice.optionalItems.map((item) => ({
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
      })),
      payments: invoice.payments.map(payment => ({
        ...payment,
        amount: payment.amount.toString(),
      })),
    }

    return NextResponse.json({ invoice: invoiceResponse })
  } catch (error) {
    console.error('Get invoice error:', error)
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
    const body = await request.json()
    const {
      clientId,
      jobId,
      invoiceNumber,
      title,
      lineItems,
      optionalItems,
      groups, // Array of { groupId, name, sourceBundleId }
      taxRate,
      discount,
      status,
      invoiceDate,
      dueDate,
      notes,
      isNotesVisibleToClient,
      terms,
      memo,
      documentTemplateKey,
      documentTemplateVersion,
      documentSnapshotJson,
    } = body

    // Get existing invoice
    const existing = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        lineItems: true,
        payments: true,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Don't allow editing paid invoices
    if (existing.status === 'PAID') {
      return NextResponse.json({ error: 'Cannot edit paid invoice' }, { status: 400 })
    }

    const normalizedInvoiceNumber = normalizeInvoiceNumber(invoiceNumber)
    if (normalizedInvoiceNumber && normalizedInvoiceNumber !== existing.invoiceNumber) {
      try {
        await assertInvoiceNumberAvailableInQuickBooks(user.tenantId, normalizedInvoiceNumber)
      } catch (err: any) {
        return NextResponse.json({ error: err?.message || 'Invoice number already exists in QuickBooks' }, { status: 400 })
      }
    }

    let resolvedClientId: string | undefined = undefined
    if (clientId !== undefined) {
      const nextClientId = clientId ? String(clientId) : null
      if (!nextClientId) {
        return NextResponse.json({ error: 'Client is required' }, { status: 400 })
      }
      const client = await prisma.client.findFirst({
        where: { id: nextClientId, tenantId: user.tenantId },
        select: { id: true },
      })
      if (!client) {
        return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      }
      resolvedClientId = nextClientId
    }

    let resolvedJobId: string | null | undefined = undefined
    if (jobId !== undefined) {
      if (jobId === null || jobId === '') {
        resolvedJobId = null
      } else {
        const job = await prisma.job.findFirst({
          where: { id: String(jobId), tenantId: user.tenantId },
          select: { id: true, clientId: true },
        })
        if (!job) {
          return NextResponse.json({ error: 'Job not found' }, { status: 404 })
        }
        const effectiveClientId =
          resolvedClientId !== undefined ? resolvedClientId : existing.clientId
        if (job.clientId !== effectiveClientId) {
          return NextResponse.json(
            { error: 'Job must belong to the same client as the invoice' },
            { status: 400 }
          )
        }
        resolvedJobId = job.id
      }
    }

    // Recalculate totals if line items changed
    let subtotal = Number(existing.subtotal)
    let discountAmount = Number(existing.discount || 0)
    let taxRateNum = Number(existing.taxRate || 0)

    if (lineItems && Array.isArray(lineItems)) {
      subtotal = lineItems.reduce((sum: number, item: any) => {
        if (item?.isSubtotal) return sum
        const qty = parseFloat(item.quantity || 0)
        const price = parseFloat(item.unitPrice || 0)
        return sum + (qty * price)
      }, 0)

      // Delete existing groups and line items
      await prisma.documentLineGroup.deleteMany({
        where: {
          tenantId: user.tenantId,
          documentType: 'INVOICE',
          documentId: params.id,
        },
      })
      await prisma.invoiceLineItem.deleteMany({
        where: { invoiceId: params.id },
      })
      await prisma.invoiceOptionalLineItem.deleteMany({
        where: { invoiceId: params.id },
      })

      // Create new groups
      const groupMap = new Map<string, string>() // groupId -> database group ID
      if (groups && Array.isArray(groups)) {
        for (const group of groups) {
          const dbGroup = await prisma.documentLineGroup.create({
            data: {
              tenantId: user.tenantId,
              documentType: 'INVOICE',
              documentId: params.id,
              name: group.name || 'Bundle',
              sourceBundleId: group.sourceBundleId || null,
              sourceBundleName: group.name || null,
              customerDescription: group.customerDescription ?? null,
              customerTotal:
                group.customerTotal !== undefined && group.customerTotal !== null && group.customerTotal !== ''
                  ? Number(group.customerTotal)
                  : null,
              customerEdited: Boolean(group.customerEdited),
            },
          })
          groupMap.set(group.groupId, dbGroup.id)
        }
      }

      // Create new line items. Subtotal rows are calculated from the preceding ordered segment.
      const calculatedLineItems = calculateOrderedSubtotalRows(lineItems as any[])
      for (let i = 0; i < calculatedLineItems.length; i++) {
        const item = calculatedLineItems[i]
        const isSubtotalItem = Boolean(item.isSubtotal)
        const qty = isSubtotalItem ? 0 : parseFloat(item.quantity || 0)
        const price = isSubtotalItem ? 0 : parseFloat(item.unitPrice || 0)
        const itemTotal = item.calculatedSubtotalTotal

        // Get groupId from map if item has a groupId
        const dbGroupId = item.groupId ? groupMap.get(item.groupId) || null : null

        await prisma.invoiceLineItem.create({
          data: {
            invoiceId: params.id,
            groupId: dbGroupId,
            description: isSubtotalItem ? 'Subtotal' : item.description,
            quantity: qty,
            unitPrice: price,
            unitCost: isSubtotalItem ? null : (item.unitCost ? parseFloat(item.unitCost) : null),
            total: itemTotal,
            sortOrder: i,
            isSubtotal: isSubtotalItem,
            isVisibleToClient: item.isVisibleToClient !== undefined ? Boolean(item.isVisibleToClient) : true,
            // New per-field visibility flags
            showDescriptionToCustomer:
              item.showDescriptionToCustomer !== undefined ? Boolean(item.showDescriptionToCustomer) : true,
            showCostToCustomer: item.showCostToCustomer !== undefined ? Boolean(item.showCostToCustomer) : false,
            showPriceToCustomer: item.showPriceToCustomer !== undefined ? Boolean(item.showPriceToCustomer) : true,
            showTaxToCustomer: item.showTaxToCustomer !== undefined ? Boolean(item.showTaxToCustomer) : true,
            showNotesToCustomer: item.showNotesToCustomer !== undefined ? Boolean(item.showNotesToCustomer) : false,
            // Additional fields
            vendorId: isSubtotalItem ? null : (item.vendorId || null),
            taxable: isSubtotalItem ? false : (item.taxable !== undefined ? Boolean(item.taxable) : true),
            taxRate: isSubtotalItem ? null : (item.taxRate ? parseFloat(item.taxRate) : null),
            notes: item.notes || null,
            sourceItemId: item.sourceItemId || null,
            sourceBundleId: item.sourceBundleId || null,
          },
        })
      }

      // Create optional line items (do NOT affect main totals)
      if (optionalItems && Array.isArray(optionalItems) && optionalItems.length > 0) {
        for (let i = 0; i < optionalItems.length; i++) {
          const item = optionalItems[i]
          const qty = parseFloat(item.quantity || 0)
          const price = parseFloat(item.unitPrice || 0)
          const itemTotal = qty * price
          const dbGroupId = item.groupId ? groupMap.get(item.groupId) || null : null

          await prisma.invoiceOptionalLineItem.create({
            data: {
              invoiceId: params.id,
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
    const paidAmount = Number(existing.paidAmount || 0)
    const balance = total - paidAmount

    // Update invoice
    let invoiceRecord: any = null
    try {
      invoiceRecord = await prisma.invoice.update({
        where: { id: params.id },
        data: {
          invoiceNumber:
            normalizedInvoiceNumber && normalizedInvoiceNumber !== existing.invoiceNumber
              ? normalizedInvoiceNumber
              : undefined,
          title: title !== undefined ? title : existing.title,
          clientId: resolvedClientId !== undefined ? resolvedClientId : undefined,
          jobId:
            resolvedJobId !== undefined
              ? resolvedJobId
              : resolvedClientId !== undefined && resolvedClientId !== existing.clientId
                ? null
                : undefined,
        subtotal: subtotal,
        taxRate: taxRateNum,
        taxAmount: tax,
        discount: discountAmount,
        total: total,
        balance: balance,
        status: status !== undefined ? status : existing.status,
        invoiceDate: invoiceDate !== undefined ? (invoiceDate ? new Date(invoiceDate) : existing.invoiceDate) : existing.invoiceDate,
        dueDate: dueDate !== undefined ? (dueDate ? new Date(dueDate) : null) : existing.dueDate,
        notes: notes !== undefined ? notes : existing.notes,
        isNotesVisibleToClient:
          isNotesVisibleToClient !== undefined ? Boolean(isNotesVisibleToClient) : existing.isNotesVisibleToClient,
        terms: terms !== undefined ? terms : existing.terms,
        memo: memo !== undefined ? memo : existing.memo,
        renderTemplateKey:
          documentTemplateKey !== undefined ? documentTemplateKey : existing.renderTemplateKey,
        renderTemplateVersion:
          documentTemplateVersion !== undefined
            ? documentTemplateVersion
            : existing.renderTemplateVersion,
        renderSnapshot:
          documentSnapshotJson !== undefined ? documentSnapshotJson : existing.renderSnapshot,
        },
        include: {
          client: true,
          lineItems: {
            orderBy: { sortOrder: 'asc' },
          },
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002' && err?.meta?.target?.includes?.('invoiceNumber')) {
        return NextResponse.json({ error: 'Invoice number already exists' }, { status: 400 })
      }
      throw err
    }

    // Update status to overdue if past due date
    if (
      invoiceRecord.dueDate &&
      invoiceRecord.balance.toNumber() > 0 &&
      new Date(invoiceRecord.dueDate) < new Date() &&
      invoiceRecord.status !== 'PAID'
    ) {
      const wasOverdue = invoiceRecord.status === 'OVERDUE'
      await prisma.invoice.update({
        where: { id: params.id },
        data: { status: 'OVERDUE' },
      })
      invoiceRecord.status = 'OVERDUE'

      // Notify if status just changed to overdue
      if (!wasOverdue && invoiceRecord.client) {
        const daysOverdue = Math.floor(
          (new Date().getTime() - new Date(invoiceRecord.dueDate).getTime()) / (1000 * 60 * 60 * 24)
        )
        await notifyInvoiceOverdue(
          user.tenantId,
          invoiceRecord.id,
          invoiceRecord.invoiceNumber,
          invoiceRecord.client.name,
          daysOverdue
        )
      }
    }

    // Best-effort: if this invoice is connected to QBO, push edits over as an update.
    try {
      await enqueueQboSync(user.tenantId, 'invoice', invoiceRecord.id)
    } catch (error) {
      console.error('QuickBooks invoice sync trigger error (invoice update):', error)
    }

    const previousJobId = existing.jobId
    const nextJobId = invoiceRecord.jobId || null
    try {
      if (previousJobId && previousJobId !== nextJobId) {
        await syncJobCostFromLinkedDocuments(previousJobId)
      }
      if (nextJobId) {
        await syncJobCostFromLinkedDocuments(nextJobId)
      }
    } catch (syncErr) {
      console.error('Failed to sync job cost after invoice update:', syncErr)
    }

    return NextResponse.json({ invoice: invoiceRecord })
  } catch (error) {
    console.error('Update invoice error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Don't delete if has payments
    const paymentCount = await prisma.payment.count({
      where: { invoiceId: params.id },
    })

    if (paymentCount > 0) {
      return NextResponse.json(
        { error: 'Cannot delete invoice with payments. Cancel it instead.' },
        { status: 400 }
      )
    }

    // Delete invoice line items first (cascade should handle this, but being explicit)
    await prisma.invoiceLineItem.deleteMany({
      where: { invoiceId: params.id },
    })

    const previousJobId = invoice.jobId

    // Actually delete the invoice
    await prisma.invoice.delete({
      where: { id: params.id },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entityType: 'Invoice',
        entityId: invoice.id,
      },
    })

    if (previousJobId) {
      try {
        await syncJobCostFromLinkedDocuments(previousJobId)
      } catch (syncErr) {
        console.error('Failed to sync job cost after invoice delete:', syncErr)
      }
    }

    return NextResponse.json({ message: 'Invoice deleted successfully' })
  } catch (error) {
    console.error('Delete invoice error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
