'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Renders saved text exactly as typed (keeps newlines and spaces). */
export function PreservedText({
  children,
  className,
  as: Tag = 'span',
}: {
  children: ReactNode
  className?: string
  as?: 'span' | 'div' | 'p' | 'td'
}) {
  return (
    <Tag className={cn('whitespace-pre-wrap break-words', className)}>
      {children}
    </Tag>
  )
}
