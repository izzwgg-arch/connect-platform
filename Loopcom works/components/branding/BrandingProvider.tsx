'use client'

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { hexToHslCssValue } from '@/lib/branding/theme'

type BrandingRecord = Record<string, string | null> | null

interface BrandingContextValue {
  branding: BrandingRecord
  webLogoUrl: string | null
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: null,
  webLogoUrl: null,
})

const ROOT_VAR_KEYS = [
  '--brand-primary-color',
  '--brand-secondary-color',
  '--brand-background-color',
  '--brand-sidebar-color',
  '--brand-sidebar-border-color',
  '--brand-menu-color',
  '--brand-button-color',
  '--brand-button-hover-color',
  '--brand-button-text-color',
  '--brand-text-primary-color',
  '--brand-text-secondary-color',
  '--brand-link-color',
  '--brand-border-color',
  '--brand-success-color',
  '--brand-warning-color',
  '--brand-danger-color',
]

/** Shift each RGB channel by `delta` (positive = lighter, negative = darker). */
function shiftHex(hex: string, delta: number): string {
  const n = hex.replace('#', '')
  if (n.length !== 6) return hex
  const clamp = (v: number) => Math.min(255, Math.max(0, v))
  const r = clamp(parseInt(n.slice(0, 2), 16) + delta)
  const g = clamp(parseInt(n.slice(2, 4), 16) + delta)
  const b = clamp(parseInt(n.slice(4, 6), 16) + delta)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function applyBrandingVariables(branding: BrandingRecord) {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  // Start by clearing additive vars to preserve baseline defaults.
  for (const key of ROOT_VAR_KEYS) {
    root.style.removeProperty(key)
  }

  if (!branding) return

  const uiMap: Record<string, string | null | undefined> = {
    '--brand-primary-color': branding.primaryColor,
    '--brand-secondary-color': branding.secondaryColor,
    '--brand-background-color': branding.backgroundColor,
    '--brand-sidebar-color': branding.sidebarColor,
    '--brand-menu-color': branding.menuColor,
    '--brand-button-color': branding.buttonColor,
    '--brand-button-text-color': branding.buttonTextColor,
    '--brand-text-primary-color': branding.textPrimaryColor,
    '--brand-text-secondary-color': branding.textSecondaryColor,
    '--brand-link-color': branding.linkColor,
    '--brand-border-color': branding.borderColor,
    '--brand-success-color': branding.successColor,
    '--brand-warning-color': branding.warningColor,
    '--brand-danger-color': branding.dangerColor,
  }

  for (const [key, value] of Object.entries(uiMap)) {
    if (value) {
      root.style.setProperty(key, value)
    }
  }

  // Derived: sidebar border = sidebar color shifted slightly lighter
  if (branding.sidebarColor) {
    root.style.setProperty('--brand-sidebar-border-color', shiftHex(branding.sidebarColor, 20))
  }

  // Derived: button hover = button color shifted slightly darker
  if (branding.buttonColor) {
    root.style.setProperty('--brand-button-hover-color', shiftHex(branding.buttonColor, -20))
  }

  const primaryHsl = branding.primaryColor ? hexToHslCssValue(branding.primaryColor) : null
  if (primaryHsl) {
    root.style.setProperty('--primary', primaryHsl)
    root.style.setProperty('--ring', primaryHsl)
  }

  const secondaryHsl = branding.secondaryColor ? hexToHslCssValue(branding.secondaryColor) : null
  if (secondaryHsl) {
    root.style.setProperty('--secondary', secondaryHsl)
  }

  const bgHsl = branding.backgroundColor ? hexToHslCssValue(branding.backgroundColor) : null
  if (bgHsl) {
    root.style.setProperty('--background', bgHsl)
    root.style.setProperty('--card', bgHsl)
  }
}

function applyBrandingIcons(branding: BrandingRecord) {
  if (typeof document === 'undefined') return
  if (!branding?.faviconUrl) return
  const version = String((branding as any)?.updatedAt || Date.now())
  const faviconUrl = String(branding.faviconUrl || '')
  const faviconWithVersion = faviconUrl
    ? `${faviconUrl}${faviconUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`
    : ''
  const linkSelectors = [
    'link[rel="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
  ]
  let appliedAny = false
  for (const selector of linkSelectors) {
    const link = document.querySelector(selector) as HTMLLinkElement | null
    if (link) {
      link.href = faviconWithVersion
      appliedAny = true
    }
  }
  if (!appliedAny && faviconWithVersion) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = faviconWithVersion
    document.head.appendChild(link)
  }
}

const BRANDING_CACHE_KEY = 'trimpro_branding_cache'

function readCachedBranding(): BrandingRecord {
  try {
    if (typeof window === 'undefined') return null
    const raw = localStorage.getItem(BRANDING_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as BrandingRecord
  } catch {
    return null
  }
}

function writeCachedBranding(branding: BrandingRecord) {
  try {
    if (typeof window === 'undefined') return
    if (branding) {
      localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(branding))
    } else {
      localStorage.removeItem(BRANDING_CACHE_KEY)
    }
  } catch {
    // ignore storage errors (private browsing, quota exceeded, etc.)
  }
}

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  // Start null for SSR compatibility (window not available on server).
  // useLayoutEffect below immediately reads the localStorage cache on the client
  // before the browser paints, eliminating the flash of the default logo.
  const [branding, setBranding] = useState<BrandingRecord>(null)

  useLayoutEffect(() => {
    const cached = readCachedBranding()
    if (cached) {
      setBranding(cached)
      applyBrandingVariables(cached)
      applyBrandingIcons(cached)
    }
  }, [])

  useEffect(() => {
    let mounted = true

    const loadBranding = async () => {
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
        const headers: HeadersInit = {}
        if (token) headers['Authorization'] = `Bearer ${token}`

        const response = await fetch('/api/branding', {
          headers,
          cache: 'no-store',
          credentials: 'include',
        })
        if (!response.ok) return
        const payload = await response.json()
        const fresh = payload?.branding || null
        if (mounted) {
          setBranding(fresh)
          writeCachedBranding(fresh)
        }
      } catch {
        // Keep cached/baseline defaults unchanged when branding cannot be loaded.
      }
    }

    void loadBranding()

    const onBrandingUpdated = () => {
      void loadBranding()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('branding-updated', onBrandingUpdated as EventListener)
    }

    return () => {
      mounted = false
      if (typeof window !== 'undefined') {
        window.removeEventListener('branding-updated', onBrandingUpdated as EventListener)
      }
    }
  }, [])

  useEffect(() => {
    applyBrandingVariables(branding)
    applyBrandingIcons(branding)
  }, [branding])

  const value = useMemo(() => {
    const rawLogoUrl = branding?.webLogoUrl || null
    const version = String((branding as any)?.updatedAt || '')
    const webLogoUrl =
      rawLogoUrl && version
        ? `${rawLogoUrl}${rawLogoUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`
        : rawLogoUrl
    return { branding, webLogoUrl }
  }, [branding])

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>
}

export function useBranding() {
  return useContext(BrandingContext)
}

