/**
 * Investigate paid invoices that are missing linked jobs.
 * Run: node scripts/investigate-paid-invoice-jobs.mjs [--days=90] [--client=NAME]
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  })
)
const days = Number(args.days || 90)
const clientFilter = args.client ? String(args.client).toLowerCase() : null
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

const paidInvoices = await p.invoice.findMany({
  where: {
    paidAmount: { gt: 0 },
    jobId: null,
    status: { notIn: ['CANCELLED', 'REFUNDED'] },
    ...(clientFilter
      ? {
          client: {
            OR: [
              { name: { contains: clientFilter, mode: 'insensitive' } },
              { companyName: { contains: clientFilter, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  },
  orderBy: { paidAt: 'desc' },
  take: 200,
  select: {
    id: true,
    invoiceNumber: true,
    title: true,
    status: true,
    total: true,
    paidAmount: true,
    balance: true,
    paidAt: true,
    createdAt: true,
    clientId: true,
    estimateId: true,
    client: { select: { id: true, name: true, companyName: true } },
    estimate: {
      select: {
        id: true,
        jobId: true,
        clientId: true,
        leadId: true,
        jobSiteAddress: true,
        lead: { select: { id: true, jobSiteAddress: true, convertedToClientId: true } },
      },
    },
    payments: {
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        amount: true,
        method: true,
        provider: true,
        reference: true,
        notes: true,
        solaTransactionId: true,
        createdAt: true,
        processedAt: true,
      },
    },
  },
})

const recentPaidWithJob = await p.invoice.findMany({
  where: {
    paidAmount: { gt: 0 },
    jobId: { not: null },
    paidAt: { gte: since },
  },
  orderBy: { paidAt: 'desc' },
  take: 20,
  select: {
    id: true,
    invoiceNumber: true,
    paidAt: true,
    jobId: true,
    client: { select: { name: true } },
    payments: {
      take: 1,
      orderBy: { createdAt: 'asc' },
      select: { provider: true, method: true, notes: true },
    },
    job: { select: { id: true, jobNumber: true, createdAt: true } },
  },
})

function classifyPaymentPath(payment) {
  if (!payment) return 'unknown'
  const provider = String(payment.provider || '').toLowerCase()
  const notes = String(payment.notes || '').toLowerCase()
  const ref = String(payment.reference || '').toLowerCase()

  if (provider === 'sola' || payment.solaTransactionId) return 'sola_card_webhook'
  if (provider === 'quickbooks' || ref.startsWith('qbo_')) return 'qbo_webhook_or_reconcile'
  if (provider === 'quick_pay') return 'manual_quick_pay'
  if (provider === 'manual' || notes.includes('manually marked')) return 'manual_mark_paid'
  if (notes.includes('bulk payment')) return 'sola_bulk_card'
  return `other:${provider || 'none'}`
}

function diagnoseMissingJob(inv) {
  const reasons = []
  if (!inv.clientId && !inv.estimate?.clientId && !inv.estimate?.lead?.convertedToClientId) {
    reasons.push('NO_CLIENT_RESOLVABLE')
  }
  const firstPayment = inv.payments[0]
  const path = classifyPaymentPath(firstPayment)
  if (path !== 'sola_card_webhook' && path !== 'sola_bulk_card') {
    reasons.push(`PAYMENT_PATH_NO_JOB_HOOK:${path}`)
  } else {
    reasons.push('SOLA_PATH_SHOULD_HAVE_CREATED_JOB')
  }
  if (inv.estimate?.jobId) reasons.push('ESTIMATE_ALREADY_HAS_JOB_BUT_INVOICE_UNLINKED')
  return { path, reasons }
}

const missing = paidInvoices.map((inv) => {
  const d = diagnoseMissingJob(inv)
  return {
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    paidAt: inv.paidAt,
    client: inv.client?.name || inv.client?.companyName || null,
    clientId: inv.clientId,
    total: Number(inv.total),
    paidAmount: Number(inv.paidAmount),
    balance: Number(inv.balance),
    hasEstimate: Boolean(inv.estimateId),
    estimateJobId: inv.estimate?.jobId || null,
    firstPaymentPath: d.path,
    firstPayment: inv.payments[0]
      ? {
          provider: inv.payments[0].provider,
          method: inv.payments[0].method,
          notes: inv.payments[0].notes,
          createdAt: inv.payments[0].createdAt,
        }
      : null,
    paymentCount: inv.payments.length,
    diagnosis: d.reasons,
  }
})

// Group by payment path
const byPath = {}
for (const row of missing) {
  byPath[row.firstPaymentPath] = (byPath[row.firstPaymentPath] || 0) + 1
}

// JOB_CREATED activities for comparison
const jobCreatedActivities = await p.activity.findMany({
  where: {
    type: 'JOB_CREATED',
    description: { contains: 'Payment received' },
    createdAt: { gte: since },
  },
  orderBy: { createdAt: 'desc' },
  take: 30,
  select: {
    createdAt: true,
    description: true,
    invoiceId: true,
    jobId: true,
  },
})

console.log('=== PAID INVOICES MISSING JOBS ===')
console.log(JSON.stringify({ count: missing.length, byPath, samples: missing.slice(0, 30) }, null, 2))

console.log('\n=== RECENT PAID INVOICES WITH JOBS (control group) ===')
console.log(
  JSON.stringify(
    recentPaidWithJob.map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      client: inv.client?.name,
      paidAt: inv.paidAt,
      jobNumber: inv.job?.jobNumber,
      jobCreatedAt: inv.job?.createdAt,
      firstPaymentPath: classifyPaymentPath(inv.payments[0]),
    })),
    null,
    2
  )
)

console.log('\n=== JOB_CREATED ACTIVITIES (payment-triggered, last N days) ===')
console.log(JSON.stringify(jobCreatedActivities, null, 2))

await p.$disconnect()
