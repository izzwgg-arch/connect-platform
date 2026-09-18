import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getAchStatusByInvoice } from '@/lib/qbo/payments-ach'

const querySchema = z.object({
  invoiceId: z.string().min(1),
})

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({ invoiceId: url.searchParams.get('invoiceId') })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing invoiceId' }, { status: 400 })
  }

  try {
    const result = await getAchStatusByInvoice({ tenantId: user.tenantId, invoiceId: parsed.data.invoiceId })
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to fetch status' }, { status: 400 })
  }
}

