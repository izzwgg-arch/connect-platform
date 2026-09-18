import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { normalizeCreditMemoNumber } from '@/lib/qbo/doc-numbers'
import { quickBooksService } from '@/lib/services/quickbooks'

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function statusForRemaining(remaining: number, total: number): 'SENT' | 'PARTIALLY_APPLIED' | 'APPLIED' {
  if (remaining <= 0.005) return 'APPLIED'
  if (remaining < total - 0.005) return 'PARTIALLY_APPLIED'
  return 'SENT'
}

async function resolveQboCustomerToLocalClientId(
  tenantId: string,
  integrationId: string,
  qboCustomerId: string
): Promise<string | null> {
  const key = String(qboCustomerId || '').trim()
  if (!key) return null

  const rows = await prisma.quickBooksSyncLog.findMany({
    where: {
      integrationId,
      type: 'client',
      status: 'success',
      qboId: key,
      entityId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true },
  })

  const orderedIds: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = String(row.entityId)
    if (seen.has(id)) continue
    seen.add(id)
    orderedIds.push(id)
  }
  if (!orderedIds.length) return null

  const clients = await prisma.client.findMany({
    where: { tenantId, id: { in: orderedIds } },
    select: { id: true, parentId: true },
  })
  const parentById = new Map(clients.map((c) => [c.id, c.parentId]))
  for (const id of orderedIds) {
    if (parentById.get(id)) return id
  }
  return orderedIds[0] || null
}

function mapQboLines(qboLines: any[], fallbackTotal: number) {
  const lineRows = (Array.isArray(qboLines) ? qboLines : [])
    .filter((l) => l && typeof l === 'object')
    .filter((l) => {
      const dt = String(l.DetailType || '')
      return dt !== 'SubTotalLineDetail' && dt !== 'DescriptionOnly'
    })
    .map((l, idx) => {
      const amount = toNumber(l.Amount)
      if (!amount) return null
      const qty = toNumber(l?.SalesItemLineDetail?.Qty) || 1
      const unitPrice =
        toNumber(l?.SalesItemLineDetail?.UnitPrice) || (qty ? amount / qty : amount)
      const itemName = String(l?.SalesItemLineDetail?.ItemRef?.name || '') || ''
      const description = String(l.Description || '')
      const finalDescription = itemName || description || `QuickBooks line ${idx + 1}`
      const finalNotes = description && itemName ? description : null
      return {
        description: finalDescription.slice(0, 500),
        notes: finalNotes ? finalNotes.slice(0, 2000) : null,
        quantity: qty,
        unitPrice,
        total: amount,
        sortOrder: idx,
        taxable: true,
      }
    })
    .filter(Boolean) as Array<{
    description: string
    notes: string | null
    quantity: number
    unitPrice: number
    total: number
    sortOrder: number
    taxable: boolean
  }>

  if (lineRows.length) return lineRows
  return [
    {
      description: 'Imported from QuickBooks',
      notes: null,
      quantity: 1,
      unitPrice: fallbackTotal,
      total: fallbackTotal,
      sortOrder: 0,
      taxable: true,
    },
  ]
}

async function allocateImportedNumber(tenantId: string, docNumber: string, qboId: string) {
  const normalized = normalizeCreditMemoNumber(docNumber)
  let base =
    normalized && /^CM-\d+$/i.test(normalized)
      ? normalized
      : docNumber
        ? `QB-${docNumber}`
        : `QB-CM-${qboId}`

  let candidate = base
  const collision = await prisma.creditMemo.findFirst({
    where: { creditMemoNumber: candidate },
    select: { id: true },
  })
  if (collision) {
    candidate = `${base}-${qboId.slice(-6)}`
  }

  // Tenant-local uniqueness is covered by global unique; still ensure final uniqueness.
  const again = await prisma.creditMemo.findFirst({
    where: { creditMemoNumber: candidate },
    select: { id: true },
  })
  if (again) {
    candidate = `QB-CM-${qboId}`
  }
  return candidate
}

export async function importQuickBooksCreditMemos(tenantId: string) {
  const session = await getQboSessionForTenant(tenantId)
  if (!session) {
    throw new Error('QuickBooks is not connected for this tenant.')
  }

  const integration = await prisma.quickBooksIntegration.findUnique({
    where: { tenantId },
    select: { id: true },
  })
  if (!integration?.id) {
    throw new Error('QuickBooks integration record not found. Reconnect QuickBooks in Settings.')
  }

  let fetched = 0
  let openScanned = 0
  let created = 0
  let updated = 0
  let skippedMissingClient = 0
  let skippedZeroBalance = 0
  const errors: string[] = []

  for (let start = 1; start <= 10000; start += 1000) {
    const query = `select * from CreditMemo startposition ${start} maxresults 1000`
    const res = await quickBooksService.query(session.accessToken, session.realmId, query)
    const creditMemos = res?.QueryResponse?.CreditMemo || []
    const rows = Array.isArray(creditMemos) ? creditMemos : creditMemos ? [creditMemos] : []
    if (!rows.length) break
    fetched += rows.length

    for (const cm of rows) {
      try {
        const qboId = String(cm?.Id || '').trim()
        if (!qboId) continue

        const totalAmt = round2(toNumber(cm.TotalAmt))
        const remaining = round2(toNumber(cm.Balance))
        // Import open/unapplied credits; refresh already-imported rows even if zero.
        const existing = await prisma.creditMemo.findFirst({
          where: { tenantId, qboSyncId: qboId },
          select: { id: true, clientId: true },
        })

        if (remaining <= 0 && !existing) {
          skippedZeroBalance += 1
          continue
        }
        if (remaining > 0) openScanned += 1

        const customerQboId = cm?.CustomerRef?.value ? String(cm.CustomerRef.value) : ''
        const resolvedClientId = customerQboId
          ? await resolveQboCustomerToLocalClientId(tenantId, integration.id, customerQboId)
          : null

        const docNumber = String(cm.DocNumber || '').trim()
        const txnDateRaw = cm.TxnDate ? String(cm.TxnDate) : null
        const creditMemoDate = txnDateRaw ? new Date(`${txnDateRaw}T00:00:00.000Z`) : new Date()
        const taxAmount = round2(toNumber(cm?.TxnTaxDetail?.TotalTax))
        const subtotal = round2(Math.max(0, totalAmt - taxAmount))
        const appliedAmount = round2(Math.max(0, totalAmt - remaining))
        const status = statusForRemaining(remaining, totalAmt)
        const title = `QuickBooks Credit Memo ${docNumber || qboId}`
        const notes = cm.PrivateNote
          ? String(cm.PrivateNote)
          : 'Imported from QuickBooks credit memo import'
        const lines = mapQboLines(cm.Line, subtotal || totalAmt)

        if (existing) {
          if (resolvedClientId && existing.clientId !== resolvedClientId) {
            await prisma.creditMemo.update({
              where: { id: existing.id },
              data: { clientId: resolvedClientId },
            })
          }
          await prisma.creditMemo.update({
            where: { id: existing.id },
            data: {
              status,
              subtotal,
              taxAmount,
              total: totalAmt,
              appliedAmount,
              remainingCredit: Math.max(0, remaining),
              creditMemoDate,
              notes,
              qboSyncAt: new Date(),
            },
          })
          updated += 1
          continue
        }

        if (!resolvedClientId) {
          skippedMissingClient += 1
          errors.push(
            `Credit memo skipped (missing client mapping): QB ${docNumber || qboId}`
          )
          continue
        }

        const creditMemoNumber = await allocateImportedNumber(tenantId, docNumber, qboId)
        const createdCm = await prisma.creditMemo.create({
          data: {
            tenantId,
            clientId: resolvedClientId,
            creditMemoNumber,
            title,
            status,
            subtotal,
            taxRate: 0,
            taxAmount,
            total: totalAmt,
            appliedAmount,
            remainingCredit: Math.max(0, remaining),
            creditMemoDate,
            notes,
            memo: null,
            qboSyncId: qboId,
            qboSyncAt: new Date(),
            lineItems: {
              create: lines.map(({ taxable, ...rest }) => rest),
            },
          },
        })

        await prisma.quickBooksSyncLog.create({
          data: {
            integrationId: integration.id,
            type: 'credit_memo',
            action: 'import',
            status: 'success',
            entityId: createdCm.id,
            qboId,
            data: { docNumber: docNumber || null, remaining },
          },
        })

        created += 1
      } catch (error: any) {
        errors.push(`Credit memo import failed: ${error?.message || 'Unknown error'}`)
      }
    }

    if (rows.length < 1000) break
  }

  return {
    fetchedFromQuickBooks: fetched,
    openCreditMemosScanned: openScanned,
    created,
    updated,
    skippedMissingClient,
    skippedZeroBalance,
    errors: errors.slice(0, 40),
  }
}

async function summarizeLocalCreditMemo(id: string) {
  const cm = await prisma.creditMemo.findUnique({
    where: { id },
    select: {
      id: true,
      creditMemoNumber: true,
      title: true,
      status: true,
      total: true,
      remainingCredit: true,
      _count: { select: { lineItems: true } },
      client: {
        select: { id: true, name: true, companyName: true },
      },
    },
  })
  if (!cm) return null
  return {
    id: cm.id,
    creditMemoNumber: cm.creditMemoNumber,
    title: cm.title,
    status: cm.status,
    total: Number(cm.total),
    remainingCredit: Number(cm.remainingCredit),
    lineItemCount: cm._count.lineItems,
    client: cm.client,
  }
}

/**
 * Manual one-off import of a single QuickBooks CreditMemo by txn Id.
 * Creates a placeholder client if the QBO customer is not mapped yet.
 */
export async function importQuickBooksCreditMemoById(tenantId: string, qboCreditMemoId: string) {
  const normalizedId = String(qboCreditMemoId || '').trim()
  if (!/^\d+$/.test(normalizedId)) {
    throw new Error('QuickBooks credit memo ID must be a numeric value.')
  }

  const session = await getQboSessionForTenant(tenantId)
  if (!session) {
    throw new Error('QuickBooks is not connected for this tenant.')
  }

  const integration = await prisma.quickBooksIntegration.findUnique({
    where: { tenantId },
    select: { id: true },
  })
  if (!integration?.id) {
    throw new Error('QuickBooks integration record not found. Reconnect QuickBooks in Settings.')
  }

  const existing = await prisma.creditMemo.findFirst({
    where: { tenantId, qboSyncId: normalizedId },
    select: { id: true },
  })
  if (existing) {
    const summary = await summarizeLocalCreditMemo(existing.id)
    await prisma.quickBooksSyncLog.create({
      data: {
        integrationId: integration.id,
        type: 'credit_memo',
        action: 'import',
        status: 'conflict',
        entityId: existing.id,
        qboId: normalizedId,
        error: 'Credit memo already imported',
      },
    })
    return {
      alreadyImported: true as const,
      creditMemo: summary,
      placeholderClientCreated: false,
      placeholderClient: null,
    }
  }

  const qboResponse = await quickBooksService.makeAPIRequest(
    session.accessToken,
    session.realmId,
    `/creditmemo/${encodeURIComponent(normalizedId)}`,
    'GET',
    undefined,
    {
      tenantId,
      entityType: 'credit_memo',
      entityId: normalizedId,
      triggerSource: 'manual_credit_memo_import_by_id',
    }
  )

  const qboCm = qboResponse?.CreditMemo
  if (!qboCm?.Id) {
    throw new Error('QuickBooks credit memo not found.')
  }

  const customerQboId = qboCm?.CustomerRef?.value ? String(qboCm.CustomerRef.value).trim() : ''
  const customerDisplayName = String(qboCm?.CustomerRef?.name || '').trim()

  let clientId =
    customerQboId
      ? await resolveQboCustomerToLocalClientId(tenantId, integration.id, customerQboId)
      : null
  let placeholderClientCreated = false
  let placeholderClient: { id: string; name: string } | null = null

  if (customerQboId && !clientId) {
    const createdClient = await prisma.client.create({
      data: {
        tenantId,
        name: customerDisplayName || `QuickBooks Client ${customerQboId}`,
        companyName: null,
        email: null,
        phone: null,
        notes: `Imported from QuickBooks credit memo ${normalizedId} (client placeholder).`,
        isActive: true,
      },
    })
    await prisma.quickBooksSyncLog.create({
      data: {
        integrationId: integration.id,
        type: 'client',
        action: 'import',
        status: 'success',
        entityId: createdClient.id,
        qboId: customerQboId,
        data: {
          source: 'manual_credit_memo_import_placeholder',
          creditMemoQboId: normalizedId,
        },
      },
    })
    clientId = createdClient.id
    placeholderClientCreated = true
    placeholderClient = { id: createdClient.id, name: createdClient.name }
  }

  if (!clientId) {
    throw new Error('QuickBooks credit memo has no customer to map.')
  }

  const qboId = String(qboCm.Id)
  const totalAmt = round2(toNumber(qboCm.TotalAmt))
  const remaining = round2(toNumber(qboCm.Balance))
  const taxAmount = round2(toNumber(qboCm?.TxnTaxDetail?.TotalTax))
  const subtotal = round2(Math.max(0, totalAmt - taxAmount))
  const appliedAmount = round2(Math.max(0, totalAmt - remaining))
  const status = statusForRemaining(remaining, totalAmt)
  const docNumber = String(qboCm.DocNumber || '').trim()
  const txnDateRaw = qboCm.TxnDate ? String(qboCm.TxnDate) : null
  const creditMemoDate = txnDateRaw ? new Date(`${txnDateRaw}T00:00:00.000Z`) : new Date()
  const title = `QuickBooks Credit Memo ${docNumber || qboId}`
  const notes = qboCm.PrivateNote
    ? String(qboCm.PrivateNote)
    : 'Imported from QuickBooks credit memo import by ID.'
  const lines = mapQboLines(qboCm.Line, subtotal || totalAmt)
  const creditMemoNumber = await allocateImportedNumber(tenantId, docNumber, qboId)

  const createdCm = await prisma.creditMemo.create({
    data: {
      tenantId,
      clientId,
      creditMemoNumber,
      title,
      status,
      subtotal,
      taxRate: 0,
      taxAmount,
      total: totalAmt,
      appliedAmount,
      remainingCredit: Math.max(0, remaining),
      creditMemoDate,
      notes,
      memo: null,
      qboSyncId: qboId,
      qboSyncAt: new Date(),
      lineItems: {
        create: lines.map(({ taxable, ...rest }) => rest),
      },
    },
  })

  await prisma.quickBooksSyncLog.create({
    data: {
      integrationId: integration.id,
      type: 'credit_memo',
      action: 'import',
      status: 'success',
      entityId: createdCm.id,
      qboId,
      data: {
        source: 'manual_credit_memo_import_by_id',
        docNumber: docNumber || null,
        remaining,
      },
    },
  })

  return {
    alreadyImported: false as const,
    creditMemo: await summarizeLocalCreditMemo(createdCm.id),
    placeholderClientCreated,
    placeholderClient,
  }
}
