'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface RowCompactItemProps {
  href?: string
  onClick?: () => void
  leading?: ReactNode
  primary: ReactNode
  secondary?: ReactNode
  status?: ReactNode
  amount?: ReactNode
  date?: ReactNode
  actions?: ReactNode
  className?: string
  rowId?: string
  highlighted?: boolean
}

export function RowCompactItem({
  href,
  onClick,
  leading,
  primary,
  secondary,
  status,
  amount,
  date,
  actions,
  className,
  rowId,
  highlighted,
}: RowCompactItemProps) {
  const content = (
    <div
      data-row-id={rowId}
      className={cn(
        'flex items-center gap-3 rounded-md border bg-card px-4 py-3 hover:bg-muted/30 transition-colors',
        highlighted ? 'ring-2 ring-amber-300 bg-amber-50' : '',
        className
      )}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{primary}</div>
        {secondary && <div className="truncate text-xs text-muted-foreground">{secondary}</div>}
      </div>
      {status && <div className="shrink-0">{status}</div>}
      {amount && <div className="shrink-0 text-sm font-semibold">{amount}</div>}
      {date && <div className="shrink-0 text-xs text-muted-foreground">{date}</div>}
      {actions && <div className="shrink-0">{actions}</div>}
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

