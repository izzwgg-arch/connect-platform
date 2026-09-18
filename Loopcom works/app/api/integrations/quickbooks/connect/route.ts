import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { decryptSecrets } from '@/lib/integrations/secrets'

const QBO_BASE_URL = 'https://appcenter.intuit.com/connect/oauth2'

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

  return { clientId, clientSecret, redirectUri }
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)
  const cfg = await getQuickBooksConfig(user.tenantId)

  if (!cfg.clientId || !cfg.clientSecret) {
    return NextResponse.json(
      { error: 'QuickBooks credentials are missing. Save Client ID and Client Secret in Configuration first.' },
      { status: 400 }
    )
  }

  // Generate state token for CSRF protection
  const state = crypto.randomBytes(32).toString('hex')

  // Store state in session/cookie (simplified - in production use secure session)
  // For now, include tenant ID in state
  const stateWithTenant = `${state}:${user.tenantId}`

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    state: stateWithTenant,
  })

  const authUrl = `${QBO_BASE_URL}?${params.toString()}`

  // Check if request wants JSON (from client-side fetch with Authorization header)
  const acceptHeader = request.headers.get('accept') || ''
  if (acceptHeader.includes('application/json')) {
    return NextResponse.json({ authUrl, state })
  }

  // Otherwise redirect directly (for direct browser navigation)
  return NextResponse.redirect(authUrl)
}
