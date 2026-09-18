import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { brandingResetSchema } from '@/lib/validation'
import { resetBrandingSectionForTenant } from '@/lib/branding/settings'

const VALID_SECTIONS = new Set(['ui', 'logos', 'invoice', 'email'])

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const payload = await request.json().catch(() => ({}))
    const parsed = brandingResetSchema.safeParse(payload)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid section payload' }, { status: 400 })
    }

    const section = parsed.data.section
    if (!section || !VALID_SECTIONS.has(section)) {
      return NextResponse.json({ error: 'Section must be one of: ui, logos, invoice, email' }, { status: 400 })
    }

    const branding = await resetBrandingSectionForTenant(user.tenantId, section as 'ui' | 'logos' | 'invoice' | 'email')
    return NextResponse.json({ branding })
  } catch (error) {
    console.error('Reset branding section error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

