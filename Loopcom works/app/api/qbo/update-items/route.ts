import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'

function normalizeText(value: any): string {
  return String(value || '').trim()
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const session = await getQboSessionForTenant(user.tenantId)
    if (!session) {
      return NextResponse.json({ error: 'QuickBooks integration not configured' }, { status: 400 })
    }

    const integration = await prisma.quickBooksIntegration.findUnique({
      where: { tenantId: user.tenantId },
      select: { id: true, isConnected: true },
    })
    if (!integration?.id || !integration.isConnected) {
      return NextResponse.json({ error: 'QuickBooks integration not configured' }, { status: 400 })
    }

    // Only update already-mapped items (no duplicates).
    const maps = await prisma.quickBooksSyncLog.findMany({
      where: {
        integrationId: integration.id,
        type: 'item',
        status: 'success',
        qboId: { not: null },
        entityId: { not: null },
      },
      select: { qboId: true, entityId: true },
      orderBy: { createdAt: 'asc' },
    })
    if (maps.length === 0) {
      return NextResponse.json({ message: 'No QuickBooks-mapped items found to update', updated: 0 })
    }

    // Build a QBO Id -> { name, description } map, but only keep rows with a non-empty Description.
    const qboDescById = new Map<string, { name: string; description: string }>()
    for (let start = 1; start <= 10000; start += 1000) {
      const query = `select * from Item startposition ${start} maxresults 1000`
      const res = await quickBooksService.query(session.accessToken, session.realmId, query)
      const items = res?.QueryResponse?.Item || []
      if (!items.length) break

      for (const it of items) {
        const qboId = normalizeText(it?.Id)
        if (!qboId) continue
        const name = normalizeText(it?.Name || it?.FullyQualifiedName)
        // In QBO, some accounts populate SalesDesc/PurchaseDesc instead of Description.
        const description = normalizeText(it?.Description || it?.SalesDesc || it?.PurchaseDesc)
        if (!description) continue // Only update items that have a description in QBO.
        qboDescById.set(qboId, { name, description })
      }
    }

    let updated = 0
    let skippedNoQboDescription = 0
    let skippedAlreadyHasDescription = 0
    let skippedMissingLocal = 0

    for (const row of maps) {
      const qboId = normalizeText(row.qboId)
      const localId = normalizeText(row.entityId)
      if (!qboId || !localId) continue

      const qbo = qboDescById.get(qboId)
      if (!qbo?.description) {
        skippedNoQboDescription++
        continue
      }

      const local = await prisma.item.findFirst({
        where: { id: localId, tenantId: user.tenantId },
        select: { id: true, description: true },
      })
      if (!local) {
        skippedMissingLocal++
        continue
      }

      const localDesc = normalizeText(local.description)
      if (localDesc && localDesc !== 'Imported from QuickBooks historical import') {
        skippedAlreadyHasDescription++
        continue
      }

      await prisma.item.update({
        where: { id: local.id },
        data: {
          description: qbo.description.slice(0, 5000),
        },
      })
      updated++
    }

    return NextResponse.json({
      message: `Updated ${updated} item(s)`,
      updated,
      skipped: {
        noQboDescription: skippedNoQboDescription,
        alreadyHadDescription: skippedAlreadyHasDescription,
        missingLocalItem: skippedMissingLocal,
      },
    })
  } catch (error: any) {
    console.error('[QBO Update Items] error:', error)
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 500 })
  }
}

