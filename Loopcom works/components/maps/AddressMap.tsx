'use client'

import { useEffect, useRef } from 'react'

interface AddressMapProps {
  address: {
    street: string
    city: string
    state: string
    zipCode: string
    country?: string
  }
  height?: string
  zoom?: number
}

export function AddressMap({ address, height = '400px', zoom = 15 }: AddressMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)

  useEffect(() => {
    if (!mapRef.current || !window.google) return

    const fullAddress = `${address.street}, ${address.city}, ${address.state} ${address.zipCode}`
    
    // Geocode address
    const geocoder = new google.maps.Geocoder()
    geocoder.geocode({ address: fullAddress }, (results: any, status: any) => {
      if (status === 'OK' && results && results[0]) {
        const location = results[0].geometry.location

        // Create map
        const map = new (window as any).google.maps.Map(mapRef.current!, {
          center: location,
          zoom: zoom,
          mapTypeControl: true,
          streetViewControl: true,
        })

        // Add marker
        new (window as any).google.maps.Marker({
          position: location,
          map: map,
          title: fullAddress,
        })

        mapInstanceRef.current = map
      } else {
        console.error('Geocoding failed:', status)
        // Fallback: show error message
        if (mapRef.current) {
          mapRef.current.innerHTML = `
            <div class="flex items-center justify-center h-full bg-gray-100 text-gray-600">
              <p>Unable to load map for this address</p>
            </div>
          `
        }
      }
    })
  }, [address, zoom])

  return (
    <div className="w-full rounded-lg overflow-hidden border border-gray-300">
      <div ref={mapRef} style={{ height }} className="w-full" />
    </div>
  )
}

// Load Google Maps script
export function loadGoogleMapsScript(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Maps'))
    document.head.appendChild(script)
  })
}
