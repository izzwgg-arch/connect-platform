'use client'

import { useEffect, type CSSProperties } from 'react'
import { ColumnResizeHandle, useResizableColumns } from '@/hooks/useResizableColumns'
import { cn } from '@/lib/utils'

export const DOCUMENT_LINE_WIDTH_DEFAULTS = {
  name: 280,
  notes: 320,
  qty: 80,
  price: 112,
  cost: 112,
  tax: 88,
  total: 96,
}

/**
 * Sticky header above document line-item editors with drag-resizable column widths.
 */
export function DocumentLineItemsColumnHeader({
  entity,
  showCost = true,
  showTax = true,
  className,
  onWidthsChange,
}: {
  entity: string
  showCost?: boolean
  showTax?: boolean
  className?: string
  onWidthsChange?: (widths: Record<string, number>) => void
}) {
  const { widths, onResizeStart } = useResizableColumns(entity, DOCUMENT_LINE_WIDTH_DEFAULTS, {
    minWidth: 56,
    maxWidth: 720,
  })

  useEffect(() => {
    onWidthsChange?.(widths)
  }, [widths, onWidthsChange])

  const HeaderCell = ({
    label,
    widthKey,
    className: cellClass,
  }: {
    label: string
    widthKey: keyof typeof DOCUMENT_LINE_WIDTH_DEFAULTS
    className?: string
  }) => (
    <div
      className={cn(
        'relative shrink-0 px-1 text-xs font-medium uppercase tracking-wide text-gray-500',
        cellClass
      )}
      style={{
        width: widths[widthKey] ?? DOCUMENT_LINE_WIDTH_DEFAULTS[widthKey],
        minWidth: 56,
      }}
    >
      {label}
      <ColumnResizeHandle onResizeStart={(x) => onResizeStart(widthKey, x)} />
    </div>
  )

  return (
    <div
      className={cn(
        'sticky top-0 z-10 mb-2 flex items-center gap-2 rounded border bg-muted/50 px-2 py-1.5',
        className
      )}
      style={
        {
          ['--doc-line-name-width' as string]: `${widths.name ?? DOCUMENT_LINE_WIDTH_DEFAULTS.name}px`,
          ['--doc-line-qty-width' as string]: `${widths.qty ?? DOCUMENT_LINE_WIDTH_DEFAULTS.qty}px`,
          ['--doc-line-price-width' as string]: `${widths.price ?? DOCUMENT_LINE_WIDTH_DEFAULTS.price}px`,
          ['--doc-line-cost-width' as string]: `${widths.cost ?? DOCUMENT_LINE_WIDTH_DEFAULTS.cost}px`,
          ['--doc-line-tax-width' as string]: `${widths.tax ?? DOCUMENT_LINE_WIDTH_DEFAULTS.tax}px`,
          ['--doc-line-total-width' as string]: `${widths.total ?? DOCUMENT_LINE_WIDTH_DEFAULTS.total}px`,
        } as CSSProperties
      }
    >
      <div className="w-8 shrink-0" />
      <div className="relative min-w-0 flex-1 px-1 text-xs font-medium uppercase tracking-wide text-gray-500">
        Name / Description
        <ColumnResizeHandle onResizeStart={(x) => onResizeStart('name', x)} />
      </div>
      <HeaderCell label="Qty" widthKey="qty" />
      <HeaderCell label="Price" widthKey="price" />
      {showCost ? <HeaderCell label="Cost" widthKey="cost" /> : null}
      {showTax ? <HeaderCell label="Tax" widthKey="tax" /> : null}
      <HeaderCell label="Total" widthKey="total" className="text-right" />
      <div className="w-16 shrink-0" />
    </div>
  )
}
