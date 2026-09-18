import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import {
  allocateNextCreditMemoNumber,
  normalizeCreditMemoNumber,
  assertCreditMemoNumberAvailableInQuickBooks,
} from '@/lib/qbo/doc-numbers'
import { computeCreditMemoTotals } from '@/lib/credit-memos/apply-credit'
import { applySmartSearch, buildSmartSearchAnd, clientIdentityClauses, ilike } from '@/lib/search/prisma-filters'

function serializeCreditMemo(cm: any) {
  return {
    ...cm,
    subtotal: Number(cm.subtotal),
    taxRate: cm.taxRate != null ? Number(cm.taxRate) : 0,
    taxAmount: cm.taxAmount != null ? Number(cm.taxAmount) : 0,
    total: Number(cm.total),
    appliedAmount: Number(cm.appliedAmount),
    remainingCredit: Number(cm.remainingCredit),
    lineItems: Array.isArray(cm.lineItems)
      ? cm.lineItems.map((li: any) => ({
          ...li,
          quantity: Number(li.quantity),
          unitPrice: Number(li.unitPrice),
          total: Number(li.total),
        }))
      : [],
    applications: Array.isArray(cm.applications)
      ? cm.applications.map((a: any) => ({
          ...a,
          amount: Number(a.amount),
        }))
      : cm.applications,
  }
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || 'all'
  const clientId = searchParams.get('clientId') || ''
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)
  const skip = (page - 1) * limit

  try {
    const where: any = { tenantId: user.tenantId }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { creditMemoNumber: ilike(term) },
        { title: ilike(term) },
        ...clientIdentityClauses(term),
        { job: { jobNumber: ilike(term) } },
      ])
    )

    if (status !== 'all') where.status = status
    if (clientId) where.clientId = clientId

    const [rows, total] = await Promise.all([
      prisma.creditMemo.findMany({
        where,
        include: {
          client: { select: { id: true, name: true, companyName: true, email: true } },
          job: { select: { id: true, jobNumber: true, title: true } },
          sourceInvoice: { select: { id: true, invoiceNumber: true } },
          _count: { select: { lineItems: true, applications: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.creditMemo.count({ where }),
    ])

    return NextResponse.json({
      creditMemos: rows.map(serializeCreditMemo),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    })
  } catch (error) {
    console.error('List credit memos error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      clientId,
      jobId,
      sourceInvoiceId,
      creditMemoNumber,
      title,
      notes,
      memo,
      taxRate,
      lineItems,
      creditMemoDate,
    } = body || {}

    if (!clientId) {
      return NextResponse.json({ error: 'Client is required' }, { status: 400 })
    }

    const client = await prisma.client.findFirst({
      where: { id: clientId, tenantId: user.tenantId },
      select: { id: true },
    })
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    let resolvedJobId = jobId || null
    let resolvedSourceInvoiceId = sourceInvoiceId || null
    let seedLines = Array.isArray(lineItems) ? lineItems : []

    if (resolvedJobId) {
      const job = await prisma.job.findFirst({
        where: { id: resolvedJobId, tenantId: user.tenantId, clientId },
        select: { id: true },
      })
      if (!job) {
        return NextResponse.json(
          { error: 'Job not found for the selected client' },
          { status: 400 }
        )
      }
    }

    if (sourceInvoiceId) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: sourceInvoiceId, tenantId: user.tenantId },
        include: {
          lineItems: { orderBy: { sortOrder: 'asc' } },
        },
      })
      if (!invoice) {
        return NextResponse.json({ error: 'Source invoice not found' }, { status: 404 })
      }
      if (invoice.clientId !== clientId) {
        return NextResponse.json(
          { error: 'Source invoice must belong to the selected client' },
          { status: 400 }
        )
      }
      resolvedJobId = resolvedJobId || invoice.jobId
      resolvedSourceInvoiceId = invoice.id
      if (!seedLines.length) {
        seedLines = invoice.lineItems
          .filter((li) => !(li as any).isSubtotal)
          .map((li) => ({
            description: li.description,
            quantity: Number(li.quantity),
            unitPrice: Number(li.unitPrice),
            notes: li.notes || null,
            taxable: li.taxable !== false,
          }))
      }
    }

    if (!seedLines.length) {
      return NextResponse.json({ error: 'At least one line item is required' }, { status: 400 })
    }

    const normalizedLines = seedLines.map((li: any, index: number) => {
      const quantity = Number(li.quantity || 0)
      const unitPrice = Number(li.unitPrice || 0)
      return {
        description: String(li.description || '').trim() || 'Credit',
        quantity,
        unitPrice,
        total: Math.round(quantity * unitPrice * 100) / 100,
        sortOrder: index,
        notes: li.notes || null,
        taxable: li.taxable !== false,
      }
    })

    const totals = computeCreditMemoTotals(
      normalizedLines,
      taxRate != null ? Number(taxRate) : 0
    )

    let number =
      normalizeCreditMemoNumber(creditMemoNumber) ||
      (await allocateNextCreditMemoNumber({ tenantId: user.tenantId }))

    if (creditMemoNumber) {
      await assertCreditMemoNumberAvailableInQuickBooks(user.tenantId, number)
      const local = await prisma.creditMemo.findFirst({
        where: { creditMemoNumber: number },
        select: { id: true },
      })
      if (local) {
        return NextResponse.json(
          { error: `Credit memo number ${number} already exists` },
          { status: 409 }
        )
      }
    }

    const created = await prisma.creditMemo.create({
      data: {
        tenantId: user.tenantId,
        clientId,
        jobId: resolvedJobId,
        sourceInvoiceId: resolvedSourceInvoiceId,
        creditMemoNumber: number,
        title: String(title || 'Credit Memo').trim() || 'Credit Memo',
        status: 'DRAFT',
        subtotal: totals.subtotal,
        taxRate: taxRate != null ? Number(taxRate) : 0,
        taxAmount: totals.taxAmount,
        total: totals.total,
        appliedAmount: 0,
        remainingCredit: totals.remainingCredit,
        creditMemoDate: creditMemoDate ? new Date(creditMemoDate) : new Date(),
        notes: notes || null,
        memo: memo || null,
        lineItems: {
          create: normalizedLines.map(({ taxable, ...rest }) => rest),
        },
        activities: {
          create: {
            tenantId: user.tenantId,
            userId: user.id,
            type: 'OTHER',
            description: `Credit memo ${number} created`,
            clientId,
          },
        },
      },
      include: {
        client: { select: { id: true, name: true, companyName: true, email: true } },
        job: { select: { id: true, jobNumber: true, title: true } },
        sourceInvoice: { select: { id: true, invoiceNumber: true } },
        lineItems: { orderBy: { sortOrder: 'asc' } },
      },
    })

    try {
      await enqueueQboSync(user.tenantId, 'credit_memo', created.id)
    } catch (e) {
      console.error('QBO credit memo sync trigger error (create):', e)
    }

    return NextResponse.json({ creditMemo: serializeCreditMemo(created) }, { status: 201 })
  } catch (error: any) {
    console.error('Create credit memo error:', error)
    return NextResponse.json(
      { error: error?.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
