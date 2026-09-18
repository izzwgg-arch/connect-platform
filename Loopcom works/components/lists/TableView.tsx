'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ResponsiveTableContainer } from '@/components/layout/ResponsiveTableContainer'
import { ColumnResizeHandle, useResizableColumns } from '@/hooks/useResizableColumns'

export interface TableColumn<T> {
  key: string
  header: string
  render: (item: T) => ReactNode
  sortValue?: (item: T) => string | number
  className?: string
  headerClassName?: string
  /** Initial / default pixel width when resizing is enabled */
  defaultWidth?: number
  /** Disable resize for this column */
  resizable?: boolean
}

interface TableViewProps<T> {
  data: T[]
  columns: TableColumn<T>[]
  rowKey: (item: T) => string
  onRowClick?: (item: T) => void
  sortKey?: string | null
  sortDirection?: 'asc' | 'desc'
  onSortChange?: (sortKey: string, sortDirection: 'asc' | 'desc') => void
  highlightedRowId?: string | null
  /** When set and sort is uncontrolled, persist sort in localStorage. */
  persistSortEntity?: string
  /** Persist column widths under this key (defaults to persistSortEntity). */
  persistWidthsEntity?: string
  /** Enable drag-to-resize column headers (default true). */
  resizableColumns?: boolean
}

function readStoredSort(entity?: string): { sortKey: string | null; sortDirection: 'asc' | 'desc' } {
  if (!entity || typeof window === 'undefined') return { sortKey: null, sortDirection: 'asc' }
  try {
    const raw = localStorage.getItem(`trimpro.list.prefs.${entity}`)
    if (!raw) return { sortKey: null, sortDirection: 'asc' }
    const p = JSON.parse(raw)
    return {
      sortKey: typeof p.sortKey === 'string' ? p.sortKey : null,
      sortDirection: p.sortDirection === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return { sortKey: null, sortDirection: 'asc' }
  }
}

function writeStoredSort(entity: string | undefined, sortKey: string | null, sortDirection: 'asc' | 'desc') {
  if (!entity || typeof window === 'undefined') return
  try {
    localStorage.setItem(`trimpro.list.prefs.${entity}`, JSON.stringify({ sortKey, sortDirection }))
  } catch {
    /* ignore */
  }
}

export function TableView<T>({
  data,
  columns,
  rowKey,
  onRowClick,
  sortKey: controlledSortKey,
  sortDirection: controlledSortDirection,
  onSortChange,
  highlightedRowId,
  persistSortEntity,
  persistWidthsEntity,
  resizableColumns = true,
}: TableViewProps<T>) {
  const stored = readStoredSort(persistSortEntity)
  const [localSortKey, setLocalSortKey] = useState<string | null>(stored.sortKey)
  const [localSortDirection, setLocalSortDirection] = useState<'asc' | 'desc'>(stored.sortDirection)
  const sortKey = controlledSortKey ?? localSortKey
  const sortDirection = controlledSortDirection ?? localSortDirection

  const widthDefaults = useMemo(() => {
    const map: Record<string, number> = {}
    for (const col of columns) {
      if (col.defaultWidth) map[col.key] = col.defaultWidth
    }
    return map
  }, [columns])

  const widthsEntity = persistWidthsEntity || persistSortEntity
  const { widths, onResizeStart } = useResizableColumns(
    resizableColumns ? widthsEntity : undefined,
    widthDefaults
  )

  const sortedData = useMemo(() => {
    if (!sortKey) return data
    const column = columns.find((c) => c.key === sortKey)
    if (!column?.sortValue) return data

    return [...data].sort((a, b) => {
      const av = column.sortValue!(a)
      const bv = column.sortValue!(b)

      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDirection === 'asc' ? av - bv : bv - av
      }

      const as = String(av).toLowerCase()
      const bs = String(bv).toLowerCase()
      if (as < bs) return sortDirection === 'asc' ? -1 : 1
      if (as > bs) return sortDirection === 'asc' ? 1 : -1
      return 0
    })
  }, [columns, data, sortDirection, sortKey])

  const toggleSort = (key: string) => {
    const nextDirection = sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc'
    if (onSortChange) {
      onSortChange(key, nextDirection)
      return
    }
    if (sortKey !== key) {
      setLocalSortKey(key)
      setLocalSortDirection('asc')
      writeStoredSort(persistSortEntity, key, 'asc')
      return
    }
    setLocalSortDirection((prev) => {
      const next = prev === 'asc' ? 'desc' : 'asc'
      writeStoredSort(persistSortEntity, key, next)
      return next
    })
  }

  return (
    <ResponsiveTableContainer className="rounded-md border bg-card">
      <table className="w-full min-w-[640px] table-fixed text-sm">
        <thead className="sticky top-0 z-10 bg-muted/60">
          <tr>
            {columns.map((column) => {
              const canResize = resizableColumns && column.resizable !== false
              const width = widths[column.key] ?? column.defaultWidth
              return (
                <th
                  key={column.key}
                  className={cn(
                    'relative px-3 py-2 text-left font-medium',
                    column.headerClassName,
                    column.className
                  )}
                  style={width ? { width, minWidth: width } : undefined}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      className="inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-md px-1 active:text-foreground"
                      onClick={() => toggleSort(column.key)}
                    >
                      <span className="truncate">{column.header}</span>
                      {sortKey === column.key ? (
                        sortDirection === 'asc' ? (
                          <ArrowUp className="h-3 w-3 shrink-0" />
                        ) : (
                          <ArrowDown className="h-3 w-3 shrink-0" />
                        )
                      ) : null}
                    </button>
                  ) : (
                    <span className="truncate">{column.header}</span>
                  )}
                  {canResize ? (
                    <ColumnResizeHandle onResizeStart={(x) => onResizeStart(column.key, x)} />
                  ) : null}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((item) => {
            const id = rowKey(item)
            const highlighted = Boolean(highlightedRowId && highlightedRowId === id)
            return (
              <tr
                key={id}
                data-row-id={id}
                className={cn(
                  'border-t active:bg-muted/40 sm:hover:bg-muted/30 transition-colors',
                  onRowClick ? 'cursor-pointer touch-active-row' : '',
                  highlighted ? 'bg-amber-50 ring-2 ring-inset ring-amber-300' : ''
                )}
                onClick={() => onRowClick?.(item)}
              >
                {columns.map((column) => {
                  const width = widths[column.key] ?? column.defaultWidth
                  return (
                    <td
                      key={column.key}
                      className={cn('px-3 py-2 align-middle', column.className)}
                      style={width ? { width, minWidth: 48, maxWidth: width } : undefined}
                    >
                      {column.render(item)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </ResponsiveTableContainer>
  )
}
