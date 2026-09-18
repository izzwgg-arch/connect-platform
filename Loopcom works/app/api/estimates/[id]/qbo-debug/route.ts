import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { qboEstimateReadEndpoint } from '@/lib/services/qbo-sync'
import { quickBooksService } from '@/lib/services/quickbooks'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const syncLog = await prisma.quickBooksSyncLog.findFirst({
    where: { entityId: params.id, type: 'estimate' },
    orderBy: { id: 'desc' },
    select: { qboId: true, integrationId: true },
  })
  if (!syncLog?.qboId) return NextResponse.json({ error: 'No QBO mapping' }, { status: 404 })

  const session = await getQboSessionForTenant(user!.tenantId)
  if (!session) return NextResponse.json({ error: 'Not connected' }, { status: 503 })

  const res = await quickBooksService.makeAPIRequest(
    session.accessToken,
    session.realmId,
    qboEstimateReadEndpoint(syncLog.qboId),
    'GET',
    undefined,
    { tenantId: user!.tenantId, entityType: 'estimate', entityId: syncLog.qboId, triggerSource: 'debug' }
  )

  const lines = res?.Estimate?.Line || []
  return NextResponse.json({
    qboId: syncLog.qboId,
    totalLines: lines.length,
    lines: lines.map((l: any, i: number) => ({
      i,
      DetailType: l.DetailType,
      Amount: l.Amount,
      Description: l.Description,
      ItemRefName: l?.SalesItemLineDetail?.ItemRef?.name,
      ItemRefValue: l?.SalesItemLineDetail?.ItemRef?.value,
      Qty: l?.SalesItemLineDetail?.Qty,
      UnitPrice: l?.SalesItemLineDetail?.UnitPrice,
    })),
  })
}
