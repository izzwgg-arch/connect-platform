/**
 * npx tsx scripts/diagnose-qb-count.ts
 *
 * Fetches all open invoices directly from QuickBooks (Balance > 0)
 * and compares the count vs. TrimPro to identify what's different.
 */
import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'

async function main() {
  const integration = await prisma.quickBooksIntegration.findFirst({
    where: { isConnected: true },
    select: { tenantId: true },
  })
  if (!integration) { console.error('No connected QB integration'); process.exit(1) }

  const { tenantId } = integration
  const session = await getQboSessionForTenant(tenantId)
  if (!session) { console.error('Cannot get QB session'); process.exit(1) }

  console.log('Querying QuickBooks for ALL invoices with Balance > 0…')
  
  // QB QBQL: query all invoices with a remaining balance
  let allQbOpen: any[] = []
  for (let start = 1; start <= 10000; start += 1000) {
    const query = `select Id, DocNumber, Balance, TotalAmt, TxnDate, CustomerRef from Invoice where Balance > '0' startposition ${start} maxresults 1000`
    const res = await quickBooksService.query(session.accessToken, session.realmId, query)
    const batch = res?.QueryResponse?.Invoice || []
    allQbOpen = allQbOpen.concat(batch)
    if (batch.length < 1000) break
  }

  console.log(`\nQuickBooks open invoices (Balance > 0): ${allQbOpen.length}`)

  // TrimPro open invoices
  const trimproOpen = await prisma.invoice.findMany({
    where: {
      tenantId,
      balance: { gt: 0 },
      status: { in: ['SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'] },
    },
    select: { id: true, qboSyncId: true, invoiceNumber: true, balance: true, total: true, status: true },
  })
  console.log(`TrimPro open invoices (balance > 0): ${trimproOpen.length}`)
  console.log(`Discrepancy: ${trimproOpen.length - allQbOpen.length}`)

  // Build QB id set for fast lookup
  const qbIds = new Set(allQbOpen.map((inv: any) => String(inv.Id)))
  const qbIdToInv = new Map(allQbOpen.map((inv: any) => [String(inv.Id), inv]))

  // Find TrimPro invoices NOT in QB open list
  const notInQb = trimproOpen.filter(i => i.qboSyncId && !qbIds.has(i.qboSyncId))
  const noQboId  = trimproOpen.filter(i => !i.qboSyncId)

  console.log(`\nTrimPro open but NOT in QB open list: ${notInQb.length + noQboId.length}`)
  if (notInQb.length > 0) {
    console.log('\nTrimPro invoices with QB id but NOT showing as open in QB:')
    notInQb.slice(0, 20).forEach(i => {
      console.log(`  #${i.invoiceNumber}  balance=$${Number(i.balance).toFixed(2)}  status=${i.status}  qboId=${i.qboSyncId}`)
    })
    if (notInQb.length > 20) console.log(`  ... and ${notInQb.length - 20} more`)
  }
  if (noQboId.length > 0) {
    console.log(`\nTrimPro open invoices with NO qboSyncId (created directly in TrimPro): ${noQboId.length}`)
  }

  // Find QB open invoices NOT in TrimPro
  const trimproQboIds = new Set(trimproOpen.map(i => i.qboSyncId).filter(Boolean))
  const inQbNotTrimpro = allQbOpen.filter((inv: any) => !trimproQboIds.has(String(inv.Id)))
  console.log(`\nQB open invoices NOT in TrimPro at all: ${inQbNotTrimpro.length}`)
  if (inQbNotTrimpro.length > 0) {
    console.log('(These are in QB but never imported into TrimPro)')
    inQbNotTrimpro.slice(0, 10).forEach((inv: any) => {
      console.log(`  QB #${inv.DocNumber || inv.Id}  balance=$${Number(inv.Balance).toFixed(2)}  customer=${inv.CustomerRef?.name || '?'}`)
    })
    if (inQbNotTrimpro.length > 10) console.log(`  ... and ${inQbNotTrimpro.length - 10} more`)
  }

  console.log('\n=== SUMMARY ===')
  console.log(`QB open count:       ${allQbOpen.length}`)
  console.log(`TrimPro open count:  ${trimproOpen.length}`)
  console.log(`Extra in TrimPro:    ${notInQb.length + noQboId.length} (open in TrimPro, not in QB open list)`)
  console.log(`Missing in TrimPro:  ${inQbNotTrimpro.length} (open in QB, not imported to TrimPro)`)
}

main().catch(e => { console.error(e.message); process.exit(1) }).finally(() => prisma.$disconnect())
