'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useBranding } from '@/components/branding/BrandingProvider'

/**
 * LoopCom Works brand components (2026-09-18).
 *
 * The export names are TrimPro's — `TrimProLogo`, `TrimProMark`, `TrimProIcon`,
 * `TrimProLoginBadge` — because eight files import them and this pass changes
 * looks only. What they RENDER is the Loopcom Signal Core kit: the wordmark
 * (`/brand/loopcom-wordmark-560.png`, one transparent PNG that reads on light
 * and dark — Izzy's decision 2026-08-16) with a typographic "Works" tag beside
 * it, and the square infinity mark (`/brand/loopcom-icon-64.png`).
 */

export const LOOPCOM_WORDMARK = '/brand/loopcom-wordmark-560.png'
export const LOOPCOM_MARK = '/brand/loopcom-icon-64.png'

interface TrimProMarkProps {
  size?: number
  className?: string
}

/** The square Loopcom mark (infinity), for avatars, favicons-in-page and compact spots. */
export function TrimProIcon({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <img
      src={LOOPCOM_MARK}
      alt="Loopcom"
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

/** The "Works" product tag that sits beside the LOOPCOM wordmark. */
export function WorksTag({ className }: { className?: string }) {
  return <span className={cn('lw-works-tag shrink-0', className)}>Works</span>
}

/** Wordmark + Works tag lockup at a given wordmark height. */
export function LoopcomWorksLockup({
  height = 26,
  className,
  tagClassName,
}: {
  height?: number
  className?: string
  tagClassName?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <img
        src={LOOPCOM_WORDMARK}
        alt="Loopcom"
        width={560}
        height={99}
        className="block w-auto"
        style={{ height, width: 'auto' }}
      />
      <WorksTag className={tagClassName} />
    </span>
  )
}

/** Auth-page badge: the wordmark lockup at sign-in size (portal: 252px wide wordmark). */
export function TrimProLoginBadge({ className }: { className?: string }) {
  return (
    <div className={cn('inline-flex items-center justify-center gap-2.5', className)}>
      <img
        src={LOOPCOM_WORDMARK}
        alt="Loopcom"
        width={560}
        height={99}
        className="block h-auto"
        style={{ width: 'min(212px, 60vw)' }}
      />
      <WorksTag className="text-[12px] px-[9px] py-[5px]" />
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
  sm: { height: 22, maxWidth: 160 },
  md: { height: 26, maxWidth: 220 },
  lg: { height: 34, maxWidth: 280 },
} as const

/** Sidebar header stays compact (h-14/h-16); the wordmark sits at topbar height. */
const SIDEBAR_LOGO_DIMS = { height: 19, maxWidth: 168 } as const

function resolveLogoDims(variant: 'sidebar' | 'light', size: keyof typeof sizeMap) {
  if (variant === 'sidebar') return SIDEBAR_LOGO_DIMS
  return sizeMap[size]
}

/**
 * The app logo. A tenant that uploaded its own web logo in Settings › Branding
 * still gets it (`webLogoUrl`); everyone else gets the LoopCom Works lockup.
 * `size="sm"` (the collapsed rail) shows just the square mark.
 */
export function TrimProLogo({ variant = 'light', size = 'md', className }: TrimProLogoProps) {
  const { height, maxWidth } = resolveLogoDims(variant, size)
  const { webLogoUrl } = useBranding()
  const [errored, setErrored] = useState(false)

  // Reset error flag whenever a new logo URL is supplied (e.g. after branding API fetch)
  useEffect(() => {
    setErrored(false)
  }, [webLogoUrl])

  const customLogo = !errored && webLogoUrl ? webLogoUrl : null

  if (customLogo) {
    return (
      <div
        className={cn('inline-flex min-h-0 max-w-full items-center justify-start', className)}
        style={{ height: variant === 'sidebar' ? 40 : height + 12, maxWidth }}
      >
        <img
          src={customLogo}
          alt="Company logo"
          className="block h-full w-auto max-h-full max-w-full object-contain object-left"
          style={{ objectPosition: 'left center' }}
          onError={() => setErrored(true)}
        />
      </div>
    )
  }

  if (variant === 'sidebar' && size === 'sm') {
    return <TrimProIcon size={30} className={className} />
  }

  return (
    <LoopcomWorksLockup
      height={height}
      className={cn('min-h-0 max-w-full', className)}
      tagClassName={height < 24 ? 'text-[9px] px-[5px] py-[2px] tracking-[0.1em]' : undefined}
    />
  )
}
