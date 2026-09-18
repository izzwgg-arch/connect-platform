/**
 * Usage: node scripts/resync-payment.mjs [invoiceNumber]
 *
 * Finds all payments for the given invoice number (defaults to INV-000271),
 * checks their QBO sync status, and re-queues them for sync.
 *
 * Run with proper DATABASE_URL env var set, e.g.:
 *   DATABASE_URL=postgres://... node scripts/resync-payment.mjs INV-000271
 */

import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const invoiceNumber = process.argv[2] || 'INV-000271'

console.log(`\nLooking up payments for invoice: ${invoiceNumber}\n`)

const invoice = await p.invoice.findFirst({
  where: { invoiceNumber },
  select: {
    id: true,
    invoiceNumber: true,
    tenantId: true,
    total: true,
    paidAmount: true,
    balance: true,
    status: true,
    qboSyncId: true,
    payments: {
      orderBy: { processedAt: 'desc' },
      select: {
        id: true,
        amount: true,
        method: true,
        provider: true,
        status: true,
        processedAt: true,
        createdAt: true,
      },
    },
  },
})

if (!invoice) {
  console.error(`Invoice ${invoiceNumber} not found.`)
  await p.$disconnect()
  process.exit(1)
}

console.log(`Invoice: ${invoice.invoiceNumber} (id: ${invoice.id})`)
console.log(`  Status: ${invoice.status}`)
console.log(`  Total: $${Number(invoice.total).toFixed(2)}`)
console.log(`  Paid:  $${Number(invoice.paidAmount).toFixed(2)}`)
console.log(`  Balance: $${Number(invoice.balance).toFixed(2)}`)
console.log(`  QBO Invoice ID: ${invoice.qboSyncId || '(not synced)'}`)
console.log(`\nPayments (${invoice.payments.length} total):`)

for (const pay of invoice.payments) {
  console.log(`\n  Payment ${pay.id}`)
  console.log(`    Amount: $${Number(pay.amount).toFixed(2)}`)
  console.log(`    Method: ${pay.method} / Provider: ${pay.provider || 'n/a'}`)
  console.log(`    Status: ${pay.status}`)
  console.log(`    Processed: ${pay.processedAt?.toISOString() || pay.createdAt.toISOString()}`)
}

// Check QBO sync log for each payment
const integration = await p.quickBooksIntegration.findUnique({
  where: { tenantId: invoice.tenantId },
  select: { id: true, isConnected: true, realmId: true, tokenExpiresAt: true },
})

console.log(`\nQBO Integration:`)
console.log(`  Connected: ${integration?.isConnected ?? false}`)
console.log(`  Realm ID: ${integration?.realmId || '(none)'}`)
console.log(`  Token expires: ${integration?.tokenExpiresAt?.toISOString() || '(unknown)'}`)

if (!integration?.id) {
  console.log('\nNo QBO integration found. Cannot check sync status.')
  await p.$disconnect()
  process.exit(0)
}

console.log('\nQBO Sync Logs per payment:')
for (const pay of invoice.payments) {
  const logs = await p.quickBooksSyncLog.findMany({
    where: { integrationId: integration.id, entityId: pay.id },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { status: true, qboId: true, error: true, createdAt: true },
  })

  if (logs.length === 0) {
    console.log(`\n  Payment ${pay.id} ($${Number(pay.amount).toFixed(2)}): NO sync log entries`)
  } else {
    console.log(`\n  Payment ${pay.id} ($${Number(pay.amount).toFixed(2)}):`)
    for (const log of logs) {
      console.log(`    [${log.status}] qboId=${log.qboId || 'none'} error="${log.error || ''}" at ${log.createdAt.toISOString()}`)
    }
  }
}

// Check qboSyncJob status
console.log('\nQBO Sync Job Queue:')
for (const pay of invoice.payments) {
  const jobs = await p.qboSyncJob.findMany({
    where: { tenantId: invoice.tenantId, entityType: 'payment', entityId: pay.id },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { status: true, retryCount: true, lastError: true, nextRetryAt: true, createdAt: true },
  })

  if (jobs.length === 0) {
    console.log(`  Payment ${pay.id}: No sync queue entry`)
  } else {
    for (const job of jobs) {
      console.log(`  Payment ${pay.id}: status=${job.status} retries=${job.retryCount} nextRetry=${job.nextRetryAt?.toISOString() || 'n/a'} error="${job.lastError || ''}"`)
    }
  }
}

// Re-queue payments that don't have a success log
console.log('\n--- Re-queuing unsynced payments ---')
let requeued = 0
for (const pay of invoice.payments) {
  const successLog = await p.quickBooksSyncLog.findFirst({
    where: { integrationId: integration.id, entityId: pay.id, status: 'success', qboId: { not: null } },
    select: { id: true },
  })

  if (successLog) {
    console.log(`  Payment ${pay.id} ($${Number(pay.amount).toFixed(2)}): already synced to QBO — skipping`)
    continue
  }

  // Upsert a fresh sync job (resets any stale 'synced' state)
  const existing = await p.qboSyncJob.findFirst({
    where: { tenantId: invoice.tenantId, entityType: 'payment', entityId: pay.id, status: { in: ['pending', 'processing'] } },
    select: { id: true },
  })

  if (existing) {
    await p.qboSyncJob.update({
      where: { id: existing.id },
      data: { updatedAt: new Date(), nextRetryAt: new Date() },
    })
    console.log(`  Payment ${pay.id} ($${Number(pay.amount).toFixed(2)}): bumped existing pending job`)
  } else {
    await p.qboSyncJob.create({
      data: {
        tenantId: invoice.tenantId,
        entityType: 'payment',
        entityId: pay.id,
        status: 'pending',
        nextRetryAt: new Date(),
        payloadHash: `payment-sync:${pay.id}`,
      },
    })
    console.log(`  Payment ${pay.id} ($${Number(pay.amount).toFixed(2)}): created new sync job`)
    requeued++
  }
}

if (requeued > 0) {
  console.log(`\n${requeued} payment(s) re-queued. Run the QBO sync worker or wait for the next cron run.`)
} else {
  console.log('\nNo payments needed re-queuing.')
}

await p.$disconnect()
