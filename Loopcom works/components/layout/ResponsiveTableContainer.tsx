import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ResponsiveTableContainerProps {
  children: ReactNode
  className?: string
}

/**
 * Intentional horizontal scroll container for wide tables.
 * Keeps page layout from overflowing while allowing table pan on mobile.
 */
export function ResponsiveTableContainer({
  children,
  className,
}: ResponsiveTableContainerProps) {
  return (
    <div
      className={cn(
        '-mx-4 overflow-x-auto overscroll-x-contain px-4 touch-pan-x sm:mx-0 sm:px-0',
        className
      )}
    >
      {children}
    </div>
  )
}
