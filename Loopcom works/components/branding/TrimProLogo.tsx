'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useBranding } from '@/components/branding/BrandingProvider'

interface TrimProMarkProps {
  size?: number
  className?: string
}

export function TrimProIcon({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <img
      src="/branding/trimpro-icon.svg"
      alt="TrimPro"
      width={size}
      height={size}
      className={cn('block', className)}
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  )
}

export function TrimProMark({ size = 30, className }: TrimProMarkProps) {
  return <TrimProIcon className={className} size={size} />
}

function TrimProColumnIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 224" aria-hidden="true" className={cn('shrink-0', className)}>
      <g fill="#ffffff">
        <rect x="0" y="0" width="220" height="18" rx="4" />
        <circle cx="24" cy="36" r="10" />
        <circle cx="196" cy="36" r="10" />
        <rect x="82" y="52" width="24" height="172" rx="4" />
        <rect x="122" y="52" width="24" height="172" rx="4" />
      </g>
    </svg>
  )
}

/** Compact auth-page badge: lowercase trimpro + column mark on brand slate. */
export function TrimProLoginBadge({ className }: { className?: string }) {
  return (
    <div
      className={cn('inline-flex items-center gap-3 rounded-lg px-5 py-2.5', className)}
      style={{ backgroundColor: '#2E4A59' }}
    >
      <span
        className="text-[1.65rem] font-bold lowercase leading-none tracking-[0.01em]"
        style={{
          color: '#E6C98B',
          fontFamily: 'Avenir Next, Montserrat, Poppins, Inter, Arial, Helvetica, sans-serif',
        }}
      >
        trimpro
      </span>
      <TrimProColumnIcon className="h-9 w-9" />
    </div>
  )
}

interface TrimProLogoProps {
  variant?: 'sidebar' | 'light'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

/**
 * Height caps per size — width is always `auto` so the logo renders at its
 * natural aspect ratio without squishing. A max-width guard prevents very
 * wide panoramic logos from overflowing the sidebar.
 */
const sizeMap = {
  sm: { height: 36, maxWidth: 160 },
  md: { height: 52, maxWidth: 200 },
  lg: { height: 64, maxWidth: 240 },
} as const

/**
 * Sidebar header stays compact (h-16). Logo is sized up to fill that row
 * (~90% of header height) without increasing header padding or height.
 */
const SIDEBAR_LOGO_DIMS = { height: 58, maxWidth: 252 } as const

function resolveLogoDims(variant: 'sidebar' | 'light', size: keyof typeof sizeMap) {
  if (variant === 'sidebar') return SIDEBAR_LOGO_DIMS
  return sizeMap[size]
}

const DEFAULT_LOGO = '/branding/trimpro-logo.svg'

export function TrimProLogo({ variant = 'light', size = 'md', className }: TrimProLogoProps) {
  const { height, maxWidth } = resolveLogoDims(variant, size)
  const { webLogoUrl } = useBranding()
  const [errored, setErrored] = useState(false)

  // Reset error flag whenever a new logo URL is supplied (e.g. after branding API fetch)
  useEffect(() => {
    setErrored(false)
  }, [webLogoUrl])

  const src = !errored && webLogoUrl ? webLogoUrl : DEFAULT_LOGO

  return (
    <div
      className={cn('inline-flex min-h-0 max-w-full items-center justify-start', className)}
      style={{ height, maxWidth }}
    >
      <img
        src={src}
        alt="TrimPro"
        className="block h-full w-auto max-h-full max-w-full object-contain object-left"
        style={{ objectPosition: 'left center' }}
        onError={() => setErrored(true)}
      />
    </div>
  )
}
