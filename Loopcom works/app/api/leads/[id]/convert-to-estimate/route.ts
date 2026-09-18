import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import {
  allocateNextEstimateNumber,
  assertEstimateNumberAvailableForCreate,
  EstimateDocNumberError,
  mapEstimateDocNumberErrorToResponse,
} from '@/lib/qbo/doc-numbers'

function normalizePhone(value: string | null | undefined) {
  return (value || '').replace(/\D/g, '')
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.convert')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const lead = await prisma.lead.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!lead) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    }

    let estimate: any = null
    let createdClientIdForSync: string | null = null
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const estimateNumber = await allocateNextEstimateNumber({ tenantId: user.tenantId })
        try {
          await assertEstimateNumberAvailableForCreate(user.tenantId, estimateNumber)
        } catch (err) {
          const mapped = mapEstimateDocNumberErrorToResponse(err)
          if (mapped) {
            if (
              err instanceof EstimateDocNumberError &&
              (err.code === 'ESTIMATE_NUMBER_QBO_CONFLICT' || err.code === 'ESTIMATE_NUMBER_LOCAL_CONFLICT')
            ) {
              continue
            }
            return NextResponse.json(mapped.body, { status: mapped.status })
          }
          throw err
        }
        estimate = await prisma.$transaction(async (tx) => {
      let resolvedClientId = lead.convertedToClientId || null

      if (!resolvedClientId) {
        const normalizedEmail = (lead.email || '').trim().toLowerCase()
        const normalizedPhone = normalizePhone(lead.phone)
        const fullName = `${lead.firstName} ${lead.lastName}`.trim()

        const possibleExistingClient = await tx.client.findFirst({
          where: {
            tenantId: user.tenantId,
            OR: [
              ...(normalizedEmail ? [{ email: { equals: normalizedEmail, mode: 'insensitive' as const } }] : []),
              ...(normalizedPhone
                ? [{ phone: { contains: normalizedPhone } }]
                : []),
              {
                AND: [
                  { name: { equals: fullName, mode: 'insensitive' } },
                  ...(lead.company
                    ? [{ companyName: { equals: lead.company, mode: 'insensitive' } }]
                    : []),
                ],
              },
            ],
          },
          orderBy: { updatedAt: 'desc' },
        })

        if (possibleExistingClient) {
          resolvedClientId = possibleExistingClient.id
        } else {
          const createdClient = await tx.client.create({
            data: {
              tenantId: user.tenantId,
              name: fullName,
              companyName: lead.company || null,
              email: lead.email || null,
              phone: lead.phone || null,
              notes: lead.notes || null,
              isActive: true,
            },
          })
          resolvedClientId = createdClient.id
          createdClientIdForSync = createdClient.id
        }

        await tx.lead.update({
          where: { id: lead.id },
          data: {
            convertedToClientId: resolvedClientId,
            convertedAt: lead.convertedAt || new Date(),
          },
        })
      }

      const baseAmount = lead.value ? Number(lead.value) : 0
      const safeAmount = Number.isFinite(baseAmount) ? baseAmount : 0
      const requestName = `${lead.firstName} ${lead.lastName}`.trim()

      const created = await tx.estimate.create({
        data: {
          tenantId: user.tenantId,
          clientId: resolvedClientId,
          leadId: lead.id,
          estimateNumber,
          title: `Estimate for ${requestName}`,
          jobSiteAddress: lead.jobSiteAddress || null,
          status: 'DRAFT',
          subtotal: safeAmount,
          taxRate: 0,
          taxAmount: 0,
          discount: 0,
          total: safeAmount,
          notes: lead.notes || null,
          createdById: user.id,
        },
      })

      await tx.estimateLineItem.create({
        data: {
          estimateId: created.id,
          description: lead.company
            ? `Requested work for ${lead.company}`
            : `Requested work for ${requestName}`,
          quantity: 1,
          unitPrice: safeAmount,
          total: safeAmount,
          sortOrder: 0,
          taxable: true,
        },
      })

      if (lead.status !== 'CONVERTED' && lead.status !== 'ESTIMATE_SENT' && lead.status !== 'ESTIMATE_CREATED') {
        await tx.lead.update({
          where: { id: lead.id },
          data: { status: 'ESTIMATE_CREATED' },
        })
      }

      await tx.activity.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          type: 'ESTIMATE_CREATED',
          description: `Estimate ${estimateNumber} created from request "${requestName}"`,
          leadId: lead.id,
          estimateId: created.id,
          clientId: created.clientId || undefined,
        },
      })

      return created
    })
        break
      } catch (err: any) {
        if (err?.code === 'P2002' && err?.meta?.target?.includes?.('estimateNumber')) {
          continue
        }
        throw err
      }
    }
    if (!estimate) {
      return NextResponse.json({ error: 'Unable to allocate a new estimate number. Please retry.' }, { status: 409 })
    }

    if (createdClientIdForSync) {
      try {
        await enqueueQboSync(user.tenantId, 'client', createdClientIdForSync)
      } catch (error) {
        console.error('QuickBooks client sync trigger error (request convert):', error)
      }
    }

    try {
      await enqueueQboSync(user.tenantId, 'estimate', estimate.id)
    } catch (error) {
      console.error('QuickBooks estimate sync trigger error (lead convert):', error)
    }

    return NextResponse.json({ estimate }, { status: 201 })
  } catch (error) {
    console.error('Convert request to estimate error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
