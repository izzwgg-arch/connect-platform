/**
 * One-time repair: replace the auto-generated billing summary text in
 * invoice line item notes with the actual notes from the source estimate line item.
 *
 * Affected rows: InvoiceLineItem where notes starts with "Full price: $"
 * Strategy: match via InvoiceLineItemSource (invoiceId → estimateLineItemId)
 *           and description equality.
 *
 * Run:  node scripts/fix-invoice-notes.mjs
 *       node scripts/fix-invoice-notes.mjs --dry-run
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const dryRun = process.argv.includes('--dry-run')

async function main() {
  console.log(dryRun ? '[DRY RUN] ' : '', 'Scanning for invoice line items with billing summary notes...')

  // Find every invoice line item with the old generated notes text.
  const bad = await prisma.invoiceLineItem.findMany({
    where: {
      notes: { startsWith: 'Full price: $' },
    },
    select: { id: true, invoiceId: true, description: true, notes: true },
  })

  console.log(`Found ${bad.length} affected line item(s).`)
  if (bad.length === 0) { process.exit(0) }

  // Group by invoiceId so we only query InvoiceLineItemSource once per invoice.
  const byInvoice = new Map()
  for (const row of bad) {
    if (!byInvoice.has(row.invoiceId)) byInvoice.set(row.invoiceId, [])
    byInvoice.get(row.invoiceId).push(row)
  }

  let fixed = 0
  let cleared = 0
  let skipped = 0

  for (const [invoiceId, rows] of byInvoice) {
    // Get all estimate line items that were the source for this invoice.
    const sources = await prisma.invoiceLineItemSource.findMany({
      where: { invoiceId },
      select: {
        estimateLineItemId: true,
      },
    })

    if (sources.length === 0) {
      // No source mapping — just null out the generated text.
      for (const row of rows) {
        if (!dryRun) {
          await prisma.invoiceLineItem.update({
            where: { id: row.id },
            data: { notes: null },
          })
        }
        console.log(`  [clear]  invoice_line_item ${row.id} — no source mapping found, clearing notes`)
        cleared++
      }
      continue
    }

    const estimateLineItemIds = sources.map(s => s.estimateLineItemId)
    const estimateLineItems = await prisma.estimateLineItem.findMany({
      where: { id: { in: estimateLineItemIds } },
      select: { id: true, description: true, notes: true },
    })

    // Build lookup: description → notes (from estimate)
    const descToNotes = new Map()
    for (const eli of estimateLineItems) {
      if (!descToNotes.has(eli.description)) {
        descToNotes.set(eli.description, eli.notes ?? null)
      }
    }

    for (const row of rows) {
      const realNotes = descToNotes.has(row.description)
        ? descToNotes.get(row.description)
        : null

      if (!dryRun) {
        await prisma.invoiceLineItem.update({
          where: { id: row.id },
          data: { notes: realNotes },
        })
      }
      if (realNotes) {
        console.log(`  [fix]    invoice_line_item ${row.id} — restored notes: "${realNotes.slice(0, 60)}"`)
        fixed++
      } else {
        console.log(`  [clear]  invoice_line_item ${row.id} — no notes on source estimate item, cleared`)
        cleared++
      }
    }
  }

  console.log(`\nDone.  fixed=${fixed}  cleared=${cleared}  skipped=${skipped}`)
  if (dryRun) console.log('(dry run — no changes written)')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
