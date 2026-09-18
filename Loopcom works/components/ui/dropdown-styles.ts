// Centralized dropdown/menu styling so all custom dropdowns feel consistent.
// (Radix Select already has its own shared styling in `components/ui/select.tsx`.)

export const DROPDOWN_TRIGGER =
  'flex h-10 w-full items-center justify-between rounded-lg border border-line-strong bg-panel-2 px-3 py-2 text-sm text-ink transition-colors hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent'

export const DROPDOWN_PANEL =
  'absolute z-50 mt-1 w-full rounded-[10px] border border-line bg-popover text-popover-foreground shadow-float'

export const DROPDOWN_SEARCH_WRAP = 'p-2 border-b border-line'

export const DROPDOWN_SEARCH_INPUT =
  'h-9 w-full rounded-lg border border-line-strong bg-panel-2 px-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent'

export const DROPDOWN_LIST = 'max-h-64 overflow-auto py-1'

export const DROPDOWN_EMPTY = 'px-3 py-2 text-sm text-muted-foreground'

export const DROPDOWN_ITEM =
  'block w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-accent-soft focus:bg-accent-soft'

