'use client'

import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

type LineItemDragHandleProps = {
  /** Must match the key used in onDrop getData (e.g. text/line-index, text/opt-line-index). */
  transferKey: string
  index: number
  className?: string
}

/**
 * Drag/reorder source for document line lists. Only this element is draggable so row
 * text and inputs stay selectable; parent rows should keep onDragOver/onDrop only.
 */
export function LineItemDragHandle({ transferKey, index, className }: LineItemDragHandleProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      title="Drag to reorder"
      aria-label="Drag to reorder this line"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(transferKey, String(index))
        e.dataTransfer.effectAllowed = 'move'
        e.stopPropagation()
      }}
      className={cn(
        'shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-600',
        'cursor-grab active:cursor-grabbing',
        'touch-none select-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        className
      )}
    >
      <GripVertical className="h-4 w-4" aria-hidden />
    </div>
  )
}
