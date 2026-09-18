import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { allocateNextEstimateNumber } from '@/lib/qbo/doc-numbers'

/**
 * Returns the next estimate number that would be used if the client leaves
 * "Estimate #" blank on create. Local TrimPro only (no QuickBooks API).
 * QBO DocNumber is checked once on POST /api/estimates at save time.
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  // Shown as a preview on the estimate-create page — accept create/edit, not just view.
  const permError = await requireAnyPermission(request, [
    'estimates.view',
    'estimates.create',
    'estimates.edit',
  ])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const estimateNumber = await allocateNextEstimateNumber({ tenantId: user.tenantId })
    return NextResponse.json({ estimateNumber })
  } catch (error: any) {
    console.error('GET /api/estimates/next-number:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to determine next estimate number' },
      { status: 500 }
    )
  }
}
