/**
 * Event-driven QBO sync queue.
 *
 * Call `enqueueQboSync` instead of calling sync functions directly.
 * This prevents duplicate QBO API calls when the same entity changes
 * multiple times in quick succession, and provides automatic retry with
 * exponential backoff for transient failures.
 *
 * Flow:
 *   1. Business logic enqueues a job (fast, non-blocking DB write).
 *   2. Job is deduplicated: if a pending job already exists for the same
 *      (tenantId, entityType, entityId), we just touch updatedAt instead
 *      of creating a duplicate.
 *   3. After enqueue, `processImmediately: true` (default) triggers the
 *      sync in the same request so behaviour is unchanged for callers
 *      that relied on synchronous sync.  Pass `false` on hot paths (webhooks,
 *      bulk loops) to defer to the background worker.
 *   4. The background worker (`/api/qbo/worker`) retries failed jobs with
 *      exponential backoff up to `maxRetries` times.
 */

import { prisma } from '@/lib/prisma'
import {
  syncInvoiceToQuickBooks,
  syncClientToQuickBooks,
  syncEstimateToQuickBooks,
  syncPaymentToQuickBooks,
  syncVendorToQuickBooks,
  syncPurchaseOrderToQuickBooks,
  syncCreditMemoToQuickBooks,
  syncLeadToQuickBooksProject,
} from '@/lib/services/qbo-sync'

export type QboEntityType =
  | 'invoice'
  | 'client'
  | 'estimate'
  | 'payment'
  | 'vendor'
  | 'purchase_order'
  | 'credit_memo'
  | 'job'
  | 'lead'

const RETRY_DELAYS_MS = [
  30_000,    // 30 s
  120_000,   // 2 min
  600_000,   // 10 min
]

/**
 * Enqueue a QBO sync job with deduplication.
 *
 * If `processImmediately` is true (default), the job is executed inline
 * before this function returns — matching the original synchronous behaviour.
 * Pass `false` to defer execution to the background worker cron.
 */
export async function enqueueQboSync(
  tenantId: string,
  entityType: QboEntityType,
  entityId: string,
  options?: { processImmediately?: boolean }
): Promise<void> {
  const processImmediately = options?.processImmediately !== false
  const idempotencyKey = `${entityType}-sync:${entityId}`

  // Dedup: check for an existing pending job for this entity.
  const existing = await prisma.qboSyncJob.findFirst({
    where: {
      tenantId,
      entityType,
      entityId,
      status: { in: ['pending', 'processing'] },
    },
    select: { id: true },
  })

  let jobId: string

  if (existing) {
    // Coalesce: just bump updatedAt so the worker knows there's fresh intent.
    await prisma.qboSyncJob.update({
      where: { id: existing.id },
      data: { updatedAt: new Date(), nextRetryAt: new Date(), payloadHash: idempotencyKey },
    })
    jobId = existing.id
  } else {
    const job = await prisma.qboSyncJob.create({
      data: {
        tenantId,
        entityType,
        entityId,
        status: 'pending',
        nextRetryAt: new Date(),
        payloadHash: idempotencyKey,
      },
      select: { id: true },
    })
    jobId = job.id
  }

  if (processImmediately) {
    await processQboSyncJob(jobId)
  }
}

/**
 * Process a single sync job by ID.
 * Marks the job as `processing`, calls the appropriate sync function,
 * then marks it `synced`.  On failure, schedules a retry.
 */
export async function processQboSyncJob(jobId: string): Promise<void> {
  const job = await prisma.qboSyncJob.findUnique({ where: { id: jobId } })
  if (!job) return
  if (job.status === 'synced' || job.status === 'skipped') return

  // Mark processing to prevent double-execution from concurrent workers.
  await prisma.qboSyncJob.update({
    where: { id: jobId },
    data: { status: 'processing' },
  })

  try {
    await dispatchSync(job.tenantId, job.entityType as QboEntityType, job.entityId)

    await prisma.qboSyncJob.update({
      where: { id: jobId },
      data: {
        status: 'synced',
        processedAt: new Date(),
        lastError: null,
      },
    })
  } catch (err: any) {
    const nextRetry = job.retryCount < (job.maxRetries - 1)
      ? job.retryCount
      : null
    const delayMs = nextRetry !== null ? (RETRY_DELAYS_MS[nextRetry] ?? 600_000) : 0
    const isFinal = job.retryCount + 1 >= job.maxRetries

    await prisma.qboSyncJob.update({
      where: { id: jobId },
      data: {
        status: isFinal ? 'failed' : 'pending',
        retryCount: { increment: 1 },
        nextRetryAt: isFinal ? new Date() : new Date(Date.now() + delayMs),
        lastError: String(err?.message || err || 'unknown error').slice(0, 2000),
        processedAt: isFinal ? new Date() : null,
      },
    })
  }
}

/**
 * Background worker: process all pending jobs that are due.
 * Returns counts of processed, succeeded, and failed jobs.
 *
 * Pass `tenantId` to limit scope to a single tenant (useful for manual
 * admin retries).  Pass `limit` to cap the batch size.
 */
export async function runQboSyncWorker(options?: {
  tenantId?: string
  limit?: number
}): Promise<{ processed: number; succeeded: number; failed: number }> {
  const limit = options?.limit ?? 50

  const jobs = await prisma.qboSyncJob.findMany({
    where: {
      status: 'pending',
      nextRetryAt: { lte: new Date() },
      ...(options?.tenantId ? { tenantId: options.tenantId } : {}),
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  let succeeded = 0
  let failed = 0

  for (const { id } of jobs) {
    try {
      await processQboSyncJob(id)
      // Re-fetch to check final status.
      const updated = await prisma.qboSyncJob.findUnique({
        where: { id },
        select: { status: true },
      })
      if (updated?.status === 'synced') succeeded++
      else failed++
    } catch {
      failed++
    }
  }

  return { processed: jobs.length, succeeded, failed }
}

/**
 * Retry all failed jobs for a tenant.  Used by the admin UI.
 */
export async function retryFailedQboJobs(tenantId: string): Promise<number> {
  const result = await prisma.qboSyncJob.updateMany({
    where: { tenantId, status: 'failed' },
    data: {
      status: 'pending',
      retryCount: 0,
      nextRetryAt: new Date(),
      lastError: null,
    },
  })
  return result.count
}

// ---------------------------------------------------------------------------
// Internal dispatcher — calls the correct sync function per entity type.
// ---------------------------------------------------------------------------
async function dispatchSync(
  tenantId: string,
  entityType: QboEntityType,
  entityId: string
): Promise<void> {
  switch (entityType) {
    case 'invoice':
      await syncInvoiceToQuickBooks(tenantId, entityId)
      break
    case 'client':
      await syncClientToQuickBooks(tenantId, entityId)
      break
    case 'estimate':
      await syncEstimateToQuickBooks(tenantId, entityId)
      break
    case 'payment':
      await syncPaymentToQuickBooks(tenantId, entityId)
      break
    case 'vendor':
      await syncVendorToQuickBooks(tenantId, entityId)
      break
    case 'purchase_order':
      await syncPurchaseOrderToQuickBooks(tenantId, entityId)
      break
    case 'credit_memo':
      await syncCreditMemoToQuickBooks(tenantId, entityId)
      break
    case 'job':
      // Job → QBO project/subcustomer sync is disabled.
      break
    case 'lead':
      await syncLeadToQuickBooksProject(tenantId, entityId)
      break
    default:
      throw new Error(`Unknown QBO entity type: ${entityType}`)
  }
}
