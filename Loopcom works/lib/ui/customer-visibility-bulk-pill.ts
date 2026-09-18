import { cn } from '@/lib/utils'

/**
 * Styles for estimate/invoice "Show to customer" bulk pills (Name, Description, etc.).
 * Active state matches the default shadcn Button (same as Create Estimate / Create Invoice).
 */
export function cnCustomerVisibilityBulkPill(active: boolean) {
  return cn(
    'flex items-center gap-1 px-2.5 py-2 min-h-[44px] rounded-md border font-medium transition-colors text-xs shrink-0',
    active
      ? 'bg-primary text-primary-foreground border-primary shadow-sm hover:bg-primary/90'
      : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'
  )
}
