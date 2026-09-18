import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireWebOrMobilePermission } from '@/lib/authorization'
import { isValidEmail, splitEmailList } from '@/lib/email'
import {
  generatePaymentReceiptPdf,
  sendPaymentReceiptForPayment,
} from '@/lib/payments/receipts'

async function assertReceiptAccess(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return { error: authError }

  const permError = await requireWebOrMobilePermission(
    request,
    'payments.view',
    'mobile.jobs.view_documents'
  )
  if (permError) return { error: permError }

  const user = getAuthUser(request)
  return { user }
}

function parseRecipientEmails(body: any): string[] {
  const fromEmails = Array.isArray(body?.emails)
    ? body.emails.flatMap((value: unknown) => splitEmailList(String(value || '')))
    : splitEmailList(body?.emails)
  const fromEmail = splitEmailList(body?.email)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const email of [...fromEmails, ...fromEmail]) {
    const trimmed = String(email || '').trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const access = await assertReceiptAccess(request)
  if ('error' in access && access.error) return access.error
  const { user } = access

  try {
    const result = await generatePaymentReceiptPdf(params.id, user.tenantId)
    if (!result) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('Payment receipt download error:', error)
    return NextResponse.json({ error: 'Failed to generate receipt PDF' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const access = await assertReceiptAccess(request)
  if ('error' in access && access.error) return access.error
  const { user } = access

  try {
    const body = await request.json().catch(() => ({}))
    const emails = parseRecipientEmails(body)

    if (emails.length === 0) {
      return NextResponse.json({ error: 'No recipient email address provided' }, { status: 400 })
    }

    const invalid = emails.find((email) => !isValidEmail(email))
    if (invalid) {
      return NextResponse.json({ error: `Invalid email address: ${invalid}` }, { status: 400 })
    }

    const result = await sendPaymentReceiptForPayment(params.id, user.tenantId, {
      emails,
      forceResend: true,
    })

    if (result.reason === 'payment_not_found') {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }
    if (result.reason === 'missing_email') {
      return NextResponse.json({ error: 'No recipient email address provided' }, { status: 400 })
    }
    if (!result.sent) {
      const message =
        result.error ||
        (result.reason === 'send_failed'
          ? 'Failed to send receipt email'
          : result.reason === 'already_sent'
            ? 'Receipt was already sent for this payment'
            : 'Failed to send receipt email')
      const status = result.error?.includes('not configured') ? 400 : 502
      return NextResponse.json({ error: message }, { status })
    }

    return NextResponse.json({
      ok: true,
      sentTo: result.sentTo,
      receiptUrl: result.receiptUrl,
    })
  } catch (error) {
    console.error('Payment receipt email error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
