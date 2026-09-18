import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'

const MAX_LIMIT = 200

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(Number(body?.limit) || MAX_LIMIT, MAX_LIMIT)
    const dryRun = body?.dryRun === true

    // Get invoices that were imported from QuickBooks (have qboSyncId)
    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: user.tenantId,
        qboSyncId: { not: null },
      },
      include: {
        lineItems: {
          orderBy: { sortOrder: 'asc' },
        },
      },
      take: limit,
    })

    if (invoices.length === 0) {
      return NextResponse.json({
        message: 'No QuickBooks-imported invoices found to update',
        updated: 0,
      })
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        message: `Dry run: would scan ${invoices.length} QuickBooks-imported invoice(s). Pass dryRun: false to apply.`,
        invoiceCount: invoices.length,
        limit,
      })
    }

    const session = await getQboSessionForTenant(user.tenantId)
    if (!session) {
      return NextResponse.json(
        { error: 'QuickBooks integration not configured' },
        { status: 400 }
      )
    }

    let updatedCount = 0
    let errorCount = 0
    const errors: string[] = []

    for (const invoice of invoices) {
      try {
        if (!invoice.qboSyncId) continue

        const qboInvoice = await quickBooksService.makeAPIRequest(
          session.accessToken,
          session.realmId,
          `/invoice/${invoice.qboSyncId}`,
          'GET',
          undefined,
          {
            tenantId: user.tenantId,
            entityType: 'invoice',
            entityId: invoice.id,
            triggerSource: 'admin_update_line_items',
          }
        )

        const inv = qboInvoice?.Invoice || qboInvoice
        if (!inv || !inv.Line) {
          continue
        }

        const qboLines = Array.isArray(inv.Line) ? inv.Line : []
        const lineItemsMap = new Map<number, { itemName: string; description: string }>()

        qboLines
          .filter((l: any) => l && typeof l === 'object')
          .filter((l: any) => {
            const dt = String(l.DetailType || '')
            return dt !== 'SubTotalLineDetail' && dt !== 'DescriptionOnly'
          })
          .forEach((l: any, idx: number) => {
            const itemName =
              String(l?.SalesItemLineDetail?.ItemRef?.name || '') ||
              String(l?.SalesItemLineDetail?.ItemRef?.value || '') ||
              ''
            const description = String(l.Description || '')
            lineItemsMap.set(idx, {
              itemName: itemName || description || `QuickBooks line ${idx + 1}`,
              description: description && itemName ? description : '',
            })
          })

        const localLineItems = invoice.lineItems
        let lineItemUpdated = false

        for (let i = 0; i < localLineItems.length; i++) {
          const localItem = localLineItems[i]
          const qboData = lineItemsMap.get(i)
          if (qboData) {
            await prisma.invoiceLineItem.update({
              where: { id: localItem.id },
              data: {
                description: qboData.itemName,
                notes: qboData.description || null,
              },
            })
            lineItemUpdated = true
          }
        }

        if (lineItemUpdated) {
          updatedCount++
        }
      } catch (error: any) {
        errorCount++
        const errorMsg = `Invoice ${invoice.invoiceNumber || invoice.id}: ${error?.message || String(error)}`
        errors.push(errorMsg)
        console.error(`[Update Line Items] Error updating invoice ${invoice.id}:`, error)
      }
    }

    return NextResponse.json({
      message: `Updated ${updatedCount} invoice(s) (scanned ${invoices.length}, limit=${limit})`,
      updated: updatedCount,
      scanned: invoices.length,
      errors: errorCount,
      errorDetails: errors.length > 0 ? errors : undefined,
    })
  } catch (error: any) {
    console.error('[Update Line Items] Fatal error:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to update invoice line items' },
      { status: 500 }
    )
  }
}
