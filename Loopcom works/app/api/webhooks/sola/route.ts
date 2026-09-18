import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { verifySolaWebhookSignature } from '@/lib/integrations/providers/sola'
import { notifyInvoicePaid } from '@/lib/notifications'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { afterInvoicePayment } from '@/lib/payments/after-invoice-payment'
import { applyInvoicePayment } from '@/lib/payments/apply-payment'

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    let body: Record<string, any> = {}
    try {
      body = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      const params = new URLSearchParams(rawBody)
      body = Object.fromEntries(params.entries())
    }
    const signature = request.headers.get('x-sola-signature') || ''

    // Find Sola integration to get webhook secret
    const solaConnections = await prisma.integrationConnection.findMany({
      where: { provider: 'sola', status: 'CONNECTED' },
    })

    if (solaConnections.length === 0) {
      return NextResponse.json({ error: 'Sola integration not configured' }, { status: 404 })
    }

    // Use first connection (in production, match by merchant ID or tenant)
    const connection = solaConnections[0]
    const secrets = await getIntegrationSecrets(connection.tenantId, 'sola')
    const webhookSecret = secrets?.webhookSecret

    if (webhookSecret && signature) {
      // Verify signature only when the provider includes one.
      const payload = JSON.stringify(body)
      const isValid = verifySolaWebhookSignature(payload, signature, webhookSecret)
      if (!isValid) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    }

    const event = body?.event || 'payment'
    const paymentId = body?.paymentId || body?.xRefnum || body?.xRefNum || body?.TransactionID || ''
    const invoiceId = body?.invoiceId || body?.xInvoice || body?.InvoiceID || ''
    const amount = Number(body?.amount || body?.xAmount || 0)
    const status = String(body?.status || body?.xResult || '').toLowerCase()
    const transactionId =
      body?.transactionId || body?.xRefnum || body?.xRefNum || body?.TransactionID || paymentId
    const timestamp = body?.timestamp || new Date().toISOString()

    // Use tenant from connection
    const tenantId = connection.tenantId

    // Find invoice by metadata or invoiceId
    const invoice = await prisma.invoice.findFirst({
      where: {
        tenantId,
        OR: [{ id: String(invoiceId) }, { invoiceNumber: String(invoiceId) }],
      },
      include: {
        tenant: true,
        client: true,
      },
    })

    if (!invoice) {
      console.error('Invoice not found for SOLA webhook:', invoiceId)
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const isSuccess =
      status === 'completed' || status === 'paid' || status === 'approved' || status === 's' || status === 'a'
    if (!isSuccess) {
      // Only update the stored status on an existing record; never move money.
      const existingPayment = await prisma.payment.findFirst({
        where: { solaTransactionId: String(transactionId || paymentId || '') },
        select: { id: true },
      })
      if (existingPayment) {
        await prisma.payment.update({
          where: { id: existingPayment.id },
          data: {
            status: status === 'pending' ? 'PENDING' : status === 'failed' ? 'FAILED' : 'PENDING',
            solaWebhookData: body,
          },
        })
        return NextResponse.json({ message: 'Payment updated' })
      }
      return NextResponse.json({ ok: true, ignored: true })
    }

    const txnId = String(transactionId || paymentId || '')

    // Idempotency across BOTH webhook routes. The modern /api/webhooks/sola-payment
    // route records single-invoice payments as "txn" and distributed (multi-invoice)
    // payments as "txn:invoiceId". Matching either prefix here guarantees this legacy
    // endpoint can never create a duplicate / phantom payment for a transaction the
    // modern route already handled (or vice versa).
    if (txnId) {
      const already = await prisma.payment.findFirst({
        where: {
          OR: [
            { solaTransactionId: txnId },
            { solaTransactionId: { startsWith: `${txnId}:` } },
            { provider: 'sola', providerPaymentId: txnId },
            { provider: 'sola', providerPaymentId: { startsWith: `${txnId}:` } },
          ],
        },
        select: { id: true },
      })
      if (already) return NextResponse.json({ message: 'Payment already recorded', deduped: true })
    }

    // Never invent an amount. A success confirmation with no amount must not move money.
    if (!(amount > 0)) {
      return NextResponse.json({ ok: true, ignored: 'missing_amount' })
    }

    // All money application goes through the single authoritative, idempotent,
    // clamped function — identical to every other payment path.
    const result = await applyInvoicePayment({
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      amount,
      method: 'CARD',
      provider: 'sola',
      providerPaymentId: txnId,
      providerInvoiceId: String(invoiceId || invoice.invoiceNumber || ''),
      reference: txnId || null,
      solaTransactionId: txnId || null,
      solaWebhookData: body,
      processedAt: new Date(timestamp),
      dedupeWhere: txnId ? { solaTransactionId: txnId } : undefined,
    })

    if (!result.created || !result.paymentId || !result.invoice) {
      return NextResponse.json({ message: 'Payment already recorded' })
    }

    const appliedAmount = Math.max(0, Number(result.invoice.paidAmount) - Number(invoice.paidAmount))

    try {
      await enqueueQboSync(invoice.tenantId, 'payment', result.paymentId, { processImmediately: true })
    } catch (error) {
      console.error('QuickBooks payment sync trigger error (legacy webhook):', error)
    }

    await prisma.activity
      .create({
        data: {
          tenantId: invoice.tenantId,
          type: 'PAYMENT_RECEIVED',
          description: `Payment of ${appliedAmount} received for invoice ${invoice.invoiceNumber}`,
          invoiceId: invoice.id,
          paymentId: result.paymentId,
          clientId: invoice.clientId,
        },
      })
      .catch(() => undefined)

    await notifyInvoicePaid(
      invoice.tenantId,
      invoice.id,
      invoice.invoiceNumber,
      appliedAmount,
      invoice.client.name,
      {
        paymentMethod: 'CARD',
        providerPaymentId: txnId || null,
        dedupeKey: `payment-received:${invoice.tenantId}:${invoice.id}:${txnId || invoice.id}`,
      }
    )

    await afterInvoicePayment(invoice.id).catch((error) => {
      console.error('[sola-legacy-webhook] afterInvoicePayment failed:', { invoiceId: invoice.id, error })
    })

    return NextResponse.json({ message: 'Webhook processed successfully' })
  } catch (error) {
    console.error('SOLA webhook error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// GET endpoint for webhook verification (if SOLA requires it)
export async function GET(request: NextRequest) {
  return NextResponse.json({ message: 'SOLA webhook endpoint' })
}
