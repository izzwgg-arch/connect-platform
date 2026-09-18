import { prisma } from '@/lib/prisma'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { encryptSecrets } from '@/lib/integrations/secrets'
import { quickBooksService } from '@/lib/services/quickbooks'

export type QboSession = {
  tenantId: string
  realmId: string
  accessToken: string
  refreshToken: string
}

function parseExpiresAt(raw: any): Date | null {
  if (!raw) return null
  const d = raw instanceof Date ? raw : new Date(String(raw))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Resolve tenant-scoped QBO tokens from IntegrationConnection('quickbooks').
 * Auto-refresh access token if expired and persist refreshed tokens.
 */
export async function getQboSessionForTenant(tenantId: string): Promise<QboSession | null> {
  // Prefer the encrypted IntegrationConnection storage.
  const secrets = await getIntegrationSecrets(tenantId, 'quickbooks' as any)
  if (!secrets?.refreshToken || !secrets?.realmId) {
    return null
  }

  const realmId = String(secrets.realmId)
  const refreshToken = String(secrets.refreshToken)
  let accessToken = String(secrets.accessToken || '')
  const expiresAt = parseExpiresAt(secrets.tokenExpiresAt)

  const isExpired = expiresAt ? expiresAt.getTime() <= Date.now() + 30_000 : false
  if (!accessToken || isExpired) {
    // Use saved clientId/clientSecret from IntegrationConnection if available
    const clientId = secrets?.clientId || null
    const clientSecret = secrets?.clientSecret || null
    const refreshed = await quickBooksService.refreshAccessToken(
      refreshToken,
      clientId || undefined,
      clientSecret || undefined,
      {
        tenantId,
        entityType: 'oauth_token',
        triggerSource: 'qbo_session_refresh',
      }
    )
    accessToken = refreshed.access_token
    const newRefresh = refreshed.refresh_token || refreshToken
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000)

    // Persist back into IntegrationConnection encryptedSecrets, preserving existing keys.
    const merged = {
      ...secrets,
      accessToken: refreshed.access_token,
      refreshToken: newRefresh,
      tokenExpiresAt: newExpiresAt.toISOString(),
    }

    const encryptedSecrets = encryptSecrets(merged)
    await prisma.integrationConnection.update({
      where: { tenantId_provider: { tenantId, provider: 'quickbooks' } },
      data: {
        encryptedSecrets,
        status: 'CONNECTED',
        lastCheckedAt: new Date(),
        lastError: null,
        metadata: {
          ...(typeof (secrets as any).metadata === 'object' ? (secrets as any).metadata : {}),
          realmId,
          refreshedAt: new Date().toISOString(),
        },
      },
    })

    // Backwards compatibility (older code paths still read from quickBooksIntegration).
    await prisma.quickBooksIntegration.upsert({
      where: { tenantId },
      create: {
        tenantId,
        isConnected: true,
        realmId,
        accessToken,
        refreshToken: newRefresh,
        tokenExpiresAt: newExpiresAt,
      },
      update: {
        isConnected: true,
        realmId,
        accessToken,
        refreshToken: newRefresh,
        tokenExpiresAt: newExpiresAt,
      },
    })

    return { tenantId, realmId, accessToken, refreshToken: newRefresh }
  }

  return { tenantId, realmId, accessToken, refreshToken }
}

export function assertQuickBooksAchEnabledFlag() {
  const enabled = String(process.env.QUICKBOOKS_ACH_ENABLED || '').toLowerCase()
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') {
    throw new Error('QuickBooks ACH is not enabled (set QUICKBOOKS_ACH_ENABLED=true).')
  }
}

