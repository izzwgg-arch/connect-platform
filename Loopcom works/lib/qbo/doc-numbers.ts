import { prisma } from '@/lib/prisma'
import { getIntegrationConnection, getIntegrationSecrets } from '@/lib/integrations/status'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'

function esc(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export const ESTIMATE_NUMBER_QBO_CONFLICT_MESSAGE =
  'Estimate number already exists in QuickBooks. Please use a different estimate number.'

export const QBO_ESTIMATE_DOCNUMBER_UNAVAILABLE_MESSAGE =
  'QuickBooks is not connected or unavailable. Reconnect in Settings → Integrations before saving this estimate number.'

export type EstimateDocNumberErrorCode =
  | 'ESTIMATE_NUMBER_QBO_CONFLICT'
  | 'ESTIMATE_NUMBER_LOCAL_CONFLICT'
  | 'QBO_UNAVAILABLE'
  | 'QBO_API_ERROR'

export class EstimateDocNumberError extends Error {
  readonly code: EstimateDocNumberErrorCode
  readonly estimateNumber?: string

  constructor(code: EstimateDocNumberErrorCode, message: string, estimateNumber?: string) {
    super(message)
    this.name = 'EstimateDocNumberError'
    this.code = code
    this.estimateNumber = estimateNumber
  }
}

export function mapEstimateDocNumberErrorToResponse(error: unknown): { status: number; body: { error: string; code?: string; estimateNumber?: string } } | null {
  if (!(error instanceof EstimateDocNumberError)) return null
  const body: { error: string; code: string; estimateNumber?: string } = {
    error: error.message,
    code: error.code,
  }
  if (error.estimateNumber) body.estimateNumber = error.estimateNumber
  switch (error.code) {
    case 'ESTIMATE_NUMBER_QBO_CONFLICT':
    case 'ESTIMATE_NUMBER_LOCAL_CONFLICT':
      return { status: 409, body }
    case 'QBO_UNAVAILABLE':
    case 'QBO_API_ERROR':
      return { status: 503, body }
    default:
      return { status: 500, body: { error: error.message, code: error.code } }
  }
}

export function normalizeEstimateNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return `EST-${raw.padStart(6, '0')}`
  const match = raw.match(/^EST-(\d+)$/i)
  if (match) return `EST-${match[1].padStart(6, '0')}`
  return raw
}

export function normalizeInvoiceNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return `INV-${raw.padStart(6, '0')}`
  const match = raw.match(/^INV-(\d+)$/i)
  if (match) return `INV-${match[1].padStart(6, '0')}`
  return raw
}

export function normalizePurchaseOrderNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return `PO-${raw.padStart(6, '0')}`
  const match = raw.match(/^PO-(\d+)$/i)
  if (match) return `PO-${match[1].padStart(6, '0')}`
  return raw
}

export function normalizeCreditMemoNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return `CM-${raw.padStart(6, '0')}`
  const match = raw.match(/^CM-(\d+)$/i)
  if (match) return `CM-${match[1].padStart(6, '0')}`
  return raw
}

export async function allocateNextPurchaseOrderNumber(params: {
  tenantId: string
  db?: any
  maxAttempts?: number
}) {
  const db = params.db || prisma
  const maxAttempts = params.maxAttempts ?? 300
  const latestPo = await db.purchaseOrder.findFirst({
    where: {
      tenantId: params.tenantId,
      poNumber: { startsWith: 'PO-' },
    },
    orderBy: { poNumber: 'desc' },
    select: { poNumber: true },
  })
  const latestNumMatch = latestPo?.poNumber?.match(/^PO-(\d+)/)
  const latestNum = latestNumMatch ? parseInt(latestNumMatch[1], 10) : 0
  const baseNum = Number.isFinite(latestNum) ? latestNum : 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = `PO-${String(baseNum + attempt).padStart(6, '0')}`
    const localCollision = await db.purchaseOrder.findFirst({
      where: { poNumber: candidate },
      select: { id: true },
    })
    if (localCollision) continue
    return candidate
  }

  throw new Error('Unable to allocate an unused purchase order number.')
}

/** True when tenant has QuickBooks configured and DocNumber must be verified in QBO at save time. */
export async function tenantRequiresQboEstimateDocNumberCheck(tenantId: string): Promise<boolean> {
  const connection = await getIntegrationConnection(tenantId, 'quickbooks')
  if (connection?.status === 'CONNECTED') return true
  const secrets = await getIntegrationSecrets(tenantId, 'quickbooks')
  return Boolean(secrets?.realmId && secrets?.refreshToken)
}

export function buildSequentialEstimateNumber(baseNum: number, attempt: number): string {
  return `EST-${String(baseNum + attempt).padStart(6, '0')}`
}

/** Local-only next EST-* candidate (no QuickBooks API). */
export async function allocateNextEstimateNumber(params: {
  tenantId: string
  db?: any
  maxAttempts?: number
}) {
  const db = params.db || prisma
  const maxAttempts = params.maxAttempts ?? 300
  const latestEstimate = await db.estimate.findFirst({
    where: { estimateNumber: { startsWith: 'EST-' } },
    orderBy: { estimateNumber: 'desc' },
    select: { estimateNumber: true },
  })
  const latestNumMatch = latestEstimate?.estimateNumber?.match(/^EST-(\d+)/)
  const latestNum = latestNumMatch ? parseInt(latestNumMatch[1], 10) : 0
  const baseNum = Number.isFinite(latestNum) ? latestNum : 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = buildSequentialEstimateNumber(baseNum, attempt)
    const localCollision = await db.estimate.findFirst({
      where: { estimateNumber: candidate },
      select: { id: true },
    })
    if (!localCollision) return candidate
  }

  throw new Error('Unable to allocate an unused estimate number in TrimPro.')
}

export async function assertEstimateNumberNotUsedLocally(
  estimateNumber: string,
  options?: { excludeEstimateId?: string; db?: any }
) {
  const db = options?.db || prisma
  const existing = await db.estimate.findFirst({
    where: {
      estimateNumber,
      ...(options?.excludeEstimateId ? { id: { not: options.excludeEstimateId } } : {}),
    },
    select: { id: true },
  })
  if (existing) {
    throw new EstimateDocNumberError(
      'ESTIMATE_NUMBER_LOCAL_CONFLICT',
      `Estimate number ${estimateNumber} already exists in TrimPro. Use a different number.`,
      estimateNumber
    )
  }
}

export async function queryQboEstimateDocNumberExists(
  session: { accessToken: string; realmId: string },
  tenantId: string,
  docNumber: string,
  queryFn: typeof quickBooksService.query = quickBooksService.query.bind(quickBooksService)
): Promise<boolean> {
  const result = await queryFn(
    session.accessToken,
    session.realmId,
    `select Id, DocNumber from Estimate where DocNumber = '${esc(docNumber)}' maxresults 1`,
    {
      tenantId,
      entityType: 'estimate',
      triggerSource: 'estimate_docnumber_commit_check',
    }
  )
  const matches = result?.QueryResponse?.Estimate || []
  return Array.isArray(matches) && matches.length > 0
}

async function qboEstimateDocNumberExistsStrict(tenantId: string, estimateNumber: string): Promise<boolean> {
  const session = await getQboSessionForTenant(tenantId)
  if (!session) {
    throw new EstimateDocNumberError('QBO_UNAVAILABLE', QBO_ESTIMATE_DOCNUMBER_UNAVAILABLE_MESSAGE, estimateNumber)
  }
  try {
    return await queryQboEstimateDocNumberExists(session, tenantId, estimateNumber)
  } catch (error: any) {
    const detail = error?.message || 'QuickBooks request failed'
    throw new EstimateDocNumberError(
      'QBO_API_ERROR',
      `QuickBooks estimate number check failed: ${detail}`,
      estimateNumber
    )
  }
}

/** Single QBO DocNumber lookup at commit time. Skipped when QuickBooks is not configured for the tenant. */
export async function assertEstimateNumberAvailableInQuickBooks(tenantId: string, estimateNumber: string) {
  if (!(await tenantRequiresQboEstimateDocNumberCheck(tenantId))) return
  if (await qboEstimateDocNumberExistsStrict(tenantId, estimateNumber)) {
    throw new EstimateDocNumberError(
      'ESTIMATE_NUMBER_QBO_CONFLICT',
      `${ESTIMATE_NUMBER_QBO_CONFLICT_MESSAGE} (${estimateNumber})`,
      estimateNumber
    )
  }
}

/** Local DB check (cheap) then one QBO DocNumber lookup immediately before create/update. */
export async function assertEstimateNumberAvailableForCreate(
  tenantId: string,
  estimateNumber: string,
  options?: { excludeEstimateId?: string; db?: any }
) {
  await assertEstimateNumberNotUsedLocally(estimateNumber, options)
  await assertEstimateNumberAvailableInQuickBooks(tenantId, estimateNumber)
}

// --- Invoice helpers (unchanged QBO behavior during allocation) ---

async function qboDocNumberExists(
  tenantId: string,
  entityType: 'Estimate' | 'Invoice' | 'CreditMemo',
  docNumber: string
): Promise<boolean> {
  const session = await getQboSessionForTenant(tenantId)
  if (!session) return false

  const result = await quickBooksService.query(
    session.accessToken,
    session.realmId,
    `select Id, DocNumber from ${entityType} where DocNumber = '${esc(docNumber)}' maxresults 1`,
    {
      tenantId,
      entityType: entityType.toLowerCase(),
      triggerSource: `${entityType.toLowerCase()}_number_allocation`,
    }
  )
  const matches = result?.QueryResponse?.[entityType] || []
  return Array.isArray(matches) && matches.length > 0
}

async function qboInvoiceDocNumberExists(tenantId: string, invoiceNumber: string): Promise<boolean> {
  return qboDocNumberExists(tenantId, 'Invoice', invoiceNumber)
}

async function qboCreditMemoDocNumberExists(tenantId: string, creditMemoNumber: string): Promise<boolean> {
  return qboDocNumberExists(tenantId, 'CreditMemo', creditMemoNumber)
}

export async function assertInvoiceNumberAvailableInQuickBooks(
  tenantId: string,
  invoiceNumber: string
) {
  if (await qboInvoiceDocNumberExists(tenantId, invoiceNumber)) {
    throw new Error(`Invoice number ${invoiceNumber} already exists in QuickBooks. Use a different number.`)
  }
}

export async function assertCreditMemoNumberAvailableInQuickBooks(
  tenantId: string,
  creditMemoNumber: string
) {
  if (await qboCreditMemoDocNumberExists(tenantId, creditMemoNumber)) {
    throw new Error(`Credit memo number ${creditMemoNumber} already exists in QuickBooks. Use a different number.`)
  }
}

export async function allocateNextInvoiceNumber(params: {
  tenantId: string
  db?: any
  maxAttempts?: number
}) {
  const db = params.db || prisma
  const maxAttempts = params.maxAttempts ?? 300
  const latestInvoice = await db.invoice.findFirst({
    where: { invoiceNumber: { startsWith: 'INV-' } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  })
  const latestNumMatch = latestInvoice?.invoiceNumber?.match(/^INV-(\d+)/)
  const latestNum = latestNumMatch ? parseInt(latestNumMatch[1], 10) : 0
  const baseNum = Number.isFinite(latestNum) ? latestNum : 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = `INV-${String(baseNum + attempt).padStart(6, '0')}`
    const localCollision = await db.invoice.findFirst({
      where: { invoiceNumber: candidate },
      select: { id: true },
    })
    if (localCollision) continue
    if (await qboInvoiceDocNumberExists(params.tenantId, candidate)) continue
    return candidate
  }

  throw new Error('Unable to allocate an unused invoice number in TrimPro and QuickBooks.')
}

export async function allocateNextCreditMemoNumber(params: {
  tenantId: string
  db?: any
  maxAttempts?: number
}) {
  const db = params.db || prisma
  const maxAttempts = params.maxAttempts ?? 300
  const latest = await db.creditMemo.findFirst({
    where: {
      tenantId: params.tenantId,
      creditMemoNumber: { startsWith: 'CM-' },
    },
    orderBy: { creditMemoNumber: 'desc' },
    select: { creditMemoNumber: true },
  })
  const latestNumMatch = latest?.creditMemoNumber?.match(/^CM-(\d+)/)
  const latestNum = latestNumMatch ? parseInt(latestNumMatch[1], 10) : 0
  const baseNum = Number.isFinite(latestNum) ? latestNum : 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = `CM-${String(baseNum + attempt).padStart(6, '0')}`
    const localCollision = await db.creditMemo.findFirst({
      where: { creditMemoNumber: candidate },
      select: { id: true },
    })
    if (localCollision) continue
    if (await qboCreditMemoDocNumberExists(params.tenantId, candidate)) continue
    return candidate
  }

  throw new Error('Unable to allocate an unused credit memo number in TrimPro and QuickBooks.')
}
