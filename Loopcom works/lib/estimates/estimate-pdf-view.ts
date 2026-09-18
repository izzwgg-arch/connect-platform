import {
  buildCustomerLinesFromGroups,
  flatLineItemsToCompanyLines,
  type GroupCustomerMeta,
} from '@/lib/estimates/company-customer-sync'

export type EstimatePdfView = 'customer' | 'company'

type AnyRecord = Record<string, any>

function normalizePdfView(value: unknown): EstimatePdfView {
  return String(value || '').toLowerCase() === 'company' ? 'company' : 'customer'
}

export function parseEstimatePdfView(value: unknown): EstimatePdfView {
  return normalizePdfView(value)
}

/**
 * Prepare estimate payload for PDF generation.
 * - company: detailed line items (existing behavior / visibility flags)
 * - customer: bundled Line # rows when groups exist; otherwise falls back to company
 */
export function prepareEstimateForPdfView(
  estimate: AnyRecord,
  view: EstimatePdfView = 'customer'
): AnyRecord {
  const resolvedView = normalizePdfView(view)
  if (resolvedView === 'company') {
    return estimate
  }

  const lineItems = Array.isArray(estimate.lineItems) ? estimate.lineItems : []
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
    // No Line # / groups — keep detailed company PDF so old estimates still work.
    return estimate
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

  // Append ungrouped visible company items so nothing is lost.
  const ungrouped = lineItems.filter(
    (item: AnyRecord) =>
      !item.isSubtotal &&
      item.isVisibleToClient !== false &&
      !(item.groupId || item.group?.id)
  )

  return {
    ...estimate,
    lineItems: [...customerPdfItems, ...ungrouped],
  }
}
