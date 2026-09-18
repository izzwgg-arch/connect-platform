import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import {
  applyCreditMemoToInvoice,
  applyCreditMemoToInvoices,
} from '@/lib/credit-memos/apply-credit'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const batch = Array.isArray(body?.applications) ? body.applications : null

    if (batch) {
      const result = await applyCreditMemoToInvoices({
        tenantId: user.tenantId,
        creditMemoId: params.id,
        applications: batch.map((row: any) => ({
          invoiceId: String(row?.invoiceId || '').trim(),
          amount: Number(row?.amount),
        })),
        userId: user.id,
        notes: body?.notes || null,
      })
      return NextResponse.json(result)
    }

    const invoiceId = String(body?.invoiceId || '').trim()
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'invoiceId or applications[] is required' },
        { status: 400 }
      )
    }

    const result = await applyCreditMemoToInvoice({
      tenantId: user.tenantId,
      creditMemoId: params.id,
      invoiceId,
      amount: body?.amount != null ? Number(body.amount) : null,
      userId: user.id,
      notes: body?.notes || null,
    })

    return NextResponse.json({ message: 'Credit applied successfully', ...result })
  } catch (error: any) {
    console.error('Apply credit memo error:', error)
    const message = error?.message || 'Internal server error'
    const status =
      /not found/i.test(message) ? 404 :
      /cannot|must|no remaining|no open|greater than|before applying|voided|exceeds|select at least|only appear/i.test(message) ? 400 :
      500
    return NextResponse.json({ error: message }, { status })
  }
}
