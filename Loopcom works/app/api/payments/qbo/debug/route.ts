import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.manage')
  if (permError) return permError

  const user = getAuthUser(request)

  const webhookEvents = await prisma.webhookEvent.findMany({
    where: {
      tenantId: user.tenantId,
      provider: 'quickbooks',
    },
    orderBy: { receivedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      eventId: true,
      eventType: true,
      receivedAt: true,
      processedAt: true,
      processed: true,
      error: true,
      payloadHash: true,
    },
  })

  const payments = await prisma.payment.findMany({
    where: {
      invoice: { tenantId: user.tenantId },
      provider: 'quickbooks',
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      invoiceId: true,
      amount: true,
      status: true,
      providerPaymentId: true,
      providerInvoiceId: true,
      receiptEmailSentAt: true,
      receiptEmailAttempts: true,
      receiptEmailError: true,
      updatedAt: true,
    },
  })

  return NextResponse.json({ webhookEvents, payments })
}
