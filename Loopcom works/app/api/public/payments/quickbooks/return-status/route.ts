import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  reconcileSingleInvoiceAchPayment,
  shouldAttemptPublicInvoiceReconcile,
} from '@/lib/qbo/reconcile-ach'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const attempt = String(request.nextUrl.searchParams.get('attempt') || '').trim()
  if (!attempt) {
    return NextResponse.json({ error: 'Missing attempt token' }, { status: 400 })
  }

  const intent = await prisma.invoicePaymentIntent.findFirst({
    where: {
      returnToken: attempt,
      provider: 'qbo',
      method: 'ach',
    },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          balance: true,
          status: true,
        },
      },
    },
  })

  if (!intent || !intent.invoice) {
    return NextResponse.json({ error: 'Invalid payment attempt token' }, { status: 404 })
  }

  if (intent.returnTokenExpiresAt && intent.returnTokenExpiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'Payment attempt token expired' }, { status: 410 })
  }

  await prisma.invoicePaymentIntent.update({
    where: { id: intent.id },
    data: { returnTokenUsedAt: intent.returnTokenUsedAt || new Date() },
  })

  // Pull payment state from QuickBooks when webhook delivery is delayed or missing.
  try {
    if (await shouldAttemptPublicInvoiceReconcile(intent.invoice.id)) {
      await reconcileSingleInvoiceAchPayment(intent.invoice.id, {
        source: 'qbo_return_status_poll',
      })
    }
  } catch (e) {
    console.error('[QBO ACH] Reconcile on return-status failed:', e)
  }

  const freshIntent = await prisma.invoicePaymentIntent.findUnique({
    where: { id: intent.id },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          balance: true,
          status: true,
        },
      },
    },
  })
  const invoiceRow = freshIntent?.invoice || intent.invoice

  const payment = await prisma.payment.findFirst({
    where: {
      invoiceId: intent.invoice.id,
      provider: 'quickbooks',
      status: 'COMPLETED',
    },
    orderBy: { processedAt: 'desc' },
    select: {
      id: true,
      amount: true,
      processedAt: true,
      providerPaymentId: true,
      receiptToken: true,
      receiptTokenExpiresAt: true,
      receiptEmailSentAt: true,
    },
  })

  const invoiceBalance = Number(invoiceRow.balance || 0)
  const intentStatus = String(freshIntent?.status || intent.status)
  const isPaid = invoiceBalance <= 0 || intentStatus === 'SUCCEEDED'
  const isFailed = ['FAILED', 'CANCELLED'].includes(intentStatus)
  const finalState = isPaid ? 'confirmed' : isFailed ? 'failed' : 'pending'
  const appUrl = (
    process.env.PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.CANONICAL_PUBLIC_APP_URL ||
    'https://app.trimprony.com'
  ).replace(/\/+$/, '')

  return NextResponse.json({
    finalState,
    intentStatus,
    invoice: {
      id: invoiceRow.id,
      invoiceNumber: invoiceRow.invoiceNumber,
      status: invoiceRow.status,
      total: Number(invoiceRow.total || 0),
      balance: invoiceBalance,
    },
    payment: payment
      ? {
          id: payment.id,
          amount: Number(payment.amount || 0),
          processedAt: payment.processedAt?.toISOString() || null,
          providerPaymentId: payment.providerPaymentId || null,
          receiptEmailSentAt: payment.receiptEmailSentAt?.toISOString() || null,
          receiptUrl: payment.receiptToken ? `${appUrl}/pay/receipt/${encodeURIComponent(payment.receiptToken)}` : null,
        }
      : null,
  })
}
