/**
 * npx tsx scripts/sync-qb-balances.ts
 *
 * Uses the same session helper and sync logic as the UI button, so the
 * token is properly refreshed via the encrypted IntegrationConnection secrets.
 */
import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'

function toMoney(n: number) { return Math.round(n * 100) / 100 }

async function main() {
  // Find the connected QB integration to get tenantId
  const integration = await prisma.quickBooksIntegration.findFirst({
    where: { isConnected: true },
    select: { tenantId: true },
  })
  if (!integration) {
    console.error('No connected QB integration found')
    process.exit(1)
  }

  const { tenantId } = integration
  console.log('Tenant:', tenantId)

  // Use proper session helper (handles token refresh automatically)
  const session = await getQboSessionForTenant(tenantId)
  if (!session) {
    console.error('Could not get QB session — token may be expired. Reconnect QB in Settings → Integrations.')
    process.exit(1)
  }
  console.log('Realm:', session.realmId)

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      qboSyncId: { not: null },
      balance: { gt: 0 },
      status: { in: ['SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'] },
    },
    select: { id: true, qboSyncId: true, balance: true, total: true, paidAmount: true, status: true, invoiceNumber: true },
    orderBy: { balance: 'desc' },
  })

  console.log(`\nChecking ${invoices.length} open invoices against QuickBooks…\n`)

  let synced = 0, skipped = 0, errors = 0
  const changes: Array<{ inv: string; local: number; qbo: number; applied: number }> = []

  for (const invoice of invoices) {
    try {
      const data = await quickBooksService.makeAPIRequest(
        session.accessToken, session.realmId, `/invoice/${invoice.qboSyncId}`, 'GET'
      )
      const qboInv = data?.Invoice
      if (!qboInv) { console.log(`  [SKIP] #${invoice.invoiceNumber} — not found in QB`); skipped++; continue }

      const qboBalance = Number(qboInv.Balance ?? qboInv.BalanceAmt ?? NaN)
      if (!Number.isFinite(qboBalance)) { skipped++; continue }

      const localBalance = Number(invoice.balance)
      const delta = toMoney(localBalance - qboBalance)

      if (delta <= 0) { skipped++; continue }

      console.log(`  [SYNC] #${invoice.invoiceNumber}  local=$${localBalance.toFixed(2)}  QB=$${qboBalance.toFixed(2)}  delta=$${delta.toFixed(2)}`)

      const reference = `qbo_bulksync_${invoice.qboSyncId}_${qboBalance.toFixed(2)}`
      const existing = await prisma.payment.findFirst({ where: { reference } })
      if (existing) { console.log(`         already synced`); skipped++; continue }

      await prisma.$transaction(async (tx) => {
        const current = await tx.invoice.findUnique({
          where: { id: invoice.id },
          select: { id: true, total: true, paidAmount: true, balance: true, status: true, paidAt: true },
        })
        if (!current || Number(current.balance) <= 0) return

        const appliedAmount = Math.min(Number(current.balance), delta)
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
            notes: 'QuickBooks balance sync (script)',
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

        changes.push({ inv: invoice.invoiceNumber, local: localBalance, qbo: qboBalance, applied: appliedAmount })
      })

      synced++
    } catch (e: any) {
      if (e?.code === 'P2002') { skipped++; continue }
      console.error(`  [ERR] #${invoice.invoiceNumber}: ${e?.message}`)
      errors++
    }
  }

  console.log('\n=== SYNC COMPLETE ===')
  console.log(`Checked:  ${invoices.length}`)
  console.log(`Synced:   ${synced}`)
  console.log(`Skipped:  ${skipped} (already correct)`)
  console.log(`Errors:   ${errors}`)

  if (changes.length) {
    console.log('\nInvoices updated:')
    changes.forEach(c =>
      console.log(`  #${c.inv}  was=$${c.local.toFixed(2)}  QB=$${c.qbo.toFixed(2)}  applied=$${c.applied.toFixed(2)}`)
    )
  }

  // Final count
  const remaining = await prisma.invoice.count({
    where: { tenantId, balance: { gt: 0 }, status: { in: ['SENT','VIEWED','PARTIAL','OVERDUE'] } }
  })
  console.log(`\nOpen invoices in TrimPro after sync: ${remaining}`)
}

main().catch(e => { console.error(e.message); process.exit(1) }).finally(() => prisma.$disconnect())
