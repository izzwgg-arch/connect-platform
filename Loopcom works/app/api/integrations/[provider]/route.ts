import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { encryptSecrets, decryptSecrets } from '@/lib/integrations/secrets'
import { getIntegrationConnection, updateIntegrationStatus } from '@/lib/integrations/status'
import { IntegrationProvider, IntegrationStatus, IntegrationTestResult } from '@/lib/integrations/types'
import { z } from 'zod'
import crypto from 'crypto'
import { getIntegration } from '@/lib/integrations/registry'

// Import test functions for each provider
import { testEmailProvider } from '@/lib/integrations/providers/email'
import { testVoipMsSms } from '@/lib/integrations/providers/voipms'
import { testWhatsApp } from '@/lib/integrations/providers/whatsapp'
import { testQuickBooks } from '@/lib/integrations/providers/quickbooks'
import { testSola } from '@/lib/integrations/providers/sola'

const saveIntegrationSchema = z.object({
  displayName: z.string().optional(),
  secrets: z.record(z.any()),
  metadata: z.record(z.any()).optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: { provider: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const provider = params.provider as IntegrationProvider

  try {
    const connection = await getIntegrationConnection(user.tenantId, provider)

    if (!connection) {
      return NextResponse.json({
        provider,
        status: 'NOT_CONFIGURED' as IntegrationStatus,
        connection: null,
      })
    }

    // Decrypt and mask secrets. IMPORTANT:
    // - We only mask fields that are actually secrets (password fields)
    // - Non-secret fields (like VoIP.ms DID) must remain visible to avoid saving masked values back into the DB.
    let maskedSecrets: Record<string, string> = {}
    let webhookSecret: string | null = null
    if (connection.encryptedSecrets) {
      try {
        const secrets = decryptSecrets(connection.encryptedSecrets)
        const integration = getIntegration(provider)
        const fieldTypeByKey = new Map<string, string>(
          (integration?.configFields || []).map((f: any) => [String(f.key), String(f.type || 'text')])
        )

        // Normalize VoIP.ms DID for display (strip leading country code "1" if present)
        if (provider === 'voipms_sms' && typeof secrets.defaultDid === 'string') {
          const digits = secrets.defaultDid.trim().replace(/\D/g, '')
          secrets.defaultDid =
            digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
        }

        maskedSecrets = Object.fromEntries(
          Object.entries(secrets).map(([key, value]) => {
            // Don't mask webhook secrets - they need to be visible and copyable
            if (key === 'webhookSecret' || key === 'metaVerifyToken') {
              webhookSecret = typeof value === 'string' ? value : null
              return [key, typeof value === 'string' ? value : '']
            }

            // Mask only password fields; return raw values for everything else.
            const fieldType = fieldTypeByKey.get(key)
            const shouldMask = fieldType === 'password'

            if (!shouldMask) {
              return [key, typeof value === 'string' ? value : String(value ?? '')]
            }
            return [
              key,
              typeof value === 'string' && value.length > 4
                ? `••••••${value.slice(-4)}`
                : String(value || ''),
            ]
          })
        )
      } catch (error) {
        // Don't log secrets; keep this generic.
        console.error('Failed to decrypt integration secrets')
      }
    }

    const responseData: any = {
      provider: connection.provider,
      status: connection.status as IntegrationStatus,
      displayName: connection.displayName,
      maskedSecrets,
      metadata: connection.metadata || {},
      lastCheckedAt: connection.lastCheckedAt?.toISOString() || null,
      lastError: connection.lastError,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    }

    // Include unmasked webhook secret for display (only for providers that use it)
    if (provider === 'voipms_sms' || provider === 'sola' || provider === 'whatsapp' || provider === 'webwhatis') {
      if (webhookSecret) {
        responseData.secret = webhookSecret
      }
    }

    return NextResponse.json(responseData)
  } catch (error) {
    console.error('Get integration error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

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

  try {
    const body = await request.json()
    const data = saveIntegrationSchema.parse(body)

    // Get existing connection (used to preserve secrets when the UI submits masked values)
    const existing = await getIntegrationConnection(user.tenantId, provider)

    // Start with incoming secrets
    const secrets: Record<string, any> = { ...data.secrets }

    // If the UI posts masked values like "••••••1234", keep the existing secret instead of overwriting.
    if (existing?.encryptedSecrets) {
      try {
        const existingSecrets = decryptSecrets(existing.encryptedSecrets)
        for (const [key, existingValue] of Object.entries(existingSecrets)) {
          const incomingValue = secrets[key]
          const incomingIsMasked =
            typeof incomingValue === 'string' && incomingValue.trim().startsWith('••')

          if (
            incomingValue === undefined ||
            incomingValue === null ||
            incomingValue === '' ||
            incomingIsMasked
          ) {
            secrets[key] = existingValue
          }
        }
      } catch {
        // If decrypt fails, we can't merge. Don't block saving entirely.
      }
    }

    // Guardrail: never persist masked password placeholders as real secrets.
    // This can happen if the user hits "Save" after a reset/disconnect without re-entering a secret field.
    const integration = getIntegration(provider)
    const passwordKeys = new Set(
      (integration?.configFields || [])
        .filter((f: any) => String(f.type) === 'password')
        .map((f: any) => String(f.key))
    )
    for (const key of passwordKeys) {
      const v = secrets[key]
      if (typeof v === 'string' && v.includes('•')) {
        return NextResponse.json(
          { error: `Please enter the full value for "${key}" (masked value cannot be saved).` },
          { status: 400 }
        )
      }
    }
    
    // Clean and trim VoIP.ms credentials
    if (provider === 'voipms_sms') {
      // Trim whitespace from all fields
      if (typeof secrets.username === 'string') {
        secrets.username = secrets.username.trim()
      }
      if (typeof secrets.apiPassword === 'string') {
        secrets.apiPassword = secrets.apiPassword.trim()
      }
      if (typeof secrets.defaultDid === 'string') {
        // Clean DID - digits only; normalize to 10-digit NANP by stripping leading "1" if present
        const digits = secrets.defaultDid.trim().replace(/\D/g, '')
        secrets.defaultDid = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
      }
    }
    
    if (provider === 'voipms_sms') {
      // VoIP.ms requires the full webhook URL to be configured
      // If webhookSecret doesn't exist or is an old hex string format, generate the URL
      if (!secrets.webhookSecret || (typeof secrets.webhookSecret === 'string' && !secrets.webhookSecret.startsWith('http'))) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || process.env.APP_URL || 'https://app.trimprony.com'
        secrets.webhookSecret = `${baseUrl}/api/webhooks/voipms`
      }
    }
    if (provider === 'whatsapp' && data.secrets.provider === 'meta' && !secrets.metaVerifyToken) {
      secrets.metaVerifyToken = crypto.randomBytes(32).toString('hex')
    }
    if (provider === 'sola' && !secrets.webhookSecret) {
      secrets.webhookSecret = crypto.randomBytes(32).toString('hex')
    }

    // Encrypt secrets
    const encryptedSecrets = encryptSecrets(secrets)

    const connection = existing
      ? await prisma.integrationConnection.update({
          where: { id: existing.id },
          data: {
            displayName: data.displayName || existing.displayName,
            encryptedSecrets,
            metadata: data.metadata || existing.metadata || {},
            status: 'CONNECTED',
            lastCheckedAt: new Date(),
            lastError: null,
          },
        })
      : await prisma.integrationConnection.create({
          data: {
            tenantId: user.tenantId,
            provider,
            displayName: data.displayName || null,
            encryptedSecrets,
            metadata: data.metadata || {},
            status: 'CONNECTED',
            lastCheckedAt: new Date(),
          },
        })

    // Create audit log (optional - don't fail if audit log fails)
    try {
      await prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'CREATE',
          entityType: 'IntegrationConnection',
          entityId: connection.id,
          changes: {
            provider,
            action: 'configured',
          },
        },
      })
    } catch (auditError) {
      console.warn('Failed to create audit log:', auditError)
      // Continue anyway - audit log failure shouldn't block the operation
    }

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        status: connection.status,
      },
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    console.error('Save integration error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { provider: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)
  const provider = params.provider as IntegrationProvider

  try {
    const connection = await getIntegrationConnection(user.tenantId, provider)

    if (!connection) {
      return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
    }

    await prisma.integrationConnection.delete({
      where: { id: connection.id },
    })

    // QuickBooks has legacy token storage in `quickBooksIntegration` used by older code paths.
    // When "resetting" / disconnecting QuickBooks, clear that too.
    if (provider === 'quickbooks') {
      try {
        await prisma.quickBooksIntegration.deleteMany({
          where: { tenantId: user.tenantId },
        })
      } catch (err) {
        console.warn('Failed to delete legacy QuickBooksIntegration row(s):', err)
      }
    }

    // Create audit log (optional - don't fail if audit log fails)
    try {
      await prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'DELETE',
          entityType: 'IntegrationConnection',
          entityId: connection.id,
          changes: {
            provider,
            action: 'disconnected',
          },
        },
      })
    } catch (auditError) {
      console.warn('Failed to create audit log:', auditError)
      // Continue anyway - audit log failure shouldn't block the operation
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete integration error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
