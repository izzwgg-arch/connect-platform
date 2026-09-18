import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { resetAllBrandingSettingsForTenant } from '@/lib/branding/settings'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const branding = await resetAllBrandingSettingsForTenant(user.tenantId)
    return NextResponse.json({ branding })
  } catch (error) {
    console.error('Reset branding error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

