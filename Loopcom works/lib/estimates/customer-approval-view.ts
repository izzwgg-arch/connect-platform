/**
 * Build the public customer-facing estimate for approval / portal review.
 * Uses the same company→customer bundling as the customer PDF when Line # groups exist.
 */

import {
  buildCustomerLinesFromGroups,
  flatLineItemsToCompanyLines,
  type GroupCustomerMeta,
} from '@/lib/estimates/company-customer-sync'

type AnyRecord = Record<string, any>

export type PublicApprovalLine = {
  id: string
  description: string
  notes: string
  quantity: string
  unitPrice: string
  total: string
  unitCost: string | null
  showPriceToCustomer: boolean
  /** Underlying EstimateLineItem ids approved when this row is selected */
  sourceLineItemIds: string[]
  isCustomerBundle: boolean
  isOptional: boolean
  isSubtotal: boolean
}

function mapCompanyDetailItem(li: AnyRecord): PublicApprovalLine {
  return {
    id: li.id,
    description: li.showDescriptionToCustomer !== false ? li.description : '',
    notes: li.showNotesToCustomer !== false ? li.notes || '' : '',
    quantity: String(li.quantity ?? '1'),
    unitPrice: li.showPriceToCustomer !== false ? String(li.unitPrice ?? '0') : '0',
    unitCost: li.showCostToCustomer === true ? (li.unitCost != null ? String(li.unitCost) : null) : null,
    total: String(li.isSubtotal ? li.calculatedSubtotalTotal ?? li.total : li.total),
    showPriceToCustomer: li.showPriceToCustomer !== false,
    sourceLineItemIds: li.isSubtotal ? [] : [li.id],
    isCustomerBundle: false,
    isOptional: false,
    isSubtotal: Boolean(li.isSubtotal),
  }
}

/**
 * Prefer customer bundled Line # rows when groups exist; otherwise company detail
 * (so older estimates without Line # still work).
 */
export function buildCustomerFacingApprovalItems(
  lineItems: AnyRecord[]
): { viewMode: 'customer' | 'company'; items: PublicApprovalLine[] } {
  const visible = (lineItems || []).filter((li) => li.isVisibleToClient !== false)
  const hasGroups = visible.some((li) => !li.isSubtotal && (li.groupId || li.group?.id))

  if (!hasGroups) {
    return {
      viewMode: 'company',
      items: visible.map(mapCompanyDetailItem),
    }
  }

  const withHeaders: AnyRecord[] = []
  const seenGroups = new Set<string>()

  for (const item of visible) {
    const groupId = item.groupId || item.group?.id
    const groupName = item.group?.name || item.groupName
    if (groupId && groupName && !seenGroups.has(groupId)) {
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
      showDescriptionToCustomer: item.showDescriptionToCustomer !== false,
      showNotesToCustomer: item.showNotesToCustomer !== false,
      showPriceToCustomer: item.showPriceToCustomer !== false,
      showCostToCustomer: item.showCostToCustomer === true,
      showTaxToCustomer: item.showTaxToCustomer !== false,
    })
  }

  const companyLines = flatLineItemsToCompanyLines(withHeaders as any)
  if (companyLines.length === 0) {
    return {
      viewMode: 'company',
      items: visible.map(mapCompanyDetailItem),
    }
  }

  const meta: Record<string, GroupCustomerMeta> = {}
  for (const item of visible) {
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
  const companyById = new Map(companyLines.map((line) => [line.id, line]))

  const bundleItems: PublicApprovalLine[] = customerLines.map((line) => {
    const company = companyById.get(line.id)
    const sourceLineItemIds = (company?.items || []).map((item) => item.id)
    const name = line.title?.trim()
      ? `Line #${line.lineNumber} — ${line.title.trim()}`
      : `Line #${line.lineNumber}`
    return {
      id: line.id,
      description: name,
      notes: line.description || '',
      quantity: '1',
      unitPrice: String(line.total),
      total: String(line.total),
      unitCost: null,
      showPriceToCustomer: true,
      sourceLineItemIds,
      isCustomerBundle: true,
      isOptional: false,
      isSubtotal: false,
    }
  })

  const ungrouped = visible
    .filter((item) => !item.isSubtotal && !(item.groupId || item.group?.id))
    .map(mapCompanyDetailItem)

  return {
    viewMode: 'customer',
    items: [...bundleItems, ...ungrouped],
  }
}

/** Expand selected row ids (group / bundle ids or line-item ids) to EstimateLineItem ids. */
export function expandApprovalSelectionToLineItemIds(
  selectedIds: string[],
  lineItems: AnyRecord[],
  optionalItems: AnyRecord[] = []
): string[] {
  const groupToIds = new Map<string, string[]>()
  for (const li of lineItems || []) {
    if (li.isVisibleToClient === false || li.isSubtotal) continue
    const groupId = li.groupId || li.group?.id
    if (!groupId) continue
    const list = groupToIds.get(groupId) || []
    list.push(li.id)
    groupToIds.set(groupId, list)
  }

  const visibleIds = new Set<string>()
  for (const li of [...(lineItems || []), ...(optionalItems || [])]) {
    if (li.isVisibleToClient === false || li.isSubtotal) continue
    visibleIds.add(li.id)
  }

  const out = new Set<string>()
  for (const raw of selectedIds) {
    const id = String(raw || '').trim()
    if (!id) continue
    const fromGroup = groupToIds.get(id)
    if (fromGroup?.length) {
      for (const lid of fromGroup) out.add(lid)
      continue
    }
    if (visibleIds.has(id)) out.add(id)
  }
  return Array.from(out)
}
