/**
 * Public branding config endpoint — no authentication required.
 * Consumed by the mobile app at startup to fetch runtime branding.
 *
 * BUILD-TIME branding (requires new native build to change):
 *   - app icon, adaptive icon
 *   - native splash screen image (assets/splash-icon.png)
 *   - app name shown under icon on home screen
 *   - app bundle identifier
 *
 * RUNTIME branding (updates via this endpoint + OTA):
 *   - in-app logos (login screen, header, dashboard)
 *   - in-app colors and theme
 *   - app display name shown inside the app UI
 *   - dynamic splash/loading screen after native splash
 */
import { NextRequest, NextResponse } from 'next/server'
import { getBrandingSettingsForTenant } from '@/lib/branding/settings'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

const DEFAULT_BRANDING = {
  appDisplayName: 'TrimPro Field',
  loginLogoUrl: null as string | null,
  headerLogoUrl: null as string | null,
  primaryColor: '#2E4A59',
  secondaryColor: '#4a7c94',
  accentColor: '#E6C98B',
  buttonColor: '#2E4A59',
  buttonTextColor: '#ffffff',
  sidebarColor: '#2E4A59',
  menuColor: '#E6C98B',
  backgroundColor: '#F5F7FA',
  invoiceLogoUrl: null as string | null,
  emailLogoUrl: null as string | null,
  splashScreenRuntimeImageUrl: null as string | null,
  brandingVersion: 0,
}

export async function GET(request: NextRequest) {
  try {
    const tenantId = request.nextUrl.searchParams.get('tenantId') || ''

    let branding: Record<string, any> | null = null

    if (tenantId) {
      branding = await getBrandingSettingsForTenant(tenantId)
    } else {
      // Find the first (and typically only) tenant for single-tenant deployments.
      const tenant = await (prisma as any).tenant?.findFirst?.({ select: { id: true } })
      if (tenant?.id) {
        branding = await getBrandingSettingsForTenant(tenant.id)
      }
    }

    const ts = (branding as any)?.updatedAt
    const brandingVersion =
      ts instanceof Date
        ? ts.getTime()
        : typeof ts === 'string'
          ? new Date(ts).getTime()
          : typeof ts === 'number'
            ? ts
            : 0

    const config = {
      appDisplayName:
        (branding?.invoiceBusinessName as string | null) ||
        DEFAULT_BRANDING.appDisplayName,
      loginLogoUrl:
        (branding?.webLogoUrl as string | null) || DEFAULT_BRANDING.loginLogoUrl,
      headerLogoUrl:
        (branding?.webLogoUrl as string | null) || DEFAULT_BRANDING.headerLogoUrl,
      primaryColor:
        (branding?.primaryColor as string | null) || DEFAULT_BRANDING.primaryColor,
      secondaryColor:
        (branding?.secondaryColor as string | null) || DEFAULT_BRANDING.secondaryColor,
      accentColor:
        (branding?.menuColor as string | null) || DEFAULT_BRANDING.accentColor,
      buttonColor:
        (branding?.buttonColor as string | null) || DEFAULT_BRANDING.buttonColor,
      buttonTextColor:
        (branding?.buttonTextColor as string | null) || DEFAULT_BRANDING.buttonTextColor,
      sidebarColor:
        (branding?.sidebarColor as string | null) || DEFAULT_BRANDING.sidebarColor,
      menuColor:
        (branding?.menuColor as string | null) || DEFAULT_BRANDING.menuColor,
      backgroundColor:
        (branding?.backgroundColor as string | null) || DEFAULT_BRANDING.backgroundColor,
      invoiceLogoUrl:
        (branding?.invoiceLogoUrl as string | null) || DEFAULT_BRANDING.invoiceLogoUrl,
      emailLogoUrl:
        (branding?.emailLogoUrl as string | null) || DEFAULT_BRANDING.emailLogoUrl,
      splashScreenRuntimeImageUrl:
        (branding?.mobileAppSplashLogoUrl as string | null) || DEFAULT_BRANDING.splashScreenRuntimeImageUrl,
      brandingVersion,
      _note: {
        runtimeBranding: 'Colors, in-app logos, display name update via OTA without a new build.',
        buildTimeBranding: 'App icon, native splash, and app store name require a new native build.',
      },
    }

    return NextResponse.json(config, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (error) {
    console.error('Public branding config error:', error)
    return NextResponse.json(DEFAULT_BRANDING, {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }
}
