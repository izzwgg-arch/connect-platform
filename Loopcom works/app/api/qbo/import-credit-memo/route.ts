import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { importQuickBooksCreditMemoById } from '@/lib/credit-memos/import-from-qbo'

function toClientError(message: string) {
  const normalized = String(message || '')
  const lower = normalized.toLowerCase()

  if (lower.includes('must be a numeric value')) {
    return { status: 400, error: 'QuickBooks credit memo ID must be a number (e.g. 1482).' }
  }

  const txnMismatch = normalized.match(
    /TxnType does not match read:\s*([^|]+)\s*expected:\s*CreditMemo/i
  )
  if (txnMismatch) {
    const actualType = txnMismatch[1]?.trim() || 'another transaction type'
    return {
      status: 400,
      error: `That ID belongs to a ${actualType} in QuickBooks, not a Credit Memo. Open QuickBooks → Sales → Credit Memos, open the credit memo, and copy the number from the URL (e.g. …/app/creditmemo?txnId=1234 → enter 1234).`,
    }
  }

  if (lower.includes('made inactive') || lower.includes('code=610')) {
    return {
      status: 404,
      error:
        'This QuickBooks credit memo has been deleted or made inactive in QuickBooks. Only active credit memos can be imported.',
    }
  }

  if (
    lower.includes('not found') ||
    lower.includes('status=404') ||
    lower.includes('object not found')
  ) {
    return { status: 404, error: 'QuickBooks credit memo not found. Double-check the ID.' }
  }

  if (lower.includes('not connected') || lower.includes('refresh token') || lower.includes('access token')) {
    return { status: 503, error: normalized || 'QuickBooks connection is unavailable.' }
  }

  if (lower.includes('no customer')) {
    return { status: 400, error: normalized }
  }

  return { status: 500, error: normalized || 'Credit memo import failed.' }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const qboCreditMemoId = String(body?.qboCreditMemoId || '').trim()

    if (!qboCreditMemoId) {
      return NextResponse.json({ error: 'QuickBooks credit memo ID is required.' }, { status: 400 })
    }

    const result = await importQuickBooksCreditMemoById(user.tenantId, qboCreditMemoId)

    if (result.alreadyImported) {
      return NextResponse.json(
        {
          success: false,
          alreadyImported: true,
          error: 'This QuickBooks credit memo has already been imported.',
          creditMemo: result.creditMemo,
        },
        { status: 409 }
      )
    }

    return NextResponse.json({
      success: true,
      alreadyImported: false,
      creditMemo: result.creditMemo,
      placeholderClientCreated: result.placeholderClientCreated,
      placeholderClient: result.placeholderClient,
    })
  } catch (error: any) {
    console.error('QuickBooks credit memo import by ID error:', error)
    const mapped = toClientError(error?.message || 'Credit memo import failed.')
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
}
