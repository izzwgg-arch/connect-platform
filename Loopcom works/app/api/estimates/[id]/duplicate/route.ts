import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import {
  allocateNextEstimateNumber,
  assertEstimateNumberAvailableForCreate,
  mapEstimateDocNumberErrorToResponse,
} from '@/lib/qbo/doc-numbers'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const source = await prisma.estimate.findFirst({
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
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const estimateNumber = await allocateNextEstimateNumber({ tenantId: user.tenantId })

    try {
      await assertEstimateNumberAvailableForCreate(user.tenantId, estimateNumber)
    } catch (err) {
      const mapped = mapEstimateDocNumberErrorToResponse(err)
      if (mapped) return NextResponse.json(mapped.body, { status: mapped.status })
      throw err
    }

    const duplicate = await prisma.estimate.create({
      data: {
        tenantId: user.tenantId,
        clientId: source.clientId,
        leadId: source.leadId,
        estimateNumber,
        title: `${source.title} (Copy)`,
        jobSiteAddress: source.jobSiteAddress,
        status: 'DRAFT',
        subtotal: source.subtotal,
        taxRate: source.taxRate,
        taxAmount: source.taxAmount,
        discount: source.discount,
        total: source.total,
        validUntil: source.validUntil,
        notes: source.notes,
        isNotesVisibleToClient: source.isNotesVisibleToClient,
        terms: source.terms,
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
          documentType: 'ESTIMATE',
          documentId: duplicate.id,
          name: group.name,
          sourceBundleId: group.sourceBundleId,
          sourceBundleName: group.sourceBundleName,
        },
      })
      groupMap.set(oldGroupId, createdGroup.id)
    }

    if (source.lineItems.length > 0) {
      await prisma.estimateLineItem.createMany({
        data: source.lineItems.map((item) => ({
          estimateId: duplicate.id,
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

    return NextResponse.json({ estimate: duplicate, id: duplicate.id }, { status: 201 })
  } catch (error) {
    console.error('Duplicate estimate error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
