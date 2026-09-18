import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { rateLimitOrThrow } from '@/lib/security/rate-limit'
import { createAchPaymentSession } from '@/lib/qbo/payments-ach'
import { requireRecaptchaV3 } from '@/lib/security/recaptcha'
import { syncInvoiceToQuickBooks } from '@/lib/services/qbo-sync'

export const runtime = 'nodejs'

const bodySchema = z.object({
  token: z.string().min(1),
  recaptchaToken: z.string().optional(),
  targetInvoiceId: z.string().optional(),
  returnUrl: z.string().url().optional(),
})

function withQboReturnHints(hostedUrl: string, returnUrl?: string): string {
  const raw = String(hostedUrl || '').trim()
  const ret = String(returnUrl || '').trim()
  if (!raw || !ret) return raw
  try {
    const cancelRet = ret.includes('result=success') ? ret.replace('result=success', 'result=cancel') : ret
    const failedRet = ret.includes('result=success') ? ret.replace('result=success', 'result=failed') : ret
    const u = new URL(raw)
    // QBO hosted pages may honor one of these depending on product/version.
    u.searchParams.set('redirect_uri', ret)
    u.searchParams.set('return_url', ret)
    u.searchParams.set('success_url', ret)
    u.searchParams.set('cancel_url', cancelRet)
    u.searchParams.set('failure_url', failedRet)
    return u.toString()
  } catch {
    return raw
  }
}

/**
 * Public endpoint: create/return a QuickBooks ACH hosted payment URL for a tokenized invoice.
 * - Validates `invoice.paymentToken` (unguessable token in email link)
 * - Does NOT expose any secrets
 * - Redirect flow is hosted by QuickBooks (we do not handle bank details)
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    try {
      rateLimitOrThrow(request, { key: 'public-qbo-ach-link', limit: 40, windowMs: 60_000 })
    } catch (res: any) {
      return res
    }

    // Read the body exactly once; some runtimes/proxies behave badly if the stream is consumed twice.
    const raw = await request.text().catch(() => '')
    let bodyJson: any = null
    try {
      bodyJson = raw ? JSON.parse(raw) : null
    } catch {
      bodyJson = null
    }

    const parsed = bodySchema.safeParse(bodyJson)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    const token = String(parsed.data.token || '').trim()
    const targetInvoiceId = String(parsed.data.targetInvoiceId || params.id).trim()
    const captcha = await requireRecaptchaV3({
      request,
      token: parsed.data.recaptchaToken,
      expectedAction: 'public_invoice_pay_ach',
    })
    if (captcha) {
      // IMPORTANT: do not read captcha.json() before returning it; that locks the stream and breaks the response.
      // If you need to log details, clone() the response first.
      try {
        const errorData = await captcha.clone().json()
        console.error('[QBO ACH] reCAPTCHA verification failed:', errorData)
      } catch {
        console.error('[QBO ACH] reCAPTCHA verification failed')
      }
      return captcha
    }

    // Authorize: the token must belong to *some* invoice; then allow paying any invoice for the same client.
    const authInvoice = await prisma.invoice.findFirst({
      where: { paymentToken: token },
      select: { tenantId: true, clientId: true },
    })
    if (!authInvoice) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const invoice = await prisma.invoice.findFirst({
      where: {
        id: targetInvoiceId,
        tenantId: authInvoice.tenantId,
        clientId: authInvoice.clientId,
      },
      select: {
        id: true,
        tenantId: true,
        balance: true,
        qboSyncId: true,
      },
    })

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (Number(invoice.balance) <= 0) {
      return NextResponse.json({ error: 'Invoice already paid' }, { status: 400 })
    }
    if (!invoice.qboSyncId) {
      // Best-effort: try to sync on-demand. This is safe because the request is authorized by a valid
      // payment token + reCAPTCHA and is scoped to the same tenant/client.
      try {
        await syncInvoiceToQuickBooks(invoice.tenantId, invoice.id)
      } catch (e) {
        // syncInvoiceToQuickBooks swallows/logs internally, but keep this guard in case it changes.
        console.error('[QBO ACH] On-demand invoice sync threw:', e)
      }

      const refreshed = await prisma.invoice.findFirst({
        where: {
          id: invoice.id,
          tenantId: authInvoice.tenantId,
          clientId: authInvoice.clientId,
        },
        select: { qboSyncId: true },
      })

      if (!refreshed?.qboSyncId) {
        return NextResponse.json(
          {
            error:
              'Invoice is not synced to QuickBooks yet. Please sync the invoice first (or wait a moment and try again).',
          },
          { status: 400 }
        )
      }
    }

    const result = await createAchPaymentSession({
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      createdById: null,
    })

    return NextResponse.json({
      hostedUrl: withQboReturnHints(result.hostedUrl, result.returnUrl || parsed.data.returnUrl),
      publicUrl: result.publicUrl,
      intentId: result.intentId,
      attempt: result.returnToken,
      returnUrl: result.returnUrl,
    })
  } catch (err: any) {
    console.error('[QBO ACH] Unhandled error in qbo-ach-link route:', {
      invoiceId: params.id,
      error: err?.message || String(err),
      stack: err?.stack,
    })
    return NextResponse.json({ error: err?.message || 'Unable to create ACH link' }, { status: 500 })
  }
}

