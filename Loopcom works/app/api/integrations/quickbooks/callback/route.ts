import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { decryptSecrets, encryptSecrets } from '@/lib/integrations/secrets'
import { updateIntegrationStatus } from '@/lib/integrations/status'
import { logQuickBooksApiUsage } from '@/lib/services/quickbooks'

const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'

function resolveAppUrl(request: NextRequest): string {
  // Prefer the current request origin (matches the actual domain the user is on).
  // Avoid redirecting to raw IPs/localhost from stale env values (breaks browser callbacks).
  const candidates = [
    request.nextUrl.origin,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    'https://app.trimprony.com',
  ]

  const blocked = /(localhost|127\.0\.0\.1|0\.0\.0\.0|154\.12\.235\.86)(:\d+)?/i

  for (const candidate of candidates) {
    const value = String(candidate || '').trim().replace(/\/+$/, '')
    if (!value) continue
    if (blocked.test(value)) continue
    return value
  }

  return 'https://app.trimprony.com'
}

function redirectToApp(request: NextRequest, pathWithQuery: string) {
  const base = resolveAppUrl(request)
  return NextResponse.redirect(new URL(pathWithQuery, base))
}

async function getQuickBooksConfig(tenantId: string) {
  const connection = await prisma.integrationConnection.findUnique({
    where: {
      tenantId_provider: {
        tenantId,
        provider: 'quickbooks',
      },
    },
  })

  let saved: Record<string, any> = {}
  if (connection?.encryptedSecrets) {
    try {
      saved = decryptSecrets(connection.encryptedSecrets)
    } catch (error) {
      console.error('Failed to decrypt saved QuickBooks secrets')
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000'
  const clientId = saved.clientId || process.env.QBO_CLIENT_ID || ''
  const clientSecret = saved.clientSecret || process.env.QBO_CLIENT_SECRET || ''
  const redirectUri = saved.redirectUri || process.env.QBO_REDIRECT_URI || `${appUrl}/api/integrations/quickbooks/callback`
  const environment = saved.environment || process.env.QBO_ENV || 'production'

  return { clientId, clientSecret, redirectUri, environment, connection, saved }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const realmId = searchParams.get('realmId')
  const error = searchParams.get('error')

  if (error) {
    return redirectToApp(request, `/dashboard/settings/integrations/quickbooks?error=${encodeURIComponent(error)}`)
  }

  if (!code || !state || !realmId) {
    return redirectToApp(
      request,
      `/dashboard/settings/integrations/quickbooks?error=${encodeURIComponent('Missing required parameters')}`
    )
  }

  try {
    // Extract tenant ID from state
    const [stateToken, tenantId] = state.split(':')
    if (!tenantId) {
      throw new Error('Invalid state token')
    }

    const cfg = await getQuickBooksConfig(tenantId)
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('QuickBooks credentials missing. Save Client ID and Client Secret first.')
    }

    // Exchange authorization code for tokens
    const startedAt = Date.now()
    const tokenResponse = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'TrimPro/1.0 (+https://app.trimprony.com)',
        'Authorization': `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
      }),
    })

    const intuitTid =
      tokenResponse.headers.get('intuit_tid') ||
      tokenResponse.headers.get('intuit-tid') ||
      tokenResponse.headers.get('x-intuit-tid') ||
      null
    const contentType = tokenResponse.headers.get('content-type') || ''

    const raw = await tokenResponse.text()
    logQuickBooksApiUsage({
      tenantId,
      realmId,
      endpoint: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      entityType: 'oauth_token',
      entityId: null,
      triggerSource: 'oauth_callback',
      httpStatus: tokenResponse.status,
      success: tokenResponse.ok,
      retryCount: null,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      intuitTid,
    })
    let tokenData: any = null
    try {
      tokenData = raw ? JSON.parse(raw) : {}
    } catch {
      // Intuit sometimes returns an HTML error page when credentials/redirect_uri are wrong.
      const snippet = String(raw || '')
        .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
        .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[redacted]"')
        .replace(/\s+/g, ' ')
        .slice(0, 220)
      const tidPart = intuitTid ? ` intuit_tid=${intuitTid}` : ''
      const ctPart = contentType ? ` content-type=${contentType}` : ''
      throw new Error(
        `Token exchange failed: Unexpected response from Intuit (status=${tokenResponse.status}${ctPart}${tidPart}). Snippet: ${snippet || '[empty]'}`
      )
    }

    if (!tokenResponse.ok) {
      const detail =
        tokenData?.error_description ||
        tokenData?.error ||
        tokenData?.message ||
        raw?.slice?.(0, 300) ||
        'Unknown error'
      const tidPart = intuitTid ? ` (intuit_tid: ${intuitTid})` : ''
      throw new Error(`Token exchange failed: ${detail}${tidPart}`)
    }
    const { access_token, refresh_token, expires_in } = tokenData

    // Encrypt and store tokens
    const secrets = {
      ...cfg.saved,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
      environment: cfg.environment,
      refreshToken: refresh_token,
      realmId,
      accessToken: access_token,
      tokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null,
    }

    const encryptedSecrets = encryptSecrets(secrets)

    // Save to IntegrationConnection
    await prisma.integrationConnection.upsert({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'quickbooks',
        },
      },
      create: {
        tenantId,
        provider: 'quickbooks',
        status: 'CONNECTED',
        encryptedSecrets,
        metadata: {
          realmId,
          connectedAt: new Date().toISOString(),
        },
        lastCheckedAt: new Date(),
      },
      update: {
        status: 'CONNECTED',
        encryptedSecrets,
        metadata: {
          realmId,
          connectedAt: new Date().toISOString(),
        },
        lastCheckedAt: new Date(),
        lastError: null,
      },
    })

    // Also update QuickBooksIntegration table for backwards compatibility (store plaintext tokens)
    await prisma.quickBooksIntegration.upsert({
      where: { tenantId },
      create: {
        tenantId,
        isConnected: true,
        refreshToken: refresh_token,
        accessToken: access_token,
        tokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
        realmId,
      },
      update: {
        isConnected: true,
        refreshToken: refresh_token,
        accessToken: access_token,
        tokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
        realmId,
      },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'CREATE',
        entityType: 'IntegrationConnection',
        changes: {
          provider: 'quickbooks',
          action: 'connected',
        },
      },
    })

    return redirectToApp(request, '/dashboard/settings/integrations/quickbooks?success=connected')
  } catch (error: any) {
    console.error('QuickBooks callback error:', error)
    return redirectToApp(
      request,
      `/dashboard/settings/integrations/quickbooks?error=${encodeURIComponent(error.message || 'Connection failed')}`
    )
  }
}
