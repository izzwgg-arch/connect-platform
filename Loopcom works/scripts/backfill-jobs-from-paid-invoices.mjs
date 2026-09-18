/**
 * Backfill jobs for paid invoices that never got linked.
 * Dry run by default. Pass --apply to create jobs.
 *
 * Run: npx tsx scripts/backfill-jobs-from-paid-invoices.mjs [--apply] [--limit=50]
 */
import { PrismaClient } from '@prisma/client'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  })
)
const apply = args.apply === 'true'
const limit = Number(args.limit || 200)

const p = new PrismaClient()

const candidates = await p.invoice.findMany({
  where: {
    paidAmount: { gt: 0 },
    jobId: null,
    status: { notIn: ['CANCELLED', 'REFUNDED'] },
  },
  orderBy: [{ paidAt: 'desc' }, { updatedAt: 'desc' }],
  take: limit,
  select: {
    id: true,
    invoiceNumber: true,
    status: true,
    paidAt: true,
    client: { select: { name: true } },
    payments: {
      take: 1,
      orderBy: { createdAt: 'asc' },
      select: { provider: true, method: true, notes: true },
    },
  },
})

console.log(`Found ${candidates.length} paid invoice(s) without jobs (limit ${limit})`)
console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`)

if (!apply) {
  console.log(
    JSON.stringify(
      candidates.map((inv) => ({
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        client: inv.client?.name,
        paidAt: inv.paidAt,
        firstPayment: inv.payments[0] || null,
      })),
      null,
      2
    )
  )
  await p.$disconnect()
  process.exit(0)
}

// Dynamic import so this script can run on server once lib is deployed.
const { afterInvoicePayment } = await import('../lib/payments/after-invoice-payment.ts')

let created = 0
let linked = 0
let failed = 0

for (const inv of candidates) {
  try {
    const before = await p.invoice.findUnique({
      where: { id: inv.id },
      select: { jobId: true },
    })
    await afterInvoicePayment(inv.id)
    const after = await p.invoice.findUnique({
      where: { id: inv.id },
      select: { jobId: true, job: { select: { jobNumber: true } } },
    })
    if (!before?.jobId && after?.jobId) {
      const activity = await p.activity.findFirst({
        where: { invoiceId: inv.id, type: 'JOB_CREATED' },
        orderBy: { createdAt: 'desc' },
        select: { description: true },
      })
      if (activity?.description?.includes('converted to job')) created += 1
      else linked += 1
      console.log(`OK ${inv.invoiceNumber} -> ${after.job?.jobNumber || after.jobId}`)
    } else {
      console.log(`SKIP ${inv.invoiceNumber} (still no job)`)
    }
  } catch (error) {
    failed += 1
    console.error(`FAIL ${inv.invoiceNumber}`, error)
  }
}

console.log(JSON.stringify({ created, linked, failed }, null, 2))
await p.$disconnect()
