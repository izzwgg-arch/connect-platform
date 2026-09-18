import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { requireSameOrigin } from '@/lib/security/csrf'
import { rateLimitOrThrow } from '@/lib/security/rate-limit'
import { createAchPaymentSession } from '@/lib/qbo/payments-ach'

const bodySchema = z.object({
  invoiceId: z.string().min(1),
})

export async function POST(request: NextRequest) {
  const csrf = requireSameOrigin(request)
  if (csrf) return csrf

  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.manage')
  if (permError) return permError

  try {
    rateLimitOrThrow(request, { key: 'qbo-ach-create-session', limit: 30, windowMs: 60_000 })
  } catch (res: any) {
    return res
  }

  const user = getAuthUser(request)

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 })
  }

  try {
    const result = await createAchPaymentSession({
      tenantId: user.tenantId,
      invoiceId: parsed.data.invoiceId,
      createdById: user.id,
    })
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to create ACH session' }, { status: 400 })
  }
}

