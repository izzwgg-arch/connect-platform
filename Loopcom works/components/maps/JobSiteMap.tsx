'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

interface JobSiteMapProps {
  address: {
    street: string
    city: string
    state: string
    zipCode: string
    country?: string
  }
  jobTitle?: string
  height?: string
  zoom?: number
}

export function JobSiteMap({ address, jobTitle, height = '400px', zoom = 15 }: JobSiteMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const [useEmbedFallback, setUseEmbedFallback] = useState(false)
  const fullAddress = useMemo(
    () => `${address.street}, ${address.city}, ${address.state} ${address.zipCode}`,
    [address.street, address.city, address.state, address.zipCode]
  )
  const embedSrc = useMemo(
    () => `https://maps.google.com/maps?q=${encodeURIComponent(fullAddress)}&output=embed`,
    [fullAddress]
  )

  useEffect(() => {
    if (!mapRef.current || !window.google || !(window as any).google?.maps) {
      setUseEmbedFallback(true)
      return
    }
    
    const geocoder = new (window as any).google.maps.Geocoder()
    geocoder.geocode({ address: fullAddress }, (results: any, status: any) => {
      if (status === 'OK' && results && results[0]) {
        setUseEmbedFallback(false)
        const location = results[0].geometry.location

        const map = new (window as any).google.maps.Map(mapRef.current!, {
          center: location,
          zoom: zoom,
          mapTypeControl: true,
          streetViewControl: true,
          fullscreenControl: true,
        })

        const marker = new (window as any).google.maps.Marker({
          position: location,
          map: map,
          title: jobTitle || fullAddress,
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
          },
        })

        // Add info window
        if (jobTitle) {
          const infoWindow = new (window as any).google.maps.InfoWindow({
            content: `<div><strong>${jobTitle}</strong><br/>${fullAddress}</div>`,
          })
          marker.addListener('click', () => {
            infoWindow.open(map, marker)
          })
        }
      } else {
        setUseEmbedFallback(true)
      }
    })
  }, [fullAddress, jobTitle, zoom])

  return (
    <div className="w-full rounded-lg overflow-hidden border border-gray-300">
      {useEmbedFallback ? (
        <iframe
          title={jobTitle || 'Job Site Map'}
          className="w-full"
          style={{ height }}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          src={embedSrc}
        />
      ) : (
        <div ref={mapRef} style={{ height }} className="w-full" />
      )}
    </div>
  )
}
