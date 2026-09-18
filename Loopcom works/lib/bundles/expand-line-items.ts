/**
 * Build estimate/invoice line rows when a bundle is expanded into itemized components.
 *
 * Field mapping in the UI:
 * - `description` → Name column (showDescriptionToCustomer)
 * - `notes` → Description column (showNotesToCustomer) — sourced from Item.description / component notes
 */

export type BundleExpandedLine = {
  description: string
  quantity: string
  unitPrice: string
  unitCost: string
  notes: string
  vendorId: string | null
  vendorName: string | null
  taxable: boolean
  taxRate: string
  showDescriptionToCustomer: boolean
  showCostToCustomer: boolean
  showPriceToCustomer: boolean
  showTaxToCustomer: boolean
  showNotesToCustomer: boolean
  groupId: string
  sourceItemId: string | null
  sourceBundleId: string | null
}

export function catalogNotesFromItem(
  item?: { description?: string | null; notes?: string | null } | null,
  componentNotes?: string | null
): string {
  const fromCatalog = item?.description?.trim()
  if (fromCatalog) return fromCatalog

  const fromComponent = componentNotes?.trim()
  if (fromComponent) return fromComponent

  const fromItemNotes = item?.notes?.trim()
  if (fromItemNotes && fromItemNotes !== 'Imported from QuickBooks historical import') {
    return fromItemNotes
  }

  return ''
}

export function mapBundleComponentToLineItem(comp: any, groupId: string): BundleExpandedLine {
  const sourceItem = comp.componentItem
  const sourceBundle = comp.componentBundle
  const sourceName = sourceItem?.name || sourceBundle?.item?.name || 'Unknown'

  const sourcePrice = sourceItem?.defaultUnitPrice
    ? Number(sourceItem.defaultUnitPrice)
    : sourceBundle
      ? Number(sourceBundle?.item?.defaultUnitPrice || 0)
      : 0

  const sourceCost = sourceItem?.defaultUnitCost
    ? Number(sourceItem.defaultUnitCost)
    : sourceBundle
      ? Number(sourceBundle?.item?.defaultUnitCost || 0)
      : null

  const overridePrice = comp.defaultUnitPriceOverride != null
    ? Number(comp.defaultUnitPriceOverride)
    : sourcePrice

  const overrideCost = comp.defaultUnitCostOverride != null
    ? Number(comp.defaultUnitCostOverride)
    : sourceCost

  return {
    description: sourceName,
    quantity: String(comp.quantity ?? 1),
    unitPrice: overridePrice.toString(),
    unitCost: overrideCost != null ? overrideCost.toString() : '0',
    notes: catalogNotesFromItem(sourceItem, comp.notes),
    vendorId: comp.vendorId || null,
    vendorName: comp.vendor?.name || null,
    taxable: sourceItem?.taxable ?? true,
    taxRate: sourceItem?.taxRate?.toString() || '',
    showDescriptionToCustomer: true,
    showCostToCustomer: false,
    showPriceToCustomer: true,
    showTaxToCustomer: true,
    showNotesToCustomer: true,
    groupId,
    sourceItemId: comp.componentItemId || null,
    sourceBundleId: comp.componentBundleId || null,
  }
}

function mapFlattenedItemToLineItem(
  item: {
    itemId: string
    quantity: number
    name: string
    unitPrice: number
    unitCost: number | null
    description: string | null
  },
  groupId: string,
  quantityMultiplier: number
): BundleExpandedLine {
  const qty = Number(item.quantity || 0) * quantityMultiplier
  return {
    description: item.name,
    quantity: String(qty),
    unitPrice: String(item.unitPrice ?? 0),
    unitCost: item.unitCost != null ? String(item.unitCost) : '0',
    notes: catalogNotesFromItem({ description: item.description, notes: null }),
    vendorId: null,
    vendorName: null,
    taxable: true,
    taxRate: '',
    showDescriptionToCustomer: true,
    showCostToCustomer: false,
    showPriceToCustomer: true,
    showTaxToCustomer: true,
    showNotesToCustomer: true,
    groupId,
    sourceItemId: item.itemId,
    sourceBundleId: null,
  }
}

/** Expand bundle components into line items (recursively flattens nested bundles). */
export async function expandBundleComponentsToLineItems(
  components: any[],
  groupId: string,
  authToken: string
): Promise<BundleExpandedLine[]> {
  const lines: BundleExpandedLine[] = []

  for (const comp of components) {
    if (comp.componentType === 'ITEM' && comp.componentItem) {
      lines.push(mapBundleComponentToLineItem(comp, groupId))
      continue
    }

    if (comp.componentType === 'BUNDLE' && comp.componentBundle?.id) {
      const nestedBundleId = comp.componentBundle.id
      const multiplier = Number(comp.quantity) || 1

      try {
        const response = await fetch(`/api/items/bundles/${nestedBundleId}/flatten`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })

        if (response.ok) {
          const data = await response.json()
          const items = Array.isArray(data.items) ? data.items : []
          for (const item of items) {
            lines.push(mapFlattenedItemToLineItem(item, groupId, multiplier))
          }
          continue
        }
      } catch (error) {
        console.error('Failed to flatten nested bundle:', error)
      }

      lines.push(mapBundleComponentToLineItem(comp, groupId))
    }
  }

  return lines
}

/**
 * Apply a bundle picker selection to document line items.
 * Creates a new group when picking on a standalone row; expands into the existing group when picking inside a bundle.
 */
export async function applyBundleSelectionToLines<
  T extends { groupId?: string; isGroupHeader?: boolean; groupName?: string },
>(
  lines: T[],
  lineIndex: number,
  bundle: { name: string; components: any[] },
  bundleDefId: string,
  authToken: string,
  options?: { headerExtras?: Partial<T>; groupIdPrefix?: string }
): Promise<T[]> {
  const updated = [...lines]
  const current = updated[lineIndex]
  const insideExistingGroup = Boolean(current?.groupId && !current?.isGroupHeader)

  if (insideExistingGroup && current.groupId) {
    const childLines = await expandBundleComponentsToLineItems(
      bundle.components,
      current.groupId,
      authToken
    )
    if (childLines.length === 0) return updated
    updated.splice(lineIndex, 1, ...(childLines as unknown as T[]))
    return updated
  }

  const prefix = options?.groupIdPrefix ?? 'group-'
  const groupId = `${prefix}${Date.now()}`
  updated[lineIndex] = {
    ...updated[lineIndex],
    description: bundle.name,
    quantity: '1',
    unitPrice: '0',
    unitCost: '0',
    notes: '',
    groupId,
    groupName: bundle.name,
    isGroupHeader: true,
    sourceBundleId: bundleDefId,
    sourceItemId: null,
    ...(options?.headerExtras ?? {}),
  } as T

  const childLines = await expandBundleComponentsToLineItems(
    bundle.components,
    groupId,
    authToken
  )
  updated.splice(lineIndex + 1, 0, ...(childLines as unknown as T[]))
  return updated
}

/** Map expanded bundle row to purchase order line item fields. */
export function bundleExpandedLineToPurchaseOrderLine(
  line: BundleExpandedLine,
  overrides?: { vendorId?: string | null; vendorName?: string | null; sourceBundleId?: string | null }
) {
  return {
    description: line.description,
    details: line.notes,
    quantity: line.quantity,
    unitCost: line.unitCost,
    unitPrice: line.unitPrice,
    notes: '',
    vendorId: line.vendorId ?? overrides?.vendorId ?? null,
    vendorName: line.vendorName ?? overrides?.vendorName ?? null,
    groupId: line.groupId,
    sourceItemId: line.sourceItemId,
    sourceBundleId: line.sourceBundleId ?? overrides?.sourceBundleId ?? null,
    isVisibleToClient: true,
    showDescriptionToCustomer: true,
    showDetailsToCustomer: true,
    showNotesToCustomer: true,
    showPriceToCustomer: true,
  }
}

/** Server-side: map flattened catalog item to persisted line fields. */
export function bundleFlattenedItemToLineData(item: {
  itemId: string
  quantity: number
  name: string
  unitPrice: number
  unitCost: number | null
  description: string | null
}) {
  return {
    sourceItemId: item.itemId,
    description: item.name,
    notes: catalogNotesFromItem({ description: item.description, notes: null }),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    unitCost: item.unitCost,
    showDescriptionToCustomer: true,
    showNotesToCustomer: true,
    isVisibleToClient: true,
  }
}
