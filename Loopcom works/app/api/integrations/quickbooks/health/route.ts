import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getIntegrationConnection, updateIntegrationStatus } from '@/lib/integrations/status'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'
import { prisma } from '@/lib/prisma'
import { createNotificationsForUsers } from '@/lib/notifications'

function safeDate(raw: any): Date | null {
  if (!raw) return null
  const d = raw instanceof Date ? raw : new Date(String(raw))
  return Number.isNaN(d.getTime()) ? null : d
}

const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === '1'

  const connection = await getIntegrationConnection(user.tenantId, 'quickbooks' as any)
  if (!connection) {
    return NextResponse.json({ connected: false, ok: false, reason: 'not_configured' })
  }

  const lastCheckedAt = connection.lastCheckedAt ? new Date(connection.lastCheckedAt) : null
  const tooSoon = !force && lastCheckedAt && Date.now() - lastCheckedAt.getTime() < TWENTY_HOURS_MS

  if (tooSoon) {
    return NextResponse.json({
      connected: connection.status === 'CONNECTED',
      ok: connection.status === 'CONNECTED' && !connection.lastError,
      cached: true,
      lastCheckedAt: lastCheckedAt?.toISOString() || null,
      lastError: connection.lastError || null,
    })
  }

  try {
    const session = await getQboSessionForTenant(user.tenantId)
    if (!session) {
      await updateIntegrationStatus(user.tenantId, 'quickbooks' as any, 'NOT_CONFIGURED' as any, 'QuickBooks not connected')
      return NextResponse.json({ connected: false, ok: false, reason: 'not_connected' })
    }

    const companyInfo = await quickBooksService.getCompanyInfo(session.accessToken, session.realmId, {
      tenantId: user.tenantId,
      entityType: 'company_info',
      entityId: session.realmId,
      triggerSource: force ? 'qbo_health_check_forced' : 'qbo_health_check',
    })

    await updateIntegrationStatus(user.tenantId, 'quickbooks' as any, 'CONNECTED' as any, null, {
      qboHealth: {
        ok: true,
        checkedAt: new Date().toISOString(),
        companyName: companyInfo?.CompanyName || null,
        realmId: session.realmId,
      },
    })

    return NextResponse.json({
      connected: true,
      ok: true,
      checkedAt: new Date().toISOString(),
      companyName: companyInfo?.CompanyName || null,
      realmId: session.realmId,
    })
  } catch (error: any) {
    const errMsg = String(error?.message || 'QuickBooks health check failed')

    // Update status + metadata (and throttle notifications)
    const meta = (typeof connection.metadata === 'object' && connection.metadata) ? (connection.metadata as any) : {}
    const qboHealthMeta = meta?.qboHealth || {}
    const lastNotifiedAt = safeDate(qboHealthMeta?.lastNotifiedAt)
    const lastNotifiedError = typeof qboHealthMeta?.lastNotifiedError === 'string' ? qboHealthMeta.lastNotifiedError : null
    const shouldNotify =
      !lastNotifiedAt ||
      Date.now() - lastNotifiedAt.getTime() > TWENTY_HOURS_MS ||
      (lastNotifiedError && lastNotifiedError !== errMsg)

    await updateIntegrationStatus(user.tenantId, 'quickbooks' as any, 'ERROR' as any, errMsg, {
      qboHealth: {
        ok: false,
        checkedAt: new Date().toISOString(),
        ...(shouldNotify
          ? {
              lastNotifiedAt: new Date().toISOString(),
              lastNotifiedError: errMsg,
            }
          : {}),
      },
    })

    if (shouldNotify) {
      const recipients = await prisma.user.findMany({
        where: {
          tenantId: user.tenantId,
          role: { in: ['ADMIN', 'ACCOUNTING', 'OFFICE'] },
          status: 'ACTIVE',
        },
        select: { id: true },
      })

      if (recipients.length) {
        await createNotificationsForUsers(user.tenantId, recipients.map((u) => u.id), {
          type: 'OTHER',
          title: 'QuickBooks needs attention',
          message:
            errMsg.length > 260
              ? `${errMsg.slice(0, 260)}...`
              : errMsg,
          linkUrl: '/dashboard/settings/integrations/quickbooks',
          linkType: 'integration',
          linkId: 'quickbooks',
          requiresAck: true,
        })
      }
    }

    return NextResponse.json(
      {
        connected: true,
        ok: false,
        error: errMsg,
        checkedAt: new Date().toISOString(),
      },
      { status: 200 }
    )
  }
}

