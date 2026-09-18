'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type WidthMap = Record<string, number>

function storageKey(entity: string) {
  return `trimpro.table.colwidths.${entity}`
}

function readWidths(entity: string | undefined, defaults: WidthMap): WidthMap {
  if (!entity || typeof window === 'undefined') return { ...defaults }
  try {
    const raw = localStorage.getItem(storageKey(entity))
    if (!raw) return { ...defaults }
    const parsed = JSON.parse(raw) as WidthMap
    return { ...defaults, ...parsed }
  } catch {
    return { ...defaults }
  }
}

function writeWidths(entity: string | undefined, widths: WidthMap) {
  if (!entity || typeof window === 'undefined') return
  try {
    localStorage.setItem(storageKey(entity), JSON.stringify(widths))
  } catch {
    /* ignore */
  }
}

/**
 * Persistable column widths with pointer-drag resize.
 */
export function useResizableColumns(
  entity: string | undefined,
  defaults: WidthMap = {},
  options?: { minWidth?: number; maxWidth?: number }
) {
  const minWidth = options?.minWidth ?? 64
  const maxWidth = options?.maxWidth ?? 900
  const [widths, setWidths] = useState<WidthMap>(() => readWidths(entity, defaults))
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null)

  useEffect(() => {
    setWidths(readWidths(entity, defaults))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity])

  const setWidth = useCallback(
    (key: string, width: number) => {
      setWidths((prev) => {
        const next = {
          ...prev,
          [key]: Math.min(maxWidth, Math.max(minWidth, Math.round(width))),
        }
        writeWidths(entity, next)
        return next
      })
    },
    [entity, maxWidth, minWidth]
  )

  const onResizeStart = useCallback(
    (key: string, clientX: number) => {
      const startW = widths[key] ?? defaults[key] ?? 120
      dragRef.current = { key, startX: clientX, startW }

      const onMove = (e: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        setWidth(drag.key, drag.startW + (e.clientX - drag.startX))
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [defaults, setWidth, widths]
  )

  return { widths, setWidth, onResizeStart }
}

export function ColumnResizeHandle({
  onResizeStart,
}: {
  onResizeStart: (clientX: number) => void
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      className="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none touch-none hover:bg-primary/30 active:bg-primary/50"
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onResizeStart(e.clientX)
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
