import { NextRequest, NextResponse } from 'next/server'
import { quickBooksService } from '@/lib/services/quickbooks'
import { prisma } from '@/lib/prisma'

// Force dynamic rendering for this route (uses searchParams)
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const realmId = searchParams.get('realmId')
    const error = searchParams.get('error')

    if (error) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard/settings/quickbooks?error=${error}`
      )
    }

    if (!code || !realmId) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard/settings/quickbooks?error=missing_parameters`
      )
    }

    // Decode state to get tenant ID
    const stateData = Buffer.from(state || '', 'base64').toString('utf-8')
    const [tenantId] = stateData.split(':')

    if (!tenantId) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard/settings/quickbooks?error=invalid_state`
      )
    }

    // Exchange code for tokens
    const tokens = await quickBooksService.exchangeCodeForTokens(code)

    // Calculate token expiry
    const tokenExpiresAt = new Date()
    tokenExpiresAt.setSeconds(tokenExpiresAt.getSeconds() + tokens.expires_in)

    // Get company info
    let companyName = 'QuickBooks Company'
    try {
      const companyInfo = await quickBooksService.getCompanyInfo(tokens.access_token, realmId)
      companyName = companyInfo.CompanyName || companyName
    } catch (error) {
      console.error('Failed to fetch company info:', error)
      // Continue anyway
    }

    // Create or update integration
    await prisma.quickBooksIntegration.upsert({
      where: { tenantId },
      create: {
        tenantId,
        isConnected: true,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt,
        realmId,
      },
      update: {
        isConnected: true,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt,
        realmId,
        lastSyncStatus: 'Connected',
      },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'UPDATE',
        entityType: 'QuickBooksIntegration',
        changes: {
          action: 'connected',
          companyName,
        },
      },
    })

    // Redirect to settings page
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard/settings/quickbooks?success=true`
    )
  } catch (error: any) {
    console.error('QuickBooks callback error:', error)
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard/settings/quickbooks?error=${encodeURIComponent(error.message || 'connection_failed')}`
    )
  }
}
