'use client'

import { useEffect, useState } from 'react'
import { loadGoogleMapsScript } from './AddressMap'

interface GoogleMapsLoaderProps {
  children: React.ReactNode
}

export function GoogleMapsLoader({ children }: GoogleMapsLoaderProps) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      // Prefer build-time injected public key (fast path).
      let apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim()

      // Fallback: session cache (avoids hitting API on every route change).
      if (!apiKey && typeof window !== 'undefined') {
        apiKey = window.sessionStorage.getItem('googleMapsApiKey')?.trim() || undefined
      }

      // Fallback: fetch key from server env at runtime (covers misnamed env vars like GOOGLE_MAPS_API_KEY).
      if (!apiKey) {
        try {
          const token = window.localStorage.getItem('accessToken')
          const res = await fetch('/api/maps/key', {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          })
          if (res.ok) {
            const data = (await res.json()) as { apiKey?: string }
            if (typeof data.apiKey === 'string' && data.apiKey.trim()) {
              apiKey = data.apiKey.trim()
              window.sessionStorage.setItem('googleMapsApiKey', apiKey)
            }
          }
        } catch (e) {
          // Ignore - we'll show a friendly fallback message below.
        }
      }

      if (!apiKey) {
        if (!cancelled) {
          setError('Google Maps API key not configured')
          setLoaded(true)
        }
        return
      }

      if (window.google && window.google.maps) {
        if (!cancelled) setLoaded(true)
        return
      }

      try {
        await loadGoogleMapsScript(apiKey)
        if (!cancelled) {
          setLoaded(true)
          setError(null)
        }
      } catch (err) {
        console.error('Failed to load Google Maps:', err)
        if (!cancelled) {
          setError('Failed to load Google Maps. Please check your API key.')
          setLoaded(true) // Still render children even if maps fail
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      {error && (
        <div className="mb-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800">{error}</p>
          <p className="text-xs text-yellow-600 mt-1">
            Falling back to embedded map view.
          </p>
        </div>
      )}
      {(loaded || error) && children}
      {!loaded && !error && (
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          Loading map...
        </div>
      )}
    </>
  )
}
