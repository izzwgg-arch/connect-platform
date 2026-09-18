import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { reimportEstimateLines } from '@/lib/services/qbo-sync'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const result = await reimportEstimateLines(user!.tenantId, params.id)
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    console.error('Reimport estimate lines error:', err)
    const msg = String(err?.message || '')
    if (msg.includes('not connected') || msg.includes('not imported') || msg.includes('no QBO mapping')) {
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    if (msg.includes('not found') || msg.includes('deleted or made inactive')) {
      return NextResponse.json({ error: msg }, { status: 404 })
    }
    return NextResponse.json({ error: msg || 'Failed to re-import line items.' }, { status: 500 })
  }
}
