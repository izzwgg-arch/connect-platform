import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { allocateNextInvoiceNumber } from '@/lib/qbo/doc-numbers'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const source = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        lineItems: {
          include: {
            group: true,
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!source) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const invoiceNumber = await allocateNextInvoiceNumber({ tenantId: user.tenantId })

    const duplicate = await prisma.invoice.create({
      data: {
        tenantId: user.tenantId,
        clientId: source.clientId,
        jobId: source.jobId,
        invoiceNumber,
        title: `${source.title} (Copy)`,
        status: 'DRAFT',
        subtotal: source.subtotal,
        taxRate: source.taxRate,
        taxAmount: source.taxAmount,
        discount: source.discount,
        total: source.total,
        paidAmount: 0,
        balance: source.total,
        invoiceDate: new Date(),
        dueDate: source.dueDate,
        notes: source.notes,
        terms: source.terms,
        memo: source.memo,
      },
    })

    const uniqueGroups = new Map<string, { name: string; sourceBundleId: string | null; sourceBundleName: string | null }>()
    for (const item of source.lineItems) {
      if (item.groupId && item.group) {
        uniqueGroups.set(item.groupId, {
          name: item.group.name,
          sourceBundleId: item.group.sourceBundleId,
          sourceBundleName: item.group.sourceBundleName,
        })
      }
    }

    const groupMap = new Map<string, string>()
    for (const [oldGroupId, group] of uniqueGroups.entries()) {
      const createdGroup = await prisma.documentLineGroup.create({
        data: {
          tenantId: user.tenantId,
          documentType: 'INVOICE',
          documentId: duplicate.id,
          name: group.name,
          sourceBundleId: group.sourceBundleId,
          sourceBundleName: group.sourceBundleName,
        },
      })
      groupMap.set(oldGroupId, createdGroup.id)
    }

    if (source.lineItems.length > 0) {
      await prisma.invoiceLineItem.createMany({
        data: source.lineItems.map((item) => ({
          invoiceId: duplicate.id,
          groupId: item.groupId ? groupMap.get(item.groupId) || null : null,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          unitCost: item.unitCost,
          total: item.total,
          sortOrder: item.sortOrder,
          isVisibleToClient: item.isVisibleToClient,
          showCostToCustomer: item.showCostToCustomer,
          showPriceToCustomer: item.showPriceToCustomer,
          showTaxToCustomer: item.showTaxToCustomer,
          showNotesToCustomer: item.showNotesToCustomer,
          notes: item.notes,
          vendorId: item.vendorId,
          taxable: item.taxable,
          taxRate: item.taxRate,
          sourceItemId: item.sourceItemId,
          sourceBundleId: item.sourceBundleId,
        })),
      })
    }

    return NextResponse.json({ invoice: duplicate, id: duplicate.id }, { status: 201 })
  } catch (error) {
    console.error('Duplicate invoice error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
