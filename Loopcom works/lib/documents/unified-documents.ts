import { prisma } from '@/lib/prisma'

export type UnifiedDocumentKind =
  | 'estimate'
  | 'invoice'
  | 'credit_memo'
  | 'payment'
  | 'purchase_order'
  | 'request'
  | 'job'

export interface UnifiedDocumentRow {
  id: string
  kind: UnifiedDocumentKind
  number: string
  title: string | null
  status: string
  amount: number
  balance: number | null
  isPaid: boolean | null
  date: string
  href: string
  meta?: string | null
  canReceipt?: boolean
  receiptEmailSentAt?: string | null
  clientId?: string | null
  clientName?: string | null
}

async function getDescendantClientIds(tenantId: string, parentIds: string[]): Promise<string[]> {
  const all = new Set<string>()
  let frontier = [...parentIds]
  let loops = 0
  while (frontier.length > 0) {
    loops += 1
    // Guard against accidental parent cycles so documents never hang.
    if (loops > 50) break
    const children = await prisma.client.findMany({
      where: { tenantId, parentId: { in: frontier } },
      select: { id: true },
    })
    frontier = []
    for (const child of children) {
      if (!all.has(child.id)) {
        all.add(child.id)
        frontier.push(child.id)
      }
    }
  }
  return Array.from(all)
}

function isInvoicePaid(status: string, balance: number) {
  return status === 'PAID' || status === 'CANCELLED' || status === 'REFUNDED' || balance <= 0
}

function paymentDisplayStatus(status: string, refundStatus: string) {
  if (refundStatus === 'FULLY_REFUNDED') return 'REFUNDED'
  if (refundStatus === 'PARTIALLY_REFUNDED') return 'PARTIALLY_REFUNDED'
  return status
}

function paymentCanReceipt(displayStatus: string) {
  return displayStatus === 'COMPLETED' || displayStatus === 'REFUNDED' || displayStatus === 'PARTIALLY_REFUNDED'
}

const estimateSelect = {
  id: true,
  clientId: true,
  estimateNumber: true,
  title: true,
  status: true,
  total: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
} as const

const invoiceSelect = {
  id: true,
  clientId: true,
  invoiceNumber: true,
  title: true,
  status: true,
  total: true,
  balance: true,
  dueDate: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
} as const

const purchaseOrderSelect = {
  id: true,
  clientId: true,
  jobId: true,
  poNumber: true,
  vendor: true,
  status: true,
  total: true,
  orderDate: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
} as const

const creditMemoSelect = {
  id: true,
  clientId: true,
  jobId: true,
  creditMemoNumber: true,
  title: true,
  status: true,
  total: true,
  remainingCredit: true,
  creditMemoDate: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
  job: { select: { id: true, jobNumber: true, title: true } },
} as const

const requestSelect = {
  id: true,
  convertedToClientId: true,
  firstName: true,
  lastName: true,
  company: true,
  status: true,
  value: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
} as const

const jobSelect = {
  id: true,
  clientId: true,
  jobNumber: true,
  title: true,
  status: true,
  estimateAmount: true,
  scheduledStart: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
} as const

async function settledList<T>(label: string, promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise
  } catch (error) {
    console.error(`Documents query failed (${label}):`, error)
    return []
  }
}

export async function fetchClientDocuments(tenantId: string, clientId: string) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, tenantId },
    select: { id: true },
  })

  if (!client) return null

  const descendantIds = await getDescendantClientIds(tenantId, [clientId])
  const clientIds = [clientId, ...descendantIds]

  const [estimates, invoices, creditMemos, payments, purchaseOrders, requests, jobs] =
    await Promise.all([
      settledList(
        'estimates',
        prisma.estimate.findMany({
          where: { tenantId, clientId: { in: clientIds } },
          orderBy: { createdAt: 'desc' },
          select: estimateSelect,
        })
      ),
      settledList(
        'invoices',
        prisma.invoice.findMany({
          where: { tenantId, clientId: { in: clientIds } },
          orderBy: { createdAt: 'desc' },
          select: invoiceSelect,
        })
      ),
      settledList(
        'creditMemos',
        prisma.creditMemo.findMany({
          where: { tenantId, clientId: { in: clientIds } },
          orderBy: { createdAt: 'desc' },
          select: creditMemoSelect,
        })
      ),
      settledList(
        'payments',
        prisma.payment.findMany({
          where: {
            invoice: { tenantId, clientId: { in: clientIds } },
          },
          orderBy: [{ processedAt: 'desc' }, { createdAt: 'desc' }],
          include: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                clientId: true,
                client: { select: { id: true, name: true } },
              },
            },
          },
        })
      ),
      settledList(
        'purchaseOrders',
        prisma.purchaseOrder.findMany({
          where: { tenantId, clientId: { in: clientIds } },
          orderBy: { createdAt: 'desc' },
          select: purchaseOrderSelect,
        })
      ),
      settledList(
        'requests',
        prisma.lead.findMany({
          where: { tenantId, convertedToClientId: { in: clientIds } },
          orderBy: { createdAt: 'desc' },
          select: requestSelect,
        })
      ),
      settledList(
        'jobs',
        prisma.job.findMany({
          where: { tenantId, clientId: { in: clientIds } },
          orderBy: { createdAt: 'desc' },
          select: jobSelect,
        })
      ),
    ])

  return buildDocumentRows({
    estimates,
    invoices,
    creditMemos,
    payments,
    purchaseOrders,
    requests,
    jobs,
    rootClientId: clientId,
  })
}

export async function fetchJobDocuments(tenantId: string, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true },
  })

  if (!job) return null

  const [estimates, invoices, creditMemos, payments, purchaseOrders] = await Promise.all([
    settledList(
      'job-estimates',
      prisma.estimate.findMany({
        where: { tenantId, jobId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          estimateNumber: true,
          title: true,
          status: true,
          total: true,
          createdAt: true,
        },
      })
    ),
    settledList(
      'job-invoices',
      prisma.invoice.findMany({
        where: { tenantId, jobId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          invoiceNumber: true,
          title: true,
          status: true,
          total: true,
          balance: true,
          dueDate: true,
          createdAt: true,
        },
      })
    ),
    settledList(
      'job-creditMemos',
      prisma.creditMemo.findMany({
        where: { tenantId, jobId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          creditMemoNumber: true,
          title: true,
          status: true,
          total: true,
          remainingCredit: true,
          creditMemoDate: true,
          createdAt: true,
        },
      })
    ),
    settledList(
      'job-payments',
      prisma.payment.findMany({
        where: {
          invoice: { tenantId, jobId },
        },
        orderBy: [{ processedAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          invoice: {
            select: { id: true, invoiceNumber: true },
          },
        },
      })
    ),
    settledList(
      'job-purchaseOrders',
      prisma.purchaseOrder.findMany({
        where: { tenantId, jobId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          poNumber: true,
          vendor: true,
          status: true,
          total: true,
          orderDate: true,
          createdAt: true,
        },
      })
    ),
  ])

  return buildDocumentRows({ estimates, invoices, creditMemos, payments, purchaseOrders })
}

function subClientLabel(rootClientId: string | undefined, clientId: string | null | undefined, clientName: string | null | undefined) {
  if (!rootClientId || !clientId || clientId === rootClientId || !clientName) return null
  return clientName
}

function buildDocumentRows({
  estimates,
  invoices,
  creditMemos = [],
  payments,
  purchaseOrders = [],
  requests = [],
  jobs = [],
  rootClientId,
}: {
  estimates: Array<{
    id: string
    clientId?: string | null
    estimateNumber: string
    title: string
    status: string
    total: { toString(): string } | number
    createdAt: Date
    client?: { id: string; name: string } | null
  }>
  invoices: Array<{
    id: string
    clientId?: string | null
    invoiceNumber: string
    title: string
    status: string
    total: { toString(): string } | number
    balance: { toString(): string } | number
    dueDate: Date | null
    createdAt: Date
    client?: { id: string; name: string } | null
  }>
  creditMemos?: Array<{
    id: string
    clientId?: string | null
    creditMemoNumber: string
    title: string
    status: string
    total: { toString(): string } | number
    remainingCredit: { toString(): string } | number
    creditMemoDate: Date | null
    createdAt: Date
    client?: { id: string; name: string } | null
    job?: { id: string; jobNumber: string; title: string | null } | null
  }>
  payments: Array<{
    id: string
    amount: { toString(): string } | number
    status: string
    refundStatus: string
    method: string
    reference: string | null
    processedAt: Date | null
    createdAt: Date
    receiptEmailSentAt: Date | null
    invoice: {
      id: string
      invoiceNumber: string
      clientId?: string
      client?: { id: string; name: string } | null
    } | null
  }>
  purchaseOrders?: Array<{
    id: string
    clientId?: string | null
    poNumber: string
    vendor: string
    status: string
    total: { toString(): string } | number
    orderDate: Date | null
    createdAt: Date
    client?: { id: string; name: string } | null
  }>
  requests?: Array<{
    id: string
    convertedToClientId?: string | null
    firstName: string
    lastName: string
    company: string | null
    status: string
    value: { toString(): string } | number | null
    createdAt: Date
    client?: { id: string; name: string } | null
  }>
  jobs?: Array<{
    id: string
    clientId?: string | null
    jobNumber: string
    title: string
    status: string
    estimateAmount: { toString(): string } | number | null
    scheduledStart: Date | null
    createdAt: Date
    client?: { id: string; name: string } | null
  }>
  rootClientId?: string
}): UnifiedDocumentRow[] {
  const rows: UnifiedDocumentRow[] = []

  for (const estimate of estimates) {
    rows.push({
      id: estimate.id,
      kind: 'estimate',
      number: estimate.estimateNumber,
      title: estimate.title,
      status: estimate.status,
      amount: Number(estimate.total),
      balance: null,
      isPaid: null,
      date: estimate.createdAt.toISOString(),
      href: `/dashboard/estimates/${estimate.id}`,
      clientId: estimate.clientId || estimate.client?.id || null,
      clientName: subClientLabel(rootClientId, estimate.clientId, estimate.client?.name),
    })
  }

  for (const invoice of invoices) {
    const balance = Number(invoice.balance)
    const total = Number(invoice.total)
    rows.push({
      id: invoice.id,
      kind: 'invoice',
      number: invoice.invoiceNumber,
      title: invoice.title,
      status: invoice.status,
      amount: total,
      balance,
      isPaid: isInvoicePaid(invoice.status, balance),
      date: (invoice.dueDate || invoice.createdAt).toISOString(),
      href: `/dashboard/invoices/${invoice.id}`,
      meta: balance > 0 ? `Balance ${balance.toFixed(2)}` : null,
      clientId: invoice.clientId || invoice.client?.id || null,
      clientName: subClientLabel(rootClientId, invoice.clientId, invoice.client?.name),
    })
  }

  for (const creditMemo of creditMemos) {
    const remaining = Number(creditMemo.remainingCredit)
    const jobMeta = creditMemo.job
      ? `${creditMemo.job.jobNumber}${creditMemo.job.title ? ` — ${creditMemo.job.title}` : ''}`
      : null
    rows.push({
      id: creditMemo.id,
      kind: 'credit_memo',
      number: creditMemo.creditMemoNumber,
      title: creditMemo.title,
      status: creditMemo.status,
      amount: Number(creditMemo.total),
      balance: remaining,
      isPaid: remaining <= 0,
      date: (creditMemo.creditMemoDate || creditMemo.createdAt).toISOString(),
      href: `/dashboard/credit-memos/${creditMemo.id}`,
      meta: remaining > 0 ? `Remaining ${remaining.toFixed(2)}` : jobMeta,
      clientId: creditMemo.clientId || creditMemo.client?.id || null,
      clientName: subClientLabel(rootClientId, creditMemo.clientId, creditMemo.client?.name),
    })
  }

  for (const payment of payments) {
    const displayStatus = paymentDisplayStatus(payment.status, payment.refundStatus)
    const paymentClientId = payment.invoice?.clientId || payment.invoice?.client?.id || null
    rows.push({
      id: payment.id,
      kind: 'payment',
      number: payment.invoice?.invoiceNumber || payment.reference || payment.id.slice(-8),
      title: String(payment.method || 'PAYMENT').replace(/_/g, ' '),
      status: displayStatus,
      amount: Number(payment.amount),
      balance: null,
      isPaid: null,
      date: (payment.processedAt || payment.createdAt).toISOString(),
      href: payment.invoice ? `/dashboard/invoices/${payment.invoice.id}` : '#',
      meta: payment.invoice ? `Invoice ${payment.invoice.invoiceNumber}` : null,
      canReceipt: paymentCanReceipt(displayStatus),
      receiptEmailSentAt: payment.receiptEmailSentAt?.toISOString() ?? null,
      clientId: paymentClientId,
      clientName: subClientLabel(rootClientId, payment.invoice?.clientId, payment.invoice?.client?.name),
    })
  }

  for (const po of purchaseOrders) {
    rows.push({
      id: po.id,
      kind: 'purchase_order',
      number: po.poNumber,
      title: po.vendor,
      status: po.status,
      amount: Number(po.total),
      balance: null,
      isPaid: null,
      date: (po.orderDate || po.createdAt).toISOString(),
      href: `/dashboard/purchase-orders/${po.id}`,
      meta: po.vendor ? `Vendor ${po.vendor}` : null,
      clientId: po.clientId || po.client?.id || null,
      clientName: subClientLabel(rootClientId, po.clientId, po.client?.name),
    })
  }

  for (const request of requests) {
    const fullName = `${request.firstName || ''} ${request.lastName || ''}`.trim()
    rows.push({
      id: request.id,
      kind: 'request',
      number: `REQ-${request.id.slice(-6).toUpperCase()}`,
      title: request.company || fullName || 'Request',
      status: request.status,
      amount: request.value != null ? Number(request.value) : 0,
      balance: null,
      isPaid: null,
      date: request.createdAt.toISOString(),
      href: `/dashboard/requests/${request.id}`,
      meta: fullName && request.company ? fullName : null,
      clientName: subClientLabel(rootClientId, request.convertedToClientId, request.client?.name),
    })
  }

  for (const job of jobs) {
    rows.push({
      id: job.id,
      kind: 'job',
      number: job.jobNumber,
      title: job.title,
      status: job.status,
      amount: job.estimateAmount != null ? Number(job.estimateAmount) : 0,
      balance: null,
      isPaid: null,
      date: (job.scheduledStart || job.createdAt).toISOString(),
      href: `/dashboard/jobs/${job.id}`,
      meta: String(job.status || '').replace(/_/g, ' '),
      clientId: job.clientId || job.client?.id || null,
      clientName: subClientLabel(rootClientId, job.clientId, job.client?.name),
    })
  }

  rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return rows
}
