import {
  buildCustomerLinesFromGroups,
  flatLineItemsToCompanyLines,
  type GroupCustomerMeta,
} from '@/lib/estimates/company-customer-sync'

export type InvoicePdfView = 'customer' | 'company'

type AnyRecord = Record<string, any>

function normalizePdfView(value: unknown): InvoicePdfView {
  return String(value || '').toLowerCase() === 'company' ? 'company' : 'customer'
}

export function parseInvoicePdfView(value: unknown): InvoicePdfView {
  return normalizePdfView(value)
}

/**
 * Prepare invoice payload for PDF generation.
 * - company: detailed line items (QB / internal)
 * - customer: bundled Line # rows when groups exist; otherwise falls back to company
 */
export function prepareInvoiceForPdfView(
  invoice: AnyRecord,
  view: InvoicePdfView = 'customer'
): AnyRecord {
  const resolvedView = normalizePdfView(view)
  if (resolvedView === 'company') {
    return invoice
  }

  const lineItems = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
  const withHeaders: AnyRecord[] = []
  const seenGroups = new Set<string>()

  for (const item of lineItems) {
    const groupId = item.groupId || item.group?.id
    const groupName = item.group?.name || item.groupName || ''
    if (groupId && !seenGroups.has(groupId)) {
      withHeaders.push({
        id: `header-${groupId}`,
        description: groupName,
        quantity: '1',
        unitPrice: '0',
        groupId,
        groupName,
        isGroupHeader: true,
        taxable: true,
      })
      seenGroups.add(groupId)
    }
    withHeaders.push({
      id: item.id,
      description: item.description,
      quantity: String(item.quantity ?? '1'),
      unitPrice: String(item.unitPrice ?? '0'),
      unitCost: item.unitCost != null ? String(item.unitCost) : '',
      notes: item.notes || '',
      taxable: item.taxable !== false,
      taxRate: item.taxRate != null ? String(item.taxRate) : '',
      groupId: groupId || undefined,
      groupName: groupName || undefined,
      isGroupHeader: false,
      isSubtotal: Boolean(item.isSubtotal),
      isVisibleToClient: item.isVisibleToClient !== false,
    })
  }

  const companyLines = flatLineItemsToCompanyLines(withHeaders as any)
  if (companyLines.length === 0) {
    return invoice
  }

  const meta: Record<string, GroupCustomerMeta> = {}
  for (const item of lineItems) {
    const group = item.group
    if (group?.id && !meta[group.id]) {
      meta[group.id] = {
        customerDescription: group.customerDescription,
        customerTotal: group.customerTotal,
        customerEdited: group.customerEdited,
      }
    }
  }

  const customerLines = buildCustomerLinesFromGroups(companyLines, meta)

  const customerPdfItems = customerLines.map((line, index) => {
    const name = line.title?.trim()
      ? `Line #${line.lineNumber} — ${line.title.trim()}`
      : `Line #${line.lineNumber}`
    return {
      id: line.id || `customer-line-${index}`,
      description: name,
      notes: line.description || '',
      quantity: 1,
      unitPrice: line.total,
      unitCost: null,
      total: line.total,
      sortOrder: index,
      taxable: false,
      isVisibleToClient: true,
      showDescriptionToCustomer: true,
      showNotesToCustomer: true,
      showCostToCustomer: false,
      showPriceToCustomer: true,
      showTaxToCustomer: false,
      isSubtotal: false,
    }
  })

  const ungrouped = lineItems.filter(
    (item: AnyRecord) =>
      !item.isSubtotal &&
      item.isVisibleToClient !== false &&
      !(item.groupId || item.group?.id)
  )

  return {
    ...invoice,
    lineItems: [...customerPdfItems, ...ungrouped],
  }
}
