/**
 * Runtime branding context for the mobile app.
 *
 * Fetches branding from /api/public/branding at startup and whenever
 * the app comes back to the foreground. Persists the last-known config
 * to AsyncStorage so the app can render immediately on next launch
 * while the fresh fetch completes in the background.
 *
 * RUNTIME (updates via OTA after this context loads):
 *   colors, in-app logos, display name, dynamic splash image
 *
 * BUILD-TIME ONLY (requires new native build):
 *   app icon, native splash screen, app store name
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from 'react'
import { AppState, AppStateStatus } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { API_BASE_URL } from '../config/env'

const STORAGE_KEY = '@branding/config/v1'

export interface BrandingConfig {
  appDisplayName: string
  loginLogoUrl: string | null
  headerLogoUrl: string | null
  primaryColor: string
  secondaryColor: string
  accentColor: string
  buttonColor: string
  buttonTextColor: string
  sidebarColor: string
  menuColor: string
  backgroundColor: string
  invoiceLogoUrl: string | null
  emailLogoUrl: string | null
  splashScreenRuntimeImageUrl: string | null
  brandingVersion: number
}

export const DEFAULT_BRANDING: BrandingConfig = {
  appDisplayName: 'TrimPro Field',
  loginLogoUrl: null,
  headerLogoUrl: null,
  primaryColor: '#2E4A59',
  secondaryColor: '#4a7c94',
  accentColor: '#E6C98B',
  buttonColor: '#2E4A59',
  buttonTextColor: '#ffffff',
  sidebarColor: '#2E4A59',
  menuColor: '#E6C98B',
  backgroundColor: '#F5F7FA',
  invoiceLogoUrl: null,
  emailLogoUrl: null,
  splashScreenRuntimeImageUrl: null,
  brandingVersion: 0,
}

interface BrandingContextValue {
  branding: BrandingConfig
  isLoading: boolean
  refresh: () => Promise<void>
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  isLoading: true,
  refresh: async () => {},
})

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext)
}

async function fetchBrandingConfig(): Promise<BrandingConfig> {
  const url = `${API_BASE_URL}/api/public/branding`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Branding fetch failed: ${res.status}`)
  const data = await res.json()
  return {
    appDisplayName: data.appDisplayName || DEFAULT_BRANDING.appDisplayName,
    loginLogoUrl: data.loginLogoUrl || null,
    headerLogoUrl: data.headerLogoUrl || null,
    primaryColor: data.primaryColor || DEFAULT_BRANDING.primaryColor,
    secondaryColor: data.secondaryColor || DEFAULT_BRANDING.secondaryColor,
    accentColor: data.accentColor || DEFAULT_BRANDING.accentColor,
    buttonColor: data.buttonColor || DEFAULT_BRANDING.buttonColor,
    buttonTextColor: data.buttonTextColor || DEFAULT_BRANDING.buttonTextColor,
    sidebarColor: data.sidebarColor || DEFAULT_BRANDING.sidebarColor,
    menuColor: data.menuColor || DEFAULT_BRANDING.menuColor,
    backgroundColor: data.backgroundColor || DEFAULT_BRANDING.backgroundColor,
    invoiceLogoUrl: data.invoiceLogoUrl || null,
    emailLogoUrl: data.emailLogoUrl || null,
    splashScreenRuntimeImageUrl: data.splashScreenRuntimeImageUrl || null,
    brandingVersion: typeof data.brandingVersion === 'number' ? data.brandingVersion : 0,
  }
}

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = useState<BrandingConfig>(DEFAULT_BRANDING)
  const [isLoading, setIsLoading] = useState(true)
  const lastVersionRef = useRef<number>(0)

  const applyAndPersist = useCallback(async (config: BrandingConfig) => {
    setBranding(config)
    lastVersionRef.current = config.brandingVersion
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    } catch {
      // Storage failure is non-fatal
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const config = await fetchBrandingConfig()
      if (config.brandingVersion !== lastVersionRef.current || lastVersionRef.current === 0) {
        await applyAndPersist(config)
      }
    } catch {
      // Network failure — keep existing branding
    }
  }, [applyAndPersist])

  // Load persisted branding immediately, then fetch fresh in background.
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY)
        if (stored && !cancelled) {
          const parsed = JSON.parse(stored) as BrandingConfig
          setBranding(parsed)
          lastVersionRef.current = parsed.brandingVersion
        }
      } catch {
        // Ignore storage read errors
      }
      setIsLoading(false)
      if (!cancelled) {
        await refresh()
      }
    }
    init()
    return () => { cancelled = true }
  }, [refresh])

  // Re-fetch branding when the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        refresh()
      }
    })
    return () => sub.remove()
  }, [refresh])

  return (
    <BrandingContext.Provider value={{ branding, isLoading, refresh }}>
      {children}
    </BrandingContext.Provider>
  )
}
