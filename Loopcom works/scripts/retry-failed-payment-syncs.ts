/**
 * Retry failed QBO payment syncs (e.g. after PaymentRefNum fix).
 *
 * Usage:
 *   npx tsx scripts/retry-failed-payment-syncs.ts [paymentId...]
 *
 * With no args: retries all failed payment sync jobs from the last 14 days.
 */
import { PrismaClient } from '@prisma/client'
import { buildQboPaymentRefNum } from '@/lib/qbo/payment-ref-num'
import { processQboSyncJob } from '@/lib/qbo/sync-queue'

const p = new PrismaClient()

async function main() {
  const paymentIds = process.argv.slice(2)
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

  let targets = paymentIds
  if (!targets.length) {
    const failedJobs = await p.qboSyncJob.findMany({
      where: {
        entityType: 'payment',
        status: 'failed',
        updatedAt: { gte: since },
      },
      select: { entityId: true },
    })
    targets = [...new Set(failedJobs.map((j) => j.entityId))]
  }

  console.log('retry_targets', targets)

  for (const paymentId of targets) {
    const payment = await p.payment.findUnique({
      where: { id: paymentId },
      include: { invoice: { select: { invoiceNumber: true, tenantId: true } } },
    })
    if (!payment) {
      console.log('skip_missing', paymentId)
      continue
    }

    if (!payment.providerPaymentId && payment.solaTransactionId) {
      const uniqueProviderId = String(payment.solaTransactionId).trim()
      const taken = uniqueProviderId
        ? await p.payment.findFirst({
            where: {
              provider: payment.provider || 'sola',
              providerPaymentId: uniqueProviderId,
              id: { not: paymentId },
            },
            select: { id: true },
          })
        : null
      if (uniqueProviderId && !taken) {
        await p.payment.update({
          where: { id: paymentId },
          data: { provider: payment.provider || 'sola', providerPaymentId: uniqueProviderId },
        })
        payment.providerPaymentId = uniqueProviderId
        payment.provider = payment.provider || 'sola'
      }
    }

    const refPreview = buildQboPaymentRefNum({
      providerPaymentId: payment.providerPaymentId,
      solaTransactionId: payment.solaTransactionId,
      reference: payment.reference,
      invoiceNumber: payment.invoice?.invoiceNumber,
      paymentId: payment.id,
    })
    console.log('retry', paymentId, payment.invoice?.invoiceNumber, 'refNum=', refPreview)

    await p.qboSyncJob.updateMany({
      where: { entityType: 'payment', entityId: paymentId },
      data: {
        status: 'pending',
        retryCount: 0,
        lastError: null,
        nextRetryAt: new Date(),
        processedAt: null,
      },
    })

    let job = await p.qboSyncJob.findFirst({
      where: { entityType: 'payment', entityId: paymentId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })

    if (!job) {
      job = await p.qboSyncJob.create({
        data: {
          tenantId: payment.invoice!.tenantId,
          entityType: 'payment',
          entityId: paymentId,
          status: 'pending',
          nextRetryAt: new Date(),
          payloadHash: `payment-sync:${paymentId}`,
        },
        select: { id: true },
      })
    }

    await processQboSyncJob(job.id)

    const log = await p.quickBooksSyncLog.findFirst({
      where: { entityId: paymentId, type: 'payment' },
      orderBy: { createdAt: 'desc' },
      select: { status: true, error: true, qboId: true, createdAt: true },
    })
    console.log('result', paymentId, log)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => p.$disconnect())
