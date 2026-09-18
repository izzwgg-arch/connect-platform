/* eslint-disable no-console */
/**
 * Backfill Invoice.originalTotalAtConversion for invoices created from an
 * estimate BEFORE that snapshot field existed. Without it, an invoice's
 * current (possibly discounted) `total` was the only thing available for
 * calculating the source estimate's "% converted" — so a discount applied
 * to the invoice after conversion (via the invoice's discount field, or a
 * negative-amount line item such as "Discount / -$4,500.00") retroactively
 * shrank the estimate's recorded conversion percentage.
 *
 * This reconstructs the amount that was actually billed against the
 * estimate at conversion time, for each affected invoice, as:
 *
 *   total + discount + sum(abs(total) for line items with a negative total)
 *
 * i.e. undoing both known discount mechanisms. This is a best-effort
 * reconstruction — it assumes no line items were added/removed since
 * conversion (only a discount applied) — but it is unambiguous and matches
 * the concrete case reported (a "Discount" line item with a negative total).
 *
 * After running this, re-run scripts/backfill-estimate-converted-percent.ts
 * to resync each affected Estimate's stored convertedPercent using the
 * now-corrected calculation.
 *
 * Usage:
 *   npx tsx scripts/backfill-invoice-conversion-snapshot.ts --dry-run
 *   npx tsx scripts/backfill-invoice-conversion-snapshot.ts
 *
 * Requires DATABASE_URL (loads .env via dotenv when present).
 */
import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const dbUrl = String(process.env.DATABASE_URL || '').trim()
  if (!/^postgres(ql)?:\/\//i.test(dbUrl)) {
    console.error('DATABASE_URL must be a postgresql:// or postgres:// connection string.')
    console.error('Set it in .env or pass it when running the script.')
    process.exit(2)
  }

  const invoices = await prisma.invoice.findMany({
    where: {
      estimateId: { not: null },
      originalTotalAtConversion: null,
    },
    select: {
      id: true,
      invoiceNumber: true,
      estimateId: true,
      total: true,
      discount: true,
      lineItems: { select: { total: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`Found ${invoices.length} invoice(s) linked to an estimate with no conversion snapshot${dryRun ? ' (dry run)' : ''}`)

  let updated = 0
  const affectedEstimateIds = new Set<string>()
  const changes: Array<{ invoiceNumber: string; currentTotal: string; reconstructed: string }> = []

  for (const invoice of invoices) {
    const currentTotal = Number(invoice.total)
    const discount = Number(invoice.discount || 0)
    const negativeLineItemsTotal = invoice.lineItems.reduce((sum, li) => {
      const t = Number(li.total)
      return t < 0 ? sum + Math.abs(t) : sum
    }, 0)
    const reconstructed = currentTotal + discount + negativeLineItemsTotal

    if (Math.abs(reconstructed - currentTotal) < 0.01) {
      // No discount detected — snapshot equals the current total.
      if (!dryRun) {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { originalTotalAtConversion: currentTotal },
        })
      }
      updated++
      continue
    }

    changes.push({
      invoiceNumber: invoice.invoiceNumber,
      currentTotal: currentTotal.toFixed(2),
      reconstructed: reconstructed.toFixed(2),
    })
    if (invoice.estimateId) affectedEstimateIds.add(invoice.estimateId)

    if (!dryRun) {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { originalTotalAtConversion: reconstructed },
      })
    }
    updated++
  }

  if (changes.length > 0) {
    console.log('\nInvoices where a discount was detected and undone for the snapshot:')
    for (const row of changes) {
      console.log(`  ${row.invoiceNumber}: current total $${row.currentTotal} -> conversion snapshot $${row.reconstructed}`)
    }
  }

  console.log(`\n${dryRun ? 'Would set' : 'Set'} originalTotalAtConversion on ${updated} invoice(s)`)
  console.log(`${changes.length} of those had a discount that was undone for the snapshot`)
  console.log(`${affectedEstimateIds.size} distinct estimate(s) affected — re-run scripts/backfill-estimate-converted-percent.ts next to resync their stored convertedPercent`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
