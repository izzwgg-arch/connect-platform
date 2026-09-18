import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

async function localEntityExists(type: string, entityId: string | null): Promise<boolean> {
  if (!entityId) return true
  if (type === 'estimate') return Boolean(await prisma.estimate.findUnique({ where: { id: entityId }, select: { id: true } }))
  if (type === 'invoice') return Boolean(await prisma.invoice.findUnique({ where: { id: entityId }, select: { id: true } }))
  if (type === 'payment') return Boolean(await prisma.payment.findUnique({ where: { id: entityId }, select: { id: true } }))
  if (type === 'client') return Boolean(await prisma.client.findUnique({ where: { id: entityId }, select: { id: true } }))
  if (type === 'vendor') return Boolean(await prisma.vendor.findUnique({ where: { id: entityId }, select: { id: true } }))
  if (type === 'purchase_order') return Boolean(await prisma.purchaseOrder.findUnique({ where: { id: entityId }, select: { id: true } }))
  if (type === 'project' || type === 'job') return Boolean(await prisma.job.findUnique({ where: { id: entityId }, select: { id: true } }))
  if (type === 'lead') return Boolean(await prisma.lead.findUnique({ where: { id: entityId }, select: { id: true } }))
  return true
}

/**
 * GET /api/qbo/sync-failures
 *
 * Returns recent QuickBooks sync failures for the current tenant.
 * Admin-only.
 *
 * Query params:
 *   since  – ISO timestamp; only return failures created after this time.
 *            Defaults to 24 hours ago.
 *   limit  – max rows to return (default 20)
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const { searchParams } = new URL(request.url)
    const sinceParam = searchParams.get('since')
    const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') || 20)))

    const since = sinceParam
      ? new Date(sinceParam)
      : new Date(Date.now() - 24 * 60 * 60 * 1000)

    // Find the integration for this tenant
    const integration = await prisma.quickBooksIntegration.findUnique({
      where: { tenantId: user.tenantId },
      select: { id: true },
    })

    if (!integration) {
      return NextResponse.json({ failures: [], total: 0 })
    }

    // Fetch recent terminal rows, then only surface a failure if the newest
    // row for that entity is still an error. A later success clears stale alerts.
    const rows = await prisma.quickBooksSyncLog.findMany({
      where: {
        integrationId: integration.id,
        status: { in: ['error', 'success'] },
        createdAt: { gt: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 200, // over-fetch then deduplicate
      select: {
        id: true,
        type: true,
        action: true,
        entityId: true,
        error: true,
        status: true,
        createdAt: true,
      },
    })

    // Keep only the newest row per (type + entityId) to avoid spamming
    const seen = new Set<string>()
    const deduped: typeof rows = []
    for (const row of rows) {
      const key = `${row.type}:${row.entityId ?? '__none__'}`
      if (!seen.has(key)) {
        seen.add(key)
        if (row.status === 'error' && await localEntityExists(row.type, row.entityId)) {
          deduped.push(row)
          if (deduped.length >= limit) break
        }
      }
    }

    const failures = deduped.map((row) => ({
      id: row.id,
      type: row.type,
      action: row.action,
      entityId: row.entityId,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    }))

    return NextResponse.json({ failures, total: failures.length })
  } catch (error: any) {
    console.error('QBO sync-failures fetch error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
