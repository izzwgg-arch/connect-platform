/* eslint-disable no-console */
/**
 * Backfill Estimate.convertedPercent for estimates converted before the fix
 * that stored the billing input % instead of cumulative invoiced % of estimate total.
 *
 * Usage:
 *   npx tsx scripts/backfill-estimate-converted-percent.ts --dry-run
 *   npx tsx scripts/backfill-estimate-converted-percent.ts
 *
 * Requires DATABASE_URL (loads .env via dotenv when present).
 */
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { getEstimateConversionSummary } from '../lib/documents/conversion'

function toStoredPercent(convertedPercent: number): number | null {
  return convertedPercent > 0 ? convertedPercent : null
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const dbUrl = String(process.env.DATABASE_URL || '').trim()
  if (!/^postgres(ql)?:\/\//i.test(dbUrl)) {
    console.error('DATABASE_URL must be a postgresql:// or postgres:// connection string.')
    console.error('Set it in .env or pass it when running the script.')
    process.exit(2)
  }

  const estimates = await prisma.estimate.findMany({
    where: { status: 'CONVERTED' },
    select: {
      id: true,
      tenantId: true,
      estimateNumber: true,
      convertedPercent: true,
      total: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`Found ${estimates.length} CONVERTED estimate(s)${dryRun ? ' (dry run)' : ''}`)

  let updated = 0
  let unchanged = 0
  const changes: Array<{
    estimateNumber: string
    before: number | null
    after: number | null
  }> = []

  for (const estimate of estimates) {
    const conversion = await getEstimateConversionSummary(
      prisma,
      estimate.id,
      estimate.total,
      estimate.tenantId
    )
    const correctPercent = toStoredPercent(conversion.convertedPercent)

    if (estimate.convertedPercent === correctPercent) {
      unchanged++
      continue
    }

    changes.push({
      estimateNumber: estimate.estimateNumber,
      before: estimate.convertedPercent,
      after: correctPercent,
    })

    if (!dryRun) {
      await prisma.estimate.update({
        where: { id: estimate.id },
        data: { convertedPercent: correctPercent },
      })
    }
    updated++
  }

  if (changes.length > 0) {
    console.log('\nChanges:')
    for (const row of changes) {
      console.log(
        `  ${row.estimateNumber}: ${row.before ?? 'null'} -> ${row.after ?? 'null'}`
      )
    }
  }

  console.log(`\n${dryRun ? 'Would update' : 'Updated'}: ${updated}`)
  console.log(`Unchanged: ${unchanged}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
