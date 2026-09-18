/**
 * Company ↔ Customer estimate sync helpers.
 *
 * Company estimate: full estimate line items grouped under customer "Line #N" bundles (QB sync source).
 * Customer estimate: one row per line; description stacks item descriptions; total = sum of items.
 *
 * Customer edits stick until that same company line is edited, then the customer line is rebuilt.
 */

export type CompanyItem = {
  id: string
  /** Name column (maps to EstimateLineItem.description) */
  description: string
  /** Description column (maps to EstimateLineItem.notes) */
  notes: string
  quantity: string
  unitPrice: string
  unitCost: string
  taxable: boolean
  taxRate: string
  isVisibleToClient: boolean
  showDescriptionToCustomer: boolean
  showCostToCustomer: boolean
  showPriceToCustomer: boolean
  showTaxToCustomer: boolean
  showNotesToCustomer: boolean
  vendorId?: string
  vendorName?: string
  sourceItemId?: string
  sourceBundleId?: string
}

export type CompanyLine = {
  id: string
  lineNumber: number
  title: string
  items: CompanyItem[]
}

export type CustomerLine = {
  id: string
  lineNumber: number
  title: string
  /** Stacked item descriptions, one per row (newline-separated) */
  description: string
  total: number
  /** True after a manual customer edit; cleared when company line is edited */
  customerEdited: boolean
}

export function createBlankCompanyItem(partial?: Partial<CompanyItem>): CompanyItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 9)}`,
    description: '',
    notes: '',
    quantity: '1',
    unitPrice: '0',
    unitCost: '',
    taxable: true,
    taxRate: '',
    isVisibleToClient: true,
    showDescriptionToCustomer: false,
    showCostToCustomer: false,
    showPriceToCustomer: true,
    showTaxToCustomer: true,
    showNotesToCustomer: true,
    ...partial,
  }
}

export function lineItemTotal(item: Pick<CompanyItem, 'quantity' | 'unitPrice'>): number {
  const qty = parseFloat(item.quantity || '0') || 0
  const price = parseFloat(item.unitPrice || '0') || 0
  return Math.round(qty * price * 100) / 100
}

export function companyLineTotal(line: CompanyLine): number {
  return Math.round(line.items.reduce((sum, item) => sum + lineItemTotal(item), 0) * 100) / 100
}

/**
 * Text that feeds the customer line description.
 * Only the company Description column (notes) — never the Name column.
 */
export function itemCustomerFacingText(item: CompanyItem): string {
  return (item.notes || '').trim()
}

/** Stack each non-empty item description on its own row. */
export function buildCustomerDescription(items: CompanyItem[]): string {
  return items.map(itemCustomerFacingText).filter(Boolean).join('\n')
}

export function buildCustomerLineFromCompany(line: CompanyLine): CustomerLine {
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    title: line.title,
    description: buildCustomerDescription(line.items),
    total: companyLineTotal(line),
    customerEdited: false,
  }
}

/**
 * Rebuild customer lines from company lines.
 *
 * Once a line's TEXT is manually edited (customerEdited), the description
 * stays sticky for good — adding/removing items, editing amounts, or editing
 * notes on that company line never auto-overwrites the customer's own text.
 * The only way back to "synced from company" text is deleting/recreating the
 * group; there's no automatic re-sync trigger for it by design.
 *
 * The TOTAL is a different story: it always tracks the real, current sum of
 * the company line items, even on an otherwise-sticky line — a manually
 * customized description shouldn't leave the customer looking at a stale
 * dollar amount after a price/qty changes or an item is added.
 * Empty sticky descriptions never block a company refill (recovers from accidental empty edits).
 */
export function syncCustomerLines(
  companyLines: CompanyLine[],
  previousCustomerLines: CustomerLine[]
): CustomerLine[] {
  const prevById = new Map(previousCustomerLines.map((l) => [l.id, l]))

  return companyLines.map((companyLine) => {
    const prev = prevById.get(companyLine.id)
    const rebuilt = buildCustomerLineFromCompany(companyLine)

    if (prev?.customerEdited) {
      const stickyDescription = (prev.description || '').trim()
      // Accidental sticky empty (focus/blur) was blocking company → customer text.
      if (!stickyDescription && (rebuilt.description || '').trim()) {
        return rebuilt
      }
      return {
        ...prev,
        lineNumber: companyLine.lineNumber,
        title: companyLine.title,
        total: companyLineTotal(companyLine),
      }
    }

    return rebuilt
  })
}

export function applyCustomerEdit(
  lines: CustomerLine[],
  lineId: string,
  patch: Partial<Pick<CustomerLine, 'description' | 'total' | 'title'>>
): CustomerLine[] {
  return lines.map((line) => {
    if (line.id !== lineId) return line
    const next = { ...line, ...patch }
    const changed =
      (patch.description !== undefined && patch.description !== line.description) ||
      (patch.total !== undefined && Number(patch.total) !== Number(line.total)) ||
      (patch.title !== undefined && patch.title !== line.title)
    if (!changed) return line
    return { ...next, customerEdited: true }
  })
}

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount || 0)
}

export function createDemoCompanyLines(): CompanyLine[] {
  return [
    {
      id: 'line-1',
      lineNumber: 1,
      title: 'Kitchen remodel',
      items: [
        createBlankCompanyItem({
          id: 'item-1a',
          description: 'Cabinet install',
          notes: 'Cabinet install — upper and lower',
          quantity: '1',
          unitPrice: '2500',
          unitCost: '1600',
          taxable: true,
          taxRate: '8.875',
          showDescriptionToCustomer: true,
          showNotesToCustomer: true,
          showPriceToCustomer: true,
        }),
        createBlankCompanyItem({
          id: 'item-1b',
          description: 'Quartz countertop',
          notes: 'Quartz countertop supply & install',
          quantity: '1',
          unitPrice: '1800',
          unitCost: '1100',
          taxable: true,
          taxRate: '8.875',
          showDescriptionToCustomer: true,
          showNotesToCustomer: true,
        }),
        createBlankCompanyItem({
          id: 'item-1c',
          description: 'Cabinet hardware',
          notes: 'Hardware and soft-close hinges',
          quantity: '1',
          unitPrice: '200',
          unitCost: '95',
          taxable: true,
          taxRate: '8.875',
          showDescriptionToCustomer: true,
          showNotesToCustomer: true,
        }),
      ],
    },
    {
      id: 'line-2',
      lineNumber: 2,
      title: 'Hall bathroom',
      items: [
        createBlankCompanyItem({
          id: 'item-2a',
          description: 'Vanity package',
          notes: 'Vanity and faucet package',
          quantity: '1',
          unitPrice: '900',
          unitCost: '520',
          taxable: true,
          taxRate: '8.875',
          showDescriptionToCustomer: true,
          showNotesToCustomer: true,
        }),
        createBlankCompanyItem({
          id: 'item-2b',
          description: 'Floor tile',
          notes: 'Floor tile labor and materials',
          quantity: '1',
          unitPrice: '1200',
          unitCost: '700',
          taxable: true,
          taxRate: '8.875',
          showDescriptionToCustomer: true,
          showNotesToCustomer: true,
        }),
      ],
    },
  ]
}

export function companyLinesToApiPayload(
  companyLines: CompanyLine[],
  customerLines: CustomerLine[] = []
) {
  const groups = mergeCustomerIntoGroups(
    companyLines.map((line) => ({
      groupId: line.id,
      name: line.title.trim()
        ? `Line #${line.lineNumber} — ${line.title.trim()}`
        : `Line #${line.lineNumber}`,
    })),
    customerLines
  )

  let sortOrder = 0
  const lineItems = companyLines.flatMap((line) =>
    line.items.map((item) => {
      const quantity = parseFloat(item.quantity || '1') || 0
      const unitPrice = parseFloat(item.unitPrice || '0') || 0
      const payload = {
        description: item.description || itemCustomerFacingText(item) || 'Item',
        quantity,
        unitPrice,
        unitCost: item.unitCost ? parseFloat(item.unitCost) : null,
        total: Math.round(quantity * unitPrice * 100) / 100,
        sortOrder: sortOrder++,
        isVisibleToClient: item.isVisibleToClient !== false,
        showDescriptionToCustomer: item.showDescriptionToCustomer,
        showCostToCustomer: item.showCostToCustomer,
        showPriceToCustomer: item.showPriceToCustomer,
        showTaxToCustomer: item.showTaxToCustomer,
        showNotesToCustomer: item.showNotesToCustomer,
        vendorId: item.vendorId || null,
        taxable: item.taxable,
        taxRate: item.taxRate
          ? Math.round((parseFloat(item.taxRate) / 100) * 10000) / 10000
          : null,
        notes: item.notes || null,
        groupId: line.id,
        sourceItemId: item.sourceItemId || null,
        sourceBundleId: item.sourceBundleId || null,
        isSubtotal: false,
      }
      return payload
    })
  )

  return { groups, lineItems }
}

/** Flat estimate-editor row shape used by new/edit pages. */
export type FlatEditorLineItem = {
  id?: string
  description: string
  quantity: string
  unitPrice: string
  unitCost?: string
  notes?: string
  taxable?: boolean
  taxRate?: string
  isVisibleToClient?: boolean
  showDescriptionToCustomer?: boolean
  showCostToCustomer?: boolean
  showPriceToCustomer?: boolean
  showTaxToCustomer?: boolean
  showNotesToCustomer?: boolean
  vendorId?: string
  vendorName?: string
  groupId?: string
  groupName?: string
  isGroupHeader?: boolean
  sourceItemId?: string
  sourceBundleId?: string
  isSubtotal?: boolean
}

export type GroupCustomerMeta = {
  customerDescription?: string | null
  customerTotal?: number | string | null
  customerEdited?: boolean | null
}

/** Convert flat editor line items into company lines (one per group). */
export function flatLineItemsToCompanyLines(
  lineItems: FlatEditorLineItem[]
): CompanyLine[] {
  const lines: CompanyLine[] = []
  const indexByGroup = new Map<string, number>()

  for (const item of lineItems) {
    if (item.isSubtotal) continue

    if (item.isGroupHeader && item.groupId) {
      if (!indexByGroup.has(item.groupId)) {
        indexByGroup.set(item.groupId, lines.length)
        lines.push({
          id: item.groupId,
          lineNumber: lines.length + 1,
          title: stripLineNumberPrefix(item.groupName || item.description || ''),
          items: [],
        })
      } else {
        const idx = indexByGroup.get(item.groupId)!
        lines[idx].title = stripLineNumberPrefix(item.groupName || item.description || '')
      }
      continue
    }

    if (!item.groupId) continue

    if (!indexByGroup.has(item.groupId)) {
      indexByGroup.set(item.groupId, lines.length)
      lines.push({
        id: item.groupId,
        lineNumber: lines.length + 1,
        title: stripLineNumberPrefix(item.groupName || ''),
        items: [],
      })
    }

    const idx = indexByGroup.get(item.groupId)!
    lines[idx].items.push({
      id: item.id || `row-${idx}-${lines[idx].items.length}`,
      description: item.description || '',
      notes: item.notes || '',
      quantity: item.quantity || '1',
      unitPrice: item.unitPrice || '0',
      unitCost: item.unitCost || '',
      taxable: item.taxable !== false,
      taxRate: item.taxRate || '',
      isVisibleToClient: item.isVisibleToClient !== false,
      showDescriptionToCustomer: item.showDescriptionToCustomer !== false,
      showCostToCustomer: Boolean(item.showCostToCustomer),
      showPriceToCustomer: item.showPriceToCustomer !== false,
      showTaxToCustomer: item.showTaxToCustomer !== false,
      showNotesToCustomer: item.showNotesToCustomer !== false,
      vendorId: item.vendorId,
      vendorName: item.vendorName,
      sourceItemId: item.sourceItemId,
      sourceBundleId: item.sourceBundleId,
    })
  }

  return lines.map((line, i) => ({ ...line, lineNumber: i + 1 }))
}

export function stripLineNumberPrefix(name: string): string {
  return name.replace(/^Line #\d+\s*[—–-]\s*/i, '').trim()
}


export function buildCustomerLinesFromGroups(
  companyLines: CompanyLine[],
  groupMetaById: Record<string, GroupCustomerMeta> = {}
): CustomerLine[] {
  return companyLines.map((line) => {
    const meta = groupMetaById[line.id]
    if (meta?.customerEdited) {
      return {
        id: line.id,
        lineNumber: line.lineNumber,
        title: line.title,
        description: meta.customerDescription || '',
        // Always the live company total, not whatever was persisted — a
        // sticky description shouldn't leave the total stale after a
        // price/qty change.
        total: companyLineTotal(line),
        customerEdited: true,
      }
    }
    return buildCustomerLineFromCompany(line)
  })
}

export function customerLinesToGroupPayload(customerLines: CustomerLine[]) {
  return customerLines.map((line) => ({
    groupId: line.id,
    customerDescription: line.description,
    customerTotal: line.total,
    customerEdited: line.customerEdited,
  }))
}

/**
 * Build the groups payload from editor line items.
 * Includes Line # / bundles even when the title (groupName) is blank — previously
 * empty names were skipped, so invoice/estimate creates dropped all group links
 * and the customer view saved empty.
 */
export function collectGroupsFromEditorLines(
  lineItems: Array<{
    groupId?: string
    groupName?: string
    description?: string
    isGroupHeader?: boolean
    sourceBundleId?: string | null
  }>,
  optionalItems: Array<{
    groupId?: string
    groupName?: string
    description?: string
    isGroupHeader?: boolean
    sourceBundleId?: string | null
  }> = []
): Array<{ groupId: string; name: string; sourceBundleId?: string | null }> {
  const groups = new Map<string, { name: string; sourceBundleId?: string | null }>()
  let groupOrdinal = 0

  const consider = (item: {
    groupId?: string
    groupName?: string
    description?: string
    isGroupHeader?: boolean
    sourceBundleId?: string | null
  }) => {
    if (!item.groupId || groups.has(item.groupId)) return
    groupOrdinal += 1
    const named = String(item.groupName || (item.isGroupHeader ? item.description : '') || '').trim()
    groups.set(item.groupId, {
      name: named || `Line #${groupOrdinal}`,
      sourceBundleId: item.sourceBundleId || null,
    })
  }

  // Pass 1: headers first (best titles)
  for (const item of [...lineItems, ...optionalItems]) {
    if (item.isGroupHeader) consider(item)
  }
  // Pass 2: any remaining grouped items
  for (const item of [...lineItems, ...optionalItems]) {
    if (!item.isGroupHeader) consider(item)
  }

  return Array.from(groups.entries()).map(([groupId, group]) => ({
    groupId,
    ...group,
  }))
}

/** Merge customer overrides onto groups built for the estimates API. */
export function mergeCustomerIntoGroups(
  groups: Array<{ groupId: string; name: string; sourceBundleId?: string | null }>,
  customerLines: CustomerLine[]
) {
  const byId = new Map(customerLines.map((l) => [l.id, l]))
  return groups.map((group) => {
    const customer = byId.get(group.groupId)
    if (!customer) {
      return {
        ...group,
        customerDescription: null,
        customerTotal: null,
        customerEdited: false,
      }
    }
    // Only persist sticky overrides when the customer row was manually edited.
    // Synced (non-edited) rows stay null so company remains the source of truth.
    if (!customer.customerEdited) {
      return {
        ...group,
        customerDescription: null,
        customerTotal: null,
        customerEdited: false,
      }
    }
    return {
      ...group,
      customerDescription: customer.description,
      customerTotal: customer.total,
      customerEdited: true,
    }
  })
}

