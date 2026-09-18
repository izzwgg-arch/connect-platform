// Centralized dropdown/menu styling so all custom dropdowns feel consistent.
// (Radix Select already has its own shared styling in `components/ui/select.tsx`.)

export const DROPDOWN_TRIGGER =
  'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2E4A59]'

export const DROPDOWN_PANEL =
  'absolute z-50 mt-1 w-full rounded-md border border-input bg-background shadow-md'

export const DROPDOWN_SEARCH_WRAP = 'p-2 border-b'

export const DROPDOWN_SEARCH_INPUT =
  'h-9 w-full rounded-md border border-input px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#2E4A59]'

export const DROPDOWN_LIST = 'max-h-64 overflow-auto py-1'

export const DROPDOWN_EMPTY = 'px-3 py-2 text-sm text-muted-foreground'

export const DROPDOWN_ITEM =
  'block w-full cursor-pointer rounded-sm px-3 py-2 text-left text-sm outline-none hover:bg-[#2E4A59] hover:text-white focus:bg-[#2E4A59] focus:text-white'

