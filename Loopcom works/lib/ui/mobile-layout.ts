import { cn } from '@/lib/utils'

/** Responsive page header: title stack + actions wrap on narrow screens. */
export function cnPageHeader(className?: string) {
  return cn(
    'flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between',
    className
  )
}

/** Responsive filter/toolbar row. */
export function cnToolbarRow(className?: string) {
  return cn('flex flex-wrap items-center gap-2 sm:gap-4', className)
}

/** Form grid that stacks on phones. */
export function cnFormGrid(className?: string) {
  return cn('grid grid-cols-1 gap-4 md:grid-cols-2', className)
}

/** Main description column inside a line-item editor row. */
export function cnLineItemFieldWide(className?: string) {
  return cn('line-item-field-wide min-w-0 flex-1 space-y-1', className)
}

/** Numeric field column (qty, price, cost, tax, total). */
export function cnLineItemFieldNumeric(className?: string) {
  return cn('line-item-field-numeric shrink-0', className)
}

/** Touch-friendly visibility toggle beside field labels. */
export function cnVisibilityToggle(className?: string) {
  return cn('visibility-toggle-btn', className)
}
