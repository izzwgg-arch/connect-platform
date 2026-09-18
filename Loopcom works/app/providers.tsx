'use client'

import { ThemeProvider } from 'next-themes'
import { BrandingProvider } from '@/components/branding/BrandingProvider'

/**
 * Theme: the same light/dark switch the Loopcom portal has. `class` strategy
 * (`.dark` on <html>), remembered per browser under `lw-theme`, light by
 * default, never follows the OS on its own — the portal's rule (see
 * apps/portal/components/LoginThemeToggle.tsx).
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey="lw-theme">
      <BrandingProvider>{children}</BrandingProvider>
    </ThemeProvider>
  )
}
