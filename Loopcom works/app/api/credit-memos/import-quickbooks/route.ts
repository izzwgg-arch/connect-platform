import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { importQuickBooksCreditMemos } from '@/lib/credit-memos/import-from-qbo'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const result = await importQuickBooksCreditMemos(user.tenantId)
    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (error: any) {
    console.error('QBO credit memo import error:', error)
    return NextResponse.json(
      { error: error?.message || 'QuickBooks credit memo import failed' },
      { status: 500 }
    )
  }
}
