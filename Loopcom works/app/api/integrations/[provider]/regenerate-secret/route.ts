import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { encryptSecrets, decryptSecrets } from '@/lib/integrations/secrets'
import { getIntegrationConnection } from '@/lib/integrations/status'
import { IntegrationProvider } from '@/lib/integrations/types'
import crypto from 'crypto'

export async function POST(
  request: NextRequest,
  { params }: { params: { provider: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)
  const provider = params.provider as IntegrationProvider

  // Only allow regenerate for providers that use webhook secrets
  if (provider !== 'voipms_sms' && provider !== 'sola' && provider !== 'whatsapp') {
    return NextResponse.json({ error: 'Secret regeneration not supported for this provider' }, { status: 400 })
  }

  try {
    const connection = await getIntegrationConnection(user.tenantId, provider)
    if (!connection || !connection.encryptedSecrets) {
      return NextResponse.json({ error: 'Integration not found or not configured' }, { status: 404 })
    }

    // Decrypt existing secrets
    const secrets = decryptSecrets(connection.encryptedSecrets)

    // Generate new webhook secret
    let newSecret: string
    if (provider === 'voipms_sms') {
      // VoIP.ms requires the full webhook URL to be configured
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || process.env.APP_URL || 'https://app.trimprony.com'
      newSecret = `${baseUrl}/api/webhooks/voipms`
    } else {
      newSecret = crypto.randomBytes(32).toString('hex')
    }
    secrets.webhookSecret = newSecret

    // If WhatsApp meta provider, also regenerate verify token
    if (provider === 'whatsapp' && secrets.provider === 'meta') {
      secrets.metaVerifyToken = crypto.randomBytes(32).toString('hex')
    }

    // Encrypt and save
    const encryptedSecrets = encryptSecrets(secrets)

    await prisma.integrationConnection.update({
      where: { id: connection.id },
      data: {
        encryptedSecrets,
        lastCheckedAt: new Date(),
        lastError: null,
      },
    })

    // Create audit log
    try {
      await prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entityType: 'IntegrationConnection',
          entityId: connection.id,
          changes: {
            provider,
            action: 'VOIPMS_WEBHOOK_SECRET_REGENERATED',
          },
        },
      })
    } catch (auditError) {
      // Don't fail if audit log fails
    }

    // Return the new secret (will be encrypted in transit via HTTPS)
    return NextResponse.json({
      success: true,
      secret: newSecret, // Only return this once - frontend must copy it immediately
    })
  } catch (error: any) {
    // Never log the secret
    console.error('Failed to regenerate secret:', error.message || 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to regenerate secret. Please try again.' },
      { status: 500 }
    )
  }
}
