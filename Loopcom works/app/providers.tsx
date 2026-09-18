'use client'

import { BrandingProvider } from '@/components/branding/BrandingProvider'

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <BrandingProvider>{children}</BrandingProvider>
}

