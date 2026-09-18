'use client'

import { LayoutGrid, List, Rows3, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type ViewMode } from '@/hooks/useViewMode'

type SelectorSize = 'sm' | 'md'

const modeMeta: Record<ViewMode, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  grid: { label: 'Grid', icon: LayoutGrid },
  rowCompact: { label: 'Compact', icon: List },
  rowDetailed: { label: 'Detailed', icon: Rows3 },
  table: { label: 'Table', icon: Table2 },
}

const sizeClasses: Record<SelectorSize, { wrapper: string; item: string; icon: string }> = {
  sm: {
    wrapper: 'h-11 min-h-[44px]',
    item: 'px-2.5 text-xs min-h-[44px]',
    icon: 'h-4 w-4',
  },
  md: {
    wrapper: 'h-11 min-h-[44px]',
    item: 'px-3 text-sm min-h-[44px]',
    icon: 'h-4 w-4',
  },
}

interface ViewModeSelectorProps {
  value: ViewMode
  onChange: (mode: ViewMode) => void
  allowedModes?: ViewMode[]
  size?: SelectorSize
}

export function ViewModeSelector({
  value,
  onChange,
  allowedModes = ['grid', 'rowCompact', 'rowDetailed', 'table'],
  size = 'sm',
}: ViewModeSelectorProps) {
  const classes = sizeClasses[size]

  return (
    <div className={cn('inline-flex items-center rounded-md border bg-background p-0.5', classes.wrapper)}>
      {allowedModes.map((mode) => {
        const meta = modeMeta[mode]
        const Icon = meta.icon
        const active = value === mode

        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm transition-colors',
              classes.item,
              active ? 'bg-[#2E4A59] text-white' : 'text-muted-foreground active:bg-muted sm:hover:bg-muted sm:hover:text-foreground'
            )}
            aria-pressed={active}
            title={meta.label}
          >
            <Icon className={classes.icon} />
            <span>{meta.label}</span>
          </button>
        )
      })}
    </div>
  )
}

