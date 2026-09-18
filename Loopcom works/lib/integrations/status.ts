/**
 * Integration Status Management
 */

import { prisma } from '@/lib/prisma'
import { IntegrationProvider, IntegrationStatus, IntegrationConfig } from './types'
import { decryptSecrets } from './secrets'

/**
 * Get integration connection for a tenant
 */
export async function getIntegrationConnection(
  tenantId: string,
  provider: IntegrationProvider
) {
  try {
    if (!prisma || !prisma.integrationConnection) {
      console.error('Prisma client not initialized or IntegrationConnection model missing')
      return null
    }
    return await prisma.integrationConnection.findUnique({
      where: {
        tenantId_provider: {
          tenantId,
          provider,
        },
      },
    })
  } catch (error) {
    console.error('Error getting integration connection:', error)
    return null
  }
}

/**
 * Get all integration connections for a tenant
 */
export async function getIntegrationConnections(tenantId: string) {
  try {
    if (!prisma || !prisma.integrationConnection) {
      console.error('Prisma client not initialized or IntegrationConnection model missing')
      return []
    }
    return await prisma.integrationConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    })
  } catch (error) {
    console.error('Error getting integration connections:', error)
    return []
  }
}

/**
 * Update integration status
 */
export async function updateIntegrationStatus(
  tenantId: string,
  provider: IntegrationProvider,
  status: IntegrationStatus,
  error?: string | null,
  metadata?: Record<string, any>
) {
  const existing = await getIntegrationConnection(tenantId, provider)

  if (existing) {
    return await prisma.integrationConnection.update({
      where: { id: existing.id },
      data: {
        status,
        lastError: error || null,
        lastCheckedAt: new Date(),
        metadata: metadata ? { ...(existing.metadata as any || {}), ...metadata } : undefined,
      },
    })
  }

  return await prisma.integrationConnection.create({
    data: {
      tenantId,
      provider,
      status,
      lastError: error || null,
      lastCheckedAt: new Date(),
      metadata: metadata || {},
    },
  })
}

/**
 * Get decrypted secrets for an integration
 */
export async function getIntegrationSecrets(
  tenantId: string,
  provider: IntegrationProvider
): Promise<Record<string, any> | null> {
  const connection = await getIntegrationConnection(tenantId, provider)

  if (!connection || !connection.encryptedSecrets) {
    return null
  }

  try {
    const secrets = decryptSecrets(connection.encryptedSecrets)
    
    // Clean VoIP.ms DID when retrieving (in case it was saved with formatting before the fix)
    if (provider === 'voipms_sms' && secrets.defaultDid && typeof secrets.defaultDid === 'string') {
      const digits = secrets.defaultDid.trim().replace(/\D/g, '')
      secrets.defaultDid = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    }
    
    return secrets
  } catch (error) {
    console.error(`Failed to decrypt secrets for ${provider}:`, error)
    return null
  }
}
