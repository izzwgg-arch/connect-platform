import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'
import { afterInvoicePayment } from '@/lib/payments/after-invoice-payment'

export const dynamic = 'force-dynamic'

function toMoney(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * POST /api/integrations/quickbooks/sync-balances
 *
 * Fetches the current balance for every TrimPro invoice that has a qboSyncId
 * and a non-zero local balance, then reconciles any discrepancy.
 * Run this once to bring existing invoices in sync with QuickBooks.
 */
export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const session = await getQboSessionForTenant(user.tenantId)
  if (!session) {
    return NextResponse.json({ error: 'QuickBooks not connected' }, { status: 400 })
  }

  // Fetch all invoices for this tenant that have a QB sync ID and a positive balance.
  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: user.tenantId,
      qboSyncId: { not: null },
      balance: { gt: 0 },
      status: { in: ['SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'] },
    },
    select: { id: true, qboSyncId: true, balance: true, total: true, paidAmount: true, status: true, paidAt: true, invoiceNumber: true },
  })

  let synced = 0
  let skipped = 0
  let errors = 0
  const changes: Array<{ invoiceNumber: string; localBalance: number; qboBalance: number; applied: number }> = []

  for (const invoice of invoices) {
    try {
      const qboRes = await quickBooksService.makeAPIRequest(
        session.accessToken,
        session.realmId,
        `/invoice/${invoice.qboSyncId}`,
        'GET',
        undefined,
        {
          tenantId: user.tenantId,
          entityType: 'invoice',
          entityId: invoice.id,
          triggerSource: 'admin_sync_balances',
        }
      )
      const qboInvoice = qboRes?.Invoice
      const qboBalance = Number(qboInvoice?.Balance ?? qboInvoice?.BalanceAmt ?? NaN)
      if (!Number.isFinite(qboBalance)) { skipped++; continue }

      const localBalance = Number(invoice.balance)
      const delta = toMoney(localBalance - qboBalance)
      if (delta <= 0) { skipped++; continue }

      // Apply the delta as a reconcile payment
      const reference = `qbo_bulksync_${invoice.qboSyncId}_${qboBalance.toFixed(2)}`
      const existing = await prisma.payment.findFirst({ where: { reference } })
      if (existing) { skipped++; continue }

      const appliedAmount = Math.min(localBalance, delta)

      await prisma.$transaction(async (tx) => {
        const current = await tx.invoice.findUnique({
          where: { id: invoice.id },
          select: { id: true, total: true, paidAmount: true, balance: true, status: true, paidAt: true },
        })
        if (!current || Number(current.balance) <= 0) return

        await tx.payment.create({
          data: {
            invoiceId: current.id,
            amount: appliedAmount,
            status: 'COMPLETED',
            method: 'OTHER',
            reference,
            provider: 'quickbooks',
            providerPaymentId: reference,
            providerInvoiceId: invoice.qboSyncId!,
            providerRealmId: session.realmId,
            processedAt: new Date(),
            notes: 'QuickBooks balance sync',
          },
        })

        const newPaidAmount = Number(current.paidAmount) + appliedAmount
        const newBalance = Math.max(0, toMoney(Number(current.total) - newPaidAmount))

        await tx.invoice.update({
          where: { id: current.id },
          data: {
            paidAmount: newPaidAmount,
            balance: newBalance,
            status: newBalance <= 0 ? 'PAID' : newPaidAmount > 0 ? 'PARTIAL' : current.status,
            paidAt: newBalance <= 0 ? new Date() : current.paidAt,
          },
        })
      })

      changes.push({
        invoiceNumber: invoice.invoiceNumber,
        localBalance,
        qboBalance,
        applied: appliedAmount,
      })
      synced++

      await afterInvoicePayment(invoice.id).catch((error) => {
        console.error('[sync-balances] afterInvoicePayment failed:', { invoiceId: invoice.id, error })
      })
    } catch (e: any) {
      if (e?.code !== 'P2002') {
        console.error('[QB sync-balances] Error on invoice', invoice.id, e?.message)
        errors++
      } else {
        skipped++ // race duplicate — safe to skip
      }
    }
  }

  return NextResponse.json({
    ok: true,
    totalInvoicesChecked: invoices.length,
    synced,
    skipped,
    errors,
    changes,
  })
}
