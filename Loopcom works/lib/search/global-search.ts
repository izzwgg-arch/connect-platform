/**
 * Global search — business/workflow data only.
 *
 * Searches: clients, contacts, vendors, estimates, invoices, payments,
 *           purchase orders, items, jobs, tasks, attachments, notes.
 *
 * Excludes: permissions, roles, integrations, logs, settings, system config.
 *
 * Tenant isolation is enforced on every query; permission gating matches
 * what the sidebar already enforces.
 */

import { prisma } from '@/lib/prisma'
import { formatAddressParts } from '@/lib/address/parse'
import { hasPermissionKey } from '@/lib/permission-aliases'
import { computeScore, topN, queryVariants } from './scoring'

export type { RawResult as SearchResult } from './scoring'

export interface SearchGroup {
  type: string
  label: string
  results: Array<{
    id: string
    entityType: string
    title: string
    subtitle: string
    url: string
    score: number
    updatedAt?: Date | null
  }>
}

// ---- helpers ----------------------------------------------------------------

const ilike = (s: string) => ({ contains: s, mode: 'insensitive' as const })

/** Build an OR filter covering all synonyms for better recall. */
function ilikeAny(field: string, terms: string[]): Record<string, unknown>[] {
  return terms.map((t) => ({ [field]: ilike(t) }))
}

/** Collect all descendant sub-client IDs below the given parent client IDs. */
async function getDescendantClientIds(
  tenantId: string,
  parentIds: string[]
): Promise<string[]> {
  const all = new Set<string>()
  let frontier = [...parentIds]
  while (frontier.length > 0) {
    const children = await prisma.client.findMany({
      where: { tenantId, isActive: true, parentId: { in: frontier } },
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

/** Score related records so they surface when a parent client matched the query. */
function relatedScore(baseScore: number, updatedAt?: Date | null): number {
  let recency = 0
  if (updatedAt) {
    const days = (Date.now() - new Date(updatedAt).getTime()) / 86_400_000
    if (days < 7) recency = 15
    else if (days < 30) recency = 10
    else if (days < 90) recency = 5
  }
  return Math.round(baseScore * 0.85 + recency)
}

type AddressParts = {
  street?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
}

function resolveEstimateAddress(estimate: {
  jobSiteAddress?: string | null
  job?: { addresses?: AddressParts[] } | null
}): string {
  const fromJob = formatAddressParts(estimate.job?.addresses?.[0])
  if (fromJob) return fromJob
  return estimate.jobSiteAddress?.trim() || ''
}

function resolveInvoiceAddress(invoice: {
  job?: { addresses?: AddressParts[] } | null
  estimate?: { jobSiteAddress?: string | null } | null
}): string {
  const fromJob = formatAddressParts(invoice.job?.addresses?.[0])
  if (fromJob) return fromJob
  return invoice.estimate?.jobSiteAddress?.trim() || ''
}

const estimateInclude = {
  client: { select: { name: true, companyName: true } },
  job: {
    select: {
      addresses: {
        where: { type: 'job_site' as const },
        select: { street: true, city: true, state: true, zipCode: true },
        take: 1,
      },
    },
  },
}

const invoiceInclude = {
  client: { select: { name: true, companyName: true } },
  job: {
    select: {
      addresses: {
        where: { type: 'job_site' as const },
        select: { street: true, city: true, state: true, zipCode: true },
        take: 1,
      },
    },
  },
  estimate: { select: { jobSiteAddress: true } },
}

// ---- main export ------------------------------------------------------------

export async function runGlobalSearch({
  query,
  tenantId,
  permissions,
  limitPerGroup = 8,
}: {
  query: string
  tenantId: string
  permissions: string[]
  limitPerGroup?: number
}): Promise<SearchGroup[]> {
  const q = query.trim()
  if (!q || q.length < 2) return []

  const can = (key: string) => hasPermissionKey(permissions, key)
  const terms = queryVariants(q) // synonyms + digit forms
  const fetch = limitPerGroup * 2 // fetch 2× then score/slice

  // ── parallel queries ──────────────────────────────────────────────────────
  const [
    clientRows,
    contactRows,
    vendorRows,
    estimateRows,
    invoiceRows,
    paymentRows,
    poRows,
    itemRows,
    jobRows,
    taskRows,
    attachmentRows,
    noteRows,
  ] = await Promise.all([
    // Clients
    can('clients.view')
      ? prisma.client.findMany({
          where: {
            tenantId,
            isActive: true,
            OR: [
              ...ilikeAny('name', terms),
              ...ilikeAny('companyName', terms),
              ...ilikeAny('email', terms),
              ...ilikeAny('phone', terms),
            ],
          },
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Contacts (returned inside Customers group)
    can('clients.view')
      ? prisma.contact.findMany({
          where: {
            client: { tenantId, isActive: true },
            OR: [
              ...ilikeAny('firstName', terms),
              ...ilikeAny('lastName', terms),
              ...ilikeAny('email', terms),
              ...ilikeAny('phone', terms),
            ],
          },
          include: { client: { select: { id: true, name: true, companyName: true } } },
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Vendors
    can('purchase_orders.view')
      ? prisma.vendor.findMany({
          where: {
            tenantId,
            OR: [
              ...ilikeAny('name', terms),
              ...ilikeAny('email', terms),
              ...ilikeAny('phone', terms),
              ...ilikeAny('vendorCode', terms),
            ],
          },
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Estimates
    can('estimates.view')
      ? prisma.estimate.findMany({
          where: {
            tenantId,
            OR: [
              ...ilikeAny('estimateNumber', terms),
              ...ilikeAny('title', terms),
              ...ilikeAny('notes', terms),
              { client: { OR: [...ilikeAny('name', terms), ...ilikeAny('companyName', terms)] } },
              { job: { OR: [...ilikeAny('jobNumber', terms), ...ilikeAny('title', terms)] } },
            ],
          },
          include: estimateInclude,
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Invoices
    can('invoices.view')
      ? prisma.invoice.findMany({
          where: {
            tenantId,
            OR: [
              ...ilikeAny('invoiceNumber', terms),
              ...ilikeAny('title', terms),
              ...ilikeAny('notes', terms),
              ...ilikeAny('memo', terms),
              { client: { OR: [...ilikeAny('name', terms), ...ilikeAny('companyName', terms)] } },
              { job: { OR: [...ilikeAny('jobNumber', terms), ...ilikeAny('title', terms)] } },
            ],
          },
          include: invoiceInclude,
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Payments (tenant-isolated through invoice relation)
    can('payments.view')
      ? prisma.payment.findMany({
          where: {
            invoice: { tenantId },
            OR: [
              ...ilikeAny('reference', terms),
              ...ilikeAny('notes', terms),
            ],
          },
          include: {
            invoice: { select: { id: true, invoiceNumber: true, client: { select: { name: true } } } },
          },
          take: fetch,
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve([]),

    // Purchase Orders
    can('purchase_orders.view')
      ? prisma.purchaseOrder.findMany({
          where: {
            tenantId,
            OR: [
              ...ilikeAny('poNumber', terms),
              ...ilikeAny('vendor', terms),
            ],
          },
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Items / Products / Materials
    can('settings.view')
      ? prisma.item.findMany({
          where: {
            tenantId,
            OR: [
              ...ilikeAny('name', terms),
              ...ilikeAny('sku', terms),
              ...ilikeAny('description', terms),
            ],
          },
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Jobs / Projects
    can('jobs.view')
      ? prisma.job.findMany({
          where: {
            tenantId,
            OR: [
              ...ilikeAny('jobNumber', terms),
              ...ilikeAny('title', terms),
              ...ilikeAny('description', terms),
              {
                client: {
                  OR: [
                    ...ilikeAny('name', terms),
                    ...ilikeAny('companyName', terms),
                  ],
                },
              },
            ],
          },
          include: {
            client: { select: { name: true, companyName: true } },
            addresses: {
              where: { type: 'job_site' },
              select: { street: true, city: true, state: true, zipCode: true },
              take: 1,
            },
          },
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Tasks
    can('tasks.view')
      ? prisma.task.findMany({
          where: {
            tenantId,
            OR: [
              ...ilikeAny('title', terms),
              ...ilikeAny('description', terms),
            ],
          },
          take: fetch,
          orderBy: { updatedAt: 'desc' },
        })
      : Promise.resolve([]),

    // Attachments / Files — tenant isolation via related entity
    prisma.attachment.findMany({
      where: {
        fileName: ilike(q),
        OR: [
          { client: { tenantId } },
          { job: { tenantId } },
          { estimate: { tenantId } },
          { invoice: { tenantId } },
          { purchaseOrder: { tenantId } },
          { vendor: { tenantId } },
        ],
      },
      include: {
        client: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
        estimate: { select: { id: true, estimateNumber: true } },
        job: { select: { id: true, jobNumber: true } },
        purchaseOrder: { select: { id: true, poNumber: true } },
        vendor: { select: { id: true, name: true } },
      },
      take: fetch,
      orderBy: { createdAt: 'desc' },
    }),

    // Notes — tenant isolation via client or job relation
    prisma.note.findMany({
      where: {
        content: ilike(q),
        OR: [{ client: { tenantId } }, { job: { tenantId } }],
      },
      include: {
        client: { select: { id: true, name: true, companyName: true } },
        job: { select: { id: true, jobNumber: true, title: true } },
      },
      take: fetch,
      orderBy: { updatedAt: 'desc' },
    }),
  ])

  // ── related entities for matched clients ──────────────────────────────────
  const matchedClientIds = new Set<string>()
  let maxClientScore = 0

  for (const c of clientRows as any[]) {
    matchedClientIds.add(c.id)
    maxClientScore = Math.max(
      maxClientScore,
      computeScore(q, [c.name, c.companyName], [c.email, c.phone], c.updatedAt)
    )
  }
  for (const ct of contactRows as any[]) {
    if (ct.client?.id) {
      matchedClientIds.add(ct.client.id)
      const fullName = `${ct.firstName} ${ct.lastName}`.trim()
      maxClientScore = Math.max(
        maxClientScore,
        computeScore(q, [ct.firstName, ct.lastName, fullName], [ct.email, ct.phone], ct.updatedAt)
      )
    }
  }

  const rootClientIds = Array.from(matchedClientIds)
  const descendantClientIds =
    rootClientIds.length > 0 && can('clients.view')
      ? await getDescendantClientIds(tenantId, rootClientIds)
      : []
  const relatedClientIds = Array.from(new Set([...rootClientIds, ...descendantClientIds]))

  const [subClientRows, relatedEstimateRows, relatedInvoiceRows, relatedJobRows] =
    relatedClientIds.length > 0
      ? await Promise.all([
          descendantClientIds.length > 0 && can('clients.view')
            ? prisma.client.findMany({
                where: {
                  tenantId,
                  isActive: true,
                  id: { in: descendantClientIds },
                },
                include: {
                  parent: { select: { name: true, companyName: true } },
                },
                take: fetch,
                orderBy: { updatedAt: 'desc' },
              })
            : Promise.resolve([]),
          can('estimates.view')
            ? prisma.estimate.findMany({
                where: { tenantId, clientId: { in: relatedClientIds } },
                include: estimateInclude,
                take: fetch,
                orderBy: { updatedAt: 'desc' },
              })
            : Promise.resolve([]),
          can('invoices.view')
            ? prisma.invoice.findMany({
                where: { tenantId, clientId: { in: relatedClientIds } },
                include: invoiceInclude,
                take: fetch,
                orderBy: { updatedAt: 'desc' },
              })
            : Promise.resolve([]),
          can('jobs.view')
            ? prisma.job.findMany({
                where: { tenantId, clientId: { in: relatedClientIds } },
                include: {
                  client: { select: { name: true, companyName: true } },
                  addresses: {
                    where: { type: 'job_site' },
                    select: { street: true, city: true, state: true, zipCode: true },
                    take: 1,
                  },
                },
                take: fetch,
                orderBy: { updatedAt: 'desc' },
              })
            : Promise.resolve([]),
        ])
      : [[], [], [], []]

  // ── map rows → scored results ─────────────────────────────────────────────
  const groups: SearchGroup[] = []

  // --- Customers (clients + contacts merged, deduped by client id) ----------
  const customerMap = new Map<string, SearchGroup['results'][0]>()

  for (const c of clientRows as any[]) {
    const sc = computeScore(q, [c.name, c.companyName], [c.email, c.phone], c.updatedAt)
    customerMap.set(c.id, {
      id: c.id,
      entityType: 'client',
      title: c.companyName || c.name,
      subtitle: [c.email, c.phone].filter(Boolean).join(' · ') || 'Customer',
      url: `/dashboard/clients/${c.id}`,
      score: sc,
      updatedAt: c.updatedAt,
    })
  }

  for (const ct of contactRows as any[]) {
    const fullName = `${ct.firstName} ${ct.lastName}`.trim()
    const clientId = ct.client?.id
    const sc = computeScore(q, [ct.firstName, ct.lastName, fullName], [ct.email, ct.phone], ct.updatedAt)
    // If the client is already in the map give it a score boost but don't add duplicate
    if (clientId && customerMap.has(clientId)) {
      const existing = customerMap.get(clientId)!
      existing.score = Math.max(existing.score, sc)
      if (!existing.subtitle.includes(fullName)) {
        existing.subtitle = `${fullName} · ${existing.subtitle}`.slice(0, 80)
      }
    } else {
      customerMap.set(ct.id, {
        id: ct.id,
        entityType: 'contact',
        title: fullName,
        subtitle: `Contact at ${ct.client?.companyName || ct.client?.name || ''}`,
        url: clientId ? `/dashboard/clients/${clientId}` : '#',
        score: sc,
        updatedAt: ct.updatedAt,
      })
    }
  }

  for (const sc of subClientRows as any[]) {
    if (customerMap.has(sc.id)) continue
    const parentLabel = sc.parent?.companyName || sc.parent?.name || 'parent client'
    customerMap.set(sc.id, {
      id: sc.id,
      entityType: 'client',
      title: sc.companyName || sc.name,
      subtitle: `Sub-client of ${parentLabel}`,
      url: `/dashboard/clients/${sc.id}`,
      score: relatedScore(maxClientScore, sc.updatedAt),
      updatedAt: sc.updatedAt,
    })
  }

  const customerResults = topN(Array.from(customerMap.values()), limitPerGroup)
  if (customerResults.length > 0) {
    groups.push({ type: 'customer', label: 'Customers', results: customerResults })
  }

  // --- Vendors --------------------------------------------------------------
  const vendorResults = topN(
    (vendorRows as any[]).map((v) => ({
      id: v.id,
      entityType: 'vendor',
      title: v.name,
      subtitle: [v.vendorCode, v.email, v.phone].filter(Boolean).join(' · ') || 'Vendor',
      url: `/dashboard/vendors/${v.id}`,
      score: computeScore(q, [v.name, v.vendorCode], [v.email, v.phone], v.updatedAt),
      updatedAt: v.updatedAt,
    })),
    limitPerGroup
  )
  if (vendorResults.length > 0) {
    groups.push({ type: 'vendor', label: 'Vendors', results: vendorResults })
  }

  // --- Estimates ------------------------------------------------------------
  const estimateMap = new Map<string, SearchGroup['results'][0]>()
  const mapEstimate = (e: any, score: number) => {
    const address = resolveEstimateAddress(e)
    const clientLabel = e.client?.companyName || e.client?.name
    estimateMap.set(e.id, {
      id: e.id,
      entityType: 'estimate',
      title: `${e.estimateNumber} — ${e.title}`,
      subtitle: [address, clientLabel].filter(Boolean).join(' · ') || e.status,
      url: `/dashboard/estimates/${e.id}`,
      score,
      updatedAt: e.updatedAt,
    })
  }
  for (const e of estimateRows as any[]) {
    mapEstimate(
      e,
      computeScore(
        q,
        [e.estimateNumber, e.title],
        [e.notes, e.client?.name, e.client?.companyName, resolveEstimateAddress(e)],
        e.updatedAt
      )
    )
  }
  for (const e of relatedEstimateRows as any[]) {
    if (estimateMap.has(e.id)) continue
    mapEstimate(e, relatedScore(maxClientScore, e.updatedAt))
  }
  const estimateResults = topN(Array.from(estimateMap.values()), limitPerGroup)
  if (estimateResults.length > 0) {
    groups.push({ type: 'estimate', label: 'Estimates', results: estimateResults })
  }

  // --- Invoices -------------------------------------------------------------
  const invoiceMap = new Map<string, SearchGroup['results'][0]>()
  const mapInvoice = (inv: any, score: number) => {
    const address = resolveInvoiceAddress(inv)
    const clientLabel = inv.client?.companyName || inv.client?.name
    invoiceMap.set(inv.id, {
      id: inv.id,
      entityType: 'invoice',
      title: `${inv.invoiceNumber} — ${inv.title}`,
      subtitle: [address, clientLabel].filter(Boolean).join(' · ') || inv.status,
      url: `/dashboard/invoices/${inv.id}`,
      score,
      updatedAt: inv.updatedAt,
    })
  }
  for (const inv of invoiceRows as any[]) {
    mapInvoice(
      inv,
      computeScore(
        q,
        [inv.invoiceNumber, inv.title],
        [inv.notes, inv.memo, inv.client?.name, resolveInvoiceAddress(inv)],
        inv.updatedAt
      )
    )
  }
  for (const inv of relatedInvoiceRows as any[]) {
    if (invoiceMap.has(inv.id)) continue
    mapInvoice(inv, relatedScore(maxClientScore, inv.updatedAt))
  }
  const invoiceResults = topN(Array.from(invoiceMap.values()), limitPerGroup)
  if (invoiceResults.length > 0) {
    groups.push({ type: 'invoice', label: 'Invoices', results: invoiceResults })
  }

  // --- Payments -------------------------------------------------------------
  const paymentResults = topN(
    (paymentRows as any[]).map((p) => ({
      id: p.id,
      entityType: 'payment',
      title: p.reference
        ? `Payment ${p.reference}`
        : `Payment on ${p.invoice?.invoiceNumber ?? ''}`,
      subtitle: [
        String(p.method).replace(/_/g, ' '),
        `$${Number(p.amount).toFixed(2)}`,
        p.status,
      ].join(' · '),
      url: `/dashboard/invoices/${p.invoice?.id ?? p.invoiceId}`,
      score: computeScore(q, [p.reference, p.invoice?.invoiceNumber], [p.notes], p.createdAt),
      updatedAt: p.createdAt,
    })),
    limitPerGroup
  )
  if (paymentResults.length > 0) {
    groups.push({ type: 'payment', label: 'Payments', results: paymentResults })
  }

  // --- Purchase Orders ------------------------------------------------------
  const poResults = topN(
    (poRows as any[]).map((po) => ({
      id: po.id,
      entityType: 'purchaseOrder',
      title: po.poNumber,
      subtitle: `${po.vendor} · ${po.status}`,
      url: `/dashboard/purchase-orders/${po.id}`,
      score: computeScore(q, [po.poNumber, po.vendor], [], po.updatedAt),
      updatedAt: po.updatedAt,
    })),
    limitPerGroup
  )
  if (poResults.length > 0) {
    groups.push({ type: 'purchaseOrder', label: 'Purchase Orders', results: poResults })
  }

  // --- Items ----------------------------------------------------------------
  const itemResults = topN(
    (itemRows as any[]).map((item) => ({
      id: item.id,
      entityType: 'item',
      title: item.name,
      subtitle: [item.sku, item.type, (item.description ?? '').slice(0, 50)]
        .filter(Boolean)
        .join(' · '),
      url: `/dashboard/items`,
      score: computeScore(q, [item.name, item.sku], [item.description, item.notes], item.updatedAt),
      updatedAt: item.updatedAt,
    })),
    limitPerGroup
  )
  if (itemResults.length > 0) {
    groups.push({ type: 'item', label: 'Items', results: itemResults })
  }

  // --- Projects / Jobs ------------------------------------------------------
  const jobMap = new Map<string, SearchGroup['results'][0]>()
  const mapJob = (job: any, score: number) => {
    const jobSiteAddress = formatAddressParts(job.addresses?.[0])
    const clientLabel = job.client?.companyName || job.client?.name
    jobMap.set(job.id, {
      id: job.id,
      entityType: 'job',
      title: `${job.jobNumber} — ${job.title}`,
      subtitle: [jobSiteAddress, clientLabel].filter(Boolean).join(' · ') || job.status,
      url: `/dashboard/jobs/${job.id}`,
      score,
      updatedAt: job.updatedAt,
    })
  }
  for (const job of jobRows as any[]) {
    const jobSiteAddress = formatAddressParts(job.addresses?.[0])
    mapJob(
      job,
      computeScore(
        q,
        [job.jobNumber, job.title],
        [job.description, job.client?.name, job.client?.companyName, jobSiteAddress],
        job.updatedAt
      )
    )
  }
  for (const job of relatedJobRows as any[]) {
    if (jobMap.has(job.id)) continue
    mapJob(job, relatedScore(maxClientScore, job.updatedAt))
  }
  const jobResults = topN(Array.from(jobMap.values()), limitPerGroup)
  if (jobResults.length > 0) {
    groups.push({ type: 'job', label: 'Projects', results: jobResults })
  }

  // --- Tasks ----------------------------------------------------------------
  const taskResults = topN(
    (taskRows as any[]).map((task) => ({
      id: task.id,
      entityType: 'task',
      title: task.title,
      subtitle: `${task.status} · ${task.priority}`,
      url: `/dashboard/tasks/${task.id}`,
      score: computeScore(q, [task.title], [task.description], task.updatedAt),
      updatedAt: task.updatedAt,
    })),
    limitPerGroup
  )
  if (taskResults.length > 0) {
    groups.push({ type: 'task', label: 'Tasks', results: taskResults })
  }

  // --- Files ----------------------------------------------------------------
  const fileResults = topN(
    (attachmentRows as any[]).map((att) => {
      let subtitle = 'File'
      let url = '#'
      if (att.client) {
        subtitle = `Client: ${att.client.name}`
        url = `/dashboard/clients/${att.client.id}`
      } else if (att.invoice) {
        subtitle = `Invoice ${att.invoice.invoiceNumber}`
        url = `/dashboard/invoices/${att.invoice.id}`
      } else if (att.estimate) {
        subtitle = `Estimate ${att.estimate.estimateNumber}`
        url = `/dashboard/estimates/${att.estimate.id}`
      } else if (att.job) {
        subtitle = `Project ${att.job.jobNumber}`
        url = `/dashboard/jobs/${att.job.id}`
      } else if (att.purchaseOrder) {
        subtitle = `PO ${att.purchaseOrder.poNumber}`
        url = `/dashboard/purchase-orders/${att.purchaseOrder.id}`
      } else if (att.vendor) {
        subtitle = `Vendor ${att.vendor.name}`
        url = `/dashboard/vendors/${att.vendor.id}`
      }
      return {
        id: att.id,
        entityType: 'file',
        title: att.fileName,
        subtitle,
        url,
        score: computeScore(q, [att.fileName], [], att.createdAt),
        updatedAt: att.createdAt,
      }
    }),
    limitPerGroup
  )
  if (fileResults.length > 0) {
    groups.push({ type: 'file', label: 'Files', results: fileResults })
  }

  // --- Notes ----------------------------------------------------------------
  const noteResults = topN(
    (noteRows as any[]).map((note) => {
      let parentName = ''
      let url = '#'
      if (note.client) {
        parentName = note.client.companyName || note.client.name
        url = `/dashboard/clients/${note.client.id}`
      } else if (note.job) {
        parentName = `${note.job.jobNumber} — ${note.job.title}`
        url = `/dashboard/jobs/${note.job.id}`
      }
      return {
        id: note.id,
        entityType: 'note',
        title:
          note.content.length > 80
            ? note.content.slice(0, 80) + '…'
            : note.content,
        subtitle: parentName || 'Note',
        url,
        score: computeScore(q, [note.content.slice(0, 100)], [], note.updatedAt),
        updatedAt: note.updatedAt,
      }
    }),
    limitPerGroup
  )
  if (noteResults.length > 0) {
    groups.push({ type: 'note', label: 'Notes', results: noteResults })
  }

  return groups
}
