import { prisma } from '@/lib/prisma'
import { quickBooksService } from '@/lib/services/quickbooks'

const LOOKUP_CACHE_TTL_MS = 30 * 60 * 1000

type CachedCatalog = {
  methods: Array<{ id: string; name: string }>
  expiresAt: number
}

const paymentMethodCatalogCache = new Map<string, CachedCatalog>()

function cacheKey(tenantId: string, realmId: string) {
  return `${tenantId}|${realmId}`.toLowerCase()
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const trimmed = String(name || '').trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

export type PaymentMethodMappingInput = {
  method: string
  provider?: string | null
  notes?: string | null
  providerPaymentId?: string | null
  solaTransactionId?: string | null
}

/** Payments already recorded in QuickBooks (ACH hosted, webhooks) must not be pushed again. */
export function shouldSkipOutboundQboPaymentSync(payment: PaymentMethodMappingInput): boolean {
  const method = String(payment.method || '').toUpperCase()
  const provider = String(payment.provider || '').toLowerCase()
  return provider === 'quickbooks' || method === 'ACH'
}

/** Candidate QBO PaymentMethod names to match for a TrimPro payment. */
export function resolveOutboundQboPaymentMethodNames(payment: PaymentMethodMappingInput): string[] {
  const method = String(payment.method || '').toUpperCase()
  const provider = String(payment.provider || '').toLowerCase()
  const notes = String(payment.notes || '')
  const names: string[] = []

  const isCard =
    method === 'CARD' ||
    provider === 'sola' ||
    Boolean(payment.solaTransactionId)

  if (isCard) {
    return uniqueNames(['Credit Card', 'Debit Card', 'Card'])
  }
  if (method === 'CHECK') {
    return uniqueNames(['Check'])
  }
  if (method === 'CASH' || provider === 'cash') {
    return uniqueNames(['Cash'])
  }
  if (method === 'CREDIT' || provider === 'credit_memo') {
    return uniqueNames(['Credits', 'Credit Memo', 'Credit'])
  }
  if (method === 'BANK_TRANSFER' || provider === 'bank_transfer') {
    return uniqueNames(['Bank Transfer', 'EFT', 'Wire', 'Transfer'])
  }
  if (provider === 'quick_pay') {
    return uniqueNames(['QuickBooks Payments', 'Quick Pay', 'QuickBooks'])
  }
  if (provider === 'zelle') {
    names.push('Zelle')
  }
  if (provider === 'venmo') {
    names.push('Venmo')
  }

  const noteMatch = notes.match(/paid — (.+)$/i)
  if (noteMatch?.[1]) {
    const label = noteMatch[1].trim()
    names.push(label, titleCase(label))
  }

  if (provider && !['manual', 'quickbooks', 'sola', 'quick_pay'].includes(provider)) {
    names.push(titleCase(provider.replace(/_/g, ' ')))
  }

  return uniqueNames(names)
}

/** Map a QBO PaymentMethod name to local Payment.method + notes. */
export function mapInboundQboPaymentMethodFromName(qboMethodName?: string | null): {
  method: 'CARD' | 'CHECK' | 'CASH' | 'ACH' | 'BANK_TRANSFER' | 'OTHER'
  notes: string | null
} {
  const name = String(qboMethodName || '').trim()
  if (!name) {
    return { method: 'OTHER', notes: 'QuickBooks payment' }
  }

  const lower = name.toLowerCase()
  if (lower.includes('credit card') || lower === 'card' || lower.includes('debit card')) {
    return { method: 'CARD', notes: `QuickBooks — ${name}` }
  }
  if (lower.includes('check') || lower === 'cheque') {
    return { method: 'CHECK', notes: `QuickBooks — ${name}` }
  }
  if (lower === 'cash') {
    return { method: 'CASH', notes: `QuickBooks — ${name}` }
  }
  if (
    lower.includes('ach') ||
    lower.includes('e-check') ||
    lower.includes('echeck') ||
    lower.includes('electronic')
  ) {
    return { method: 'ACH', notes: `QuickBooks — ${name}` }
  }
  if (lower.includes('bank transfer') || lower.includes('wire') || lower === 'eft') {
    return { method: 'BANK_TRANSFER', notes: `QuickBooks — ${name}` }
  }

  return { method: 'OTHER', notes: `QuickBooks — ${name}` }
}

async function fetchPaymentMethodCatalog(params: {
  tenantId: string
  paymentId: string
  accessToken: string
  realmId: string
}): Promise<Array<{ id: string; name: string }>> {
  const key = cacheKey(params.tenantId, params.realmId)
  const cached = paymentMethodCatalogCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.methods
  }

  const query = encodeURIComponent('select Id, Name from PaymentMethod')
  const res = await quickBooksService.makeAPIRequest(
    params.accessToken,
    params.realmId,
    `/query?query=${query}&minorversion=65`,
    'GET',
    undefined,
    {
      tenantId: params.tenantId,
      entityType: 'payment',
      entityId: params.paymentId,
      triggerSource: 'payment_method_catalog',
    }
  )

  const methods = (Array.isArray(res?.QueryResponse?.PaymentMethod)
    ? res.QueryResponse.PaymentMethod
    : res?.QueryResponse?.PaymentMethod
      ? [res.QueryResponse.PaymentMethod]
      : []
  )
    .map((row: any) => ({
      id: String(row?.Id || ''),
      name: String(row?.Name || '').trim(),
    }))
    .filter((row) => row.id && row.name)

  paymentMethodCatalogCache.set(key, {
    methods,
    expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
  })

  return methods
}

export async function resolveQboPaymentMethodId(params: {
  tenantId: string
  paymentId: string
  accessToken: string
  realmId: string
  names: string[]
}): Promise<string | null> {
  const candidates = uniqueNames(params.names)
  if (candidates.length === 0) return null

  const catalog = await fetchPaymentMethodCatalog(params)
  if (catalog.length === 0) return null

  const byExact = new Map(catalog.map((row) => [row.name.toLowerCase(), row.id]))
  for (const name of candidates) {
    const hit = byExact.get(name.toLowerCase())
    if (hit) return hit
  }

  for (const name of candidates) {
    const needle = name.toLowerCase()
    const partial = catalog.find(
      (row) =>
        row.name.toLowerCase().includes(needle) || needle.includes(row.name.toLowerCase())
    )
    if (partial) return partial.id
  }

  return null
}

/** Record that a local payment already exists in QBO (prevents duplicate Receive Payment sync). */
export async function recordPaymentQboMapping(params: {
  tenantId: string
  localPaymentId: string
  qboPaymentId: string
  action?: string
}) {
  const integration = await prisma.quickBooksIntegration.findUnique({
    where: { tenantId: params.tenantId },
    select: { id: true },
  })
  if (!integration?.id || !params.qboPaymentId) return

  const existing = await prisma.quickBooksSyncLog.findFirst({
    where: {
      integrationId: integration.id,
      type: 'payment',
      entityId: params.localPaymentId,
      status: 'success',
      qboId: params.qboPaymentId,
    },
    select: { id: true },
  })
  if (existing) return

  await prisma.quickBooksSyncLog.create({
    data: {
      integrationId: integration.id,
      type: 'payment',
      action: params.action || 'import',
      status: 'success',
      entityId: params.localPaymentId,
      qboId: params.qboPaymentId,
    },
  })
}

export async function fetchQboPaymentMethodName(params: {
  tenantId: string
  paymentId: string
  accessToken: string
  realmId: string
  paymentMethodRefId: string
}): Promise<string | null> {
  const refId = String(params.paymentMethodRefId || '').trim()
  if (!refId) return null

  try {
    const res = await quickBooksService.makeAPIRequest(
      params.accessToken,
      params.realmId,
      `/paymentmethod/${encodeURIComponent(refId)}`,
      'GET',
      undefined,
      {
        tenantId: params.tenantId,
        entityType: 'payment',
        entityId: params.paymentId,
        triggerSource: 'payment_method_lookup',
      }
    )
    const name = res?.PaymentMethod?.Name
    return name ? String(name).trim() : null
  } catch {
    return null
  }
}
