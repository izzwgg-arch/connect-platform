import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const integration = await prisma.quickBooksIntegration.findUnique({
      where: { tenantId: user.tenantId },
      include: {
        syncLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    })

    if (!integration) {
      return NextResponse.json({
        connected: false,
        message: 'Not connected',
      })
    }

    return NextResponse.json({
      connected: integration.isConnected,
      realmId: integration.realmId,
      lastSyncAt: integration.lastSyncAt,
      lastSyncStatus: integration.lastSyncStatus,
      lastSyncError: integration.lastSyncError,
      autoSync: integration.autoSync,
      accountMapping: {
        incomeAccountId: integration.incomeAccountId,
        taxAccountId: integration.taxAccountId,
        clearingAccountId: integration.clearingAccountId,
        discountAccountId: integration.discountAccountId,
      },
      syncLogs: integration.syncLogs,
    })
  } catch (error) {
    console.error('Get QuickBooks status error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
