'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface MobileActionBarProps {
  children: ReactNode
  className?: string
}

/**
 * Wraps dense action button groups. On phones/tablets, sticks to the bottom with
 * safe-area padding so primary actions stay reachable above the Android keyboard.
 */
export function MobileActionBar({ children, className }: MobileActionBarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        'max-lg:sticky max-lg:bottom-0 max-lg:z-30',
        'max-lg:-mx-4 max-lg:border-t max-lg:border-gray-200 max-lg:bg-white/95 max-lg:px-4 max-lg:py-3',
        'max-lg:backdrop-blur-sm max-lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        className
      )}
    >
      {children}
    </div>
  )
}
