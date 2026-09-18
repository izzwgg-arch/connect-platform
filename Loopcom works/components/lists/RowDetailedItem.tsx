'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface RowDetailedItemProps {
  href?: string
  onClick?: () => void
  leading?: ReactNode
  primary: ReactNode
  status?: ReactNode
  line2?: ReactNode
  rightTop?: ReactNode
  rightBottom?: ReactNode
  actions?: ReactNode
  className?: string
  rowId?: string
  highlighted?: boolean
}

export function RowDetailedItem({
  href,
  onClick,
  leading,
  primary,
  status,
  line2,
  rightTop,
  rightBottom,
  actions,
  className,
  rowId,
  highlighted,
}: RowDetailedItemProps) {
  const content = (
    <div
      data-row-id={rowId}
      className={cn(
        'rounded-md border bg-card px-4 py-3 hover:bg-muted/30 transition-colors',
        highlighted ? 'ring-2 ring-amber-300 bg-amber-50' : '',
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {leading && <div className="mt-0.5 shrink-0">{leading}</div>}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-medium">{primary}</div>
            {status}
          </div>
          {line2 && <div className="mt-1 truncate text-xs text-muted-foreground">{line2}</div>}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            {rightTop && <div className="text-sm font-semibold">{rightTop}</div>}
            {rightBottom && <div className="text-xs text-muted-foreground">{rightBottom}</div>}
          </div>
          {actions}
        </div>
      </div>
    </div>
  )

  if (href) {
    return <Link href={href}>{content}</Link>
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="w-full text-left">
        {content}
      </button>
    )
  }

  return content
}

