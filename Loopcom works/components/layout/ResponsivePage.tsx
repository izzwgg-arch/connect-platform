import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ResponsivePageProps {
  children: ReactNode
  className?: string
}

/**
 * Standard page wrapper: prevents accidental horizontal overflow on narrow viewports
 * while preserving desktop spacing.
 */
export function ResponsivePage({ children, className }: ResponsivePageProps) {
  return (
    <div
      className={cn(
        'min-w-0 max-w-full space-y-4 overflow-x-hidden sm:space-y-6',
        className
      )}
    >
      {children}
    </div>
  )
}
