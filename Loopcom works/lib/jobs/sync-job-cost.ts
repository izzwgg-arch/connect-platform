import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'

type DbClient = PrismaClient | Prisma.TransactionClient

const ESTIMATE_COST_STATUSES = ['ACCEPTED', 'CONVERTED'] as const
const EXCLUDED_INVOICE_STATUSES = ['CANCELLED', 'REFUNDED'] as const

/**
 * Recalculates job financials from linked documents:
 * - estimateAmount = sum of ACCEPTED/CONVERTED estimate totals on the job
 * - actualAmount = sum of active (non-cancelled/refunded) invoice totals on the job
 *
 * Total Cost on the job UI is actualAmount ?? estimateAmount.
 */
export async function syncJobCostFromLinkedDocuments(
  jobId: string | null | undefined,
  db: DbClient = prisma
): Promise<void> {
  const id = String(jobId || '').trim()
  if (!id) return

  const job = await db.job.findUnique({
    where: { id },
    select: { id: true, estimateAmount: true },
  })
  if (!job) return

  const [estimateAgg, invoiceAgg, estimateCount, invoiceCount] = await Promise.all([
    db.estimate.aggregate({
      where: { jobId: id, status: { in: [...ESTIMATE_COST_STATUSES] } },
      _sum: { total: true },
    }),
    db.invoice.aggregate({
      where: { jobId: id, status: { notIn: [...EXCLUDED_INVOICE_STATUSES] } },
      _sum: { total: true },
    }),
    db.estimate.count({
      where: { jobId: id, status: { in: [...ESTIMATE_COST_STATUSES] } },
    }),
    db.invoice.count({
      where: { jobId: id, status: { notIn: [...EXCLUDED_INVOICE_STATUSES] } },
    }),
  ])

  const estimateSum = Number(estimateAgg._sum.total || 0)
  const invoiceSum = Number(invoiceAgg._sum.total || 0)

  const data: Prisma.JobUpdateInput = {}

  if (estimateCount > 0) {
    data.estimateAmount = estimateSum
  } else if (invoiceCount > 0 && job.estimateAmount == null) {
    // Saved invoices attached with no approved/converted estimates yet.
    data.estimateAmount = invoiceSum
  }

  data.actualAmount = invoiceCount > 0 ? invoiceSum : null

  await db.job.update({ where: { id }, data })
}
