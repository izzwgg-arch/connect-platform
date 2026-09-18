import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { quickBooksService } from '@/lib/services/quickbooks'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    // Check if already connected
    const existing = await prisma.quickBooksIntegration.findUnique({
      where: { tenantId: user.tenantId },
    })

    if (existing && existing.isConnected) {
      return NextResponse.json({
        message: 'QuickBooks already connected',
        connected: true,
      })
    }

    // Generate state token (CSRF protection)
    const state = Buffer.from(`${user.tenantId}:${Date.now()}`).toString('base64')

    // Store state temporarily (in production, use Redis or database)
    // For now, we'll include it in the redirect URL

    const authUrl = quickBooksService.getAuthorizationUrl(state)

    return NextResponse.json({
      authUrl,
      state,
    })
  } catch (error) {
    console.error('QuickBooks auth error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
