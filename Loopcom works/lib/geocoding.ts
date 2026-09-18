import { prisma } from '@/lib/prisma'
import type { ParsedAddressParts } from '@/lib/address/parse'

interface GeocodeResult {
  latitude: number
  longitude: number
  precision: 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE'
}

const GEOCODING_CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Geocode an address using Google Maps Geocoding API
 */
export async function geocodeAddress(address: {
  street: string
  city: string
  state: string
  zipCode: string
  country?: string
}): Promise<GeocodeResult | null> {
  const apiKey =
    process.env.GOOGLE_MAPS_SERVER_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    console.warn('Google Maps API key not configured')
    return null
  }

  const fullAddress = `${address.street}, ${address.city}, ${address.state} ${address.zipCode}${address.country ? `, ${address.country}` : ''}`

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress)}&key=${apiKey}`
    )

    if (!response.ok) {
      throw new Error(`Geocoding API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      console.warn(`Geocoding failed for address: ${fullAddress}`, data.status)
      return null
    }

    const result = data.results[0]
    const location = result.geometry.location

    // Determine precision from location_type
    let precision: GeocodeResult['precision'] = 'APPROXIMATE'
    switch (result.geometry.location_type) {
      case 'ROOFTOP':
        precision = 'ROOFTOP'
        break
      case 'RANGE_INTERPOLATED':
        precision = 'RANGE_INTERPOLATED'
        break
      case 'GEOMETRIC_CENTER':
        precision = 'GEOMETRIC_CENTER'
        break
      default:
        precision = 'APPROXIMATE'
    }

    return {
      latitude: location.lat,
      longitude: location.lng,
      precision,
    }
  } catch (error) {
    console.error('Geocoding error:', error)
    return null
  }
}

/**
 * Geocode and update an address in the database
 */
export async function geocodeAndUpdateAddress(addressId: string): Promise<GeocodeResult | null> {
  const address = await prisma.address.findUnique({
    where: { id: addressId },
  })

  if (!address) {
    throw new Error('Address not found')
  }

  // Skip if recently geocoded
  if (address.latitude && address.longitude) {
    // Could check a geocodedAt timestamp if we add it, but for now just use existing
    return {
      latitude: address.latitude,
      longitude: address.longitude,
      precision: 'ROOFTOP', // Assume existing is good
    }
  }

  const result = await geocodeAddress({
    street: address.street,
    city: address.city,
    state: address.state,
    zipCode: address.zipCode,
    country: address.country,
  })

  if (result) {
    await prisma.address.update({
      where: { id: addressId },
      data: {
        latitude: result.latitude,
        longitude: result.longitude,
      },
    })
  }

  return result
}

/**
 * Batch geocode multiple addresses with rate limiting
 */
export async function batchGeocodeAddresses(addressIds: string[], delayMs = 200): Promise<number> {
  let successCount = 0

  for (const addressId of addressIds) {
    try {
      const result = await geocodeAndUpdateAddress(addressId)
      if (result) {
        successCount++
      }
      // Rate limiting delay
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    } catch (error) {
      console.error(`Failed to geocode address ${addressId}:`, error)
    }
  }

  return successCount
}

/**
 * Geocode a freeform address string and extract structured parts for UI display.
 * Used for Leads/Requests where we only store a single jobSiteAddress text field.
 */
export async function geocodeAddressPartsFromString(addressText: string): Promise<ParsedAddressParts | null> {
  const raw = String(addressText || '').trim()
  if (!raw) return null

  const apiKey =
    process.env.GOOGLE_MAPS_SERVER_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  if (!apiKey) return null

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(raw)}&key=${apiKey}`
    )

    if (!response.ok) return null

    const data: any = await response.json()
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) return null

    const result = data.results[0]
    const components: Array<{ long_name: string; short_name: string; types: string[] }> = result.address_components || []

    const get = (type: string, which: 'short_name' | 'long_name' = 'long_name') => {
      const comp = components.find((c) => Array.isArray(c.types) && c.types.includes(type))
      return comp ? String(comp[which] || '').trim() : ''
    }

    const streetNumber = get('street_number')
    const route = get('route')
    const street = [streetNumber, route].filter(Boolean).join(' ').trim() || raw

    const city =
      get('locality') ||
      get('postal_town') ||
      get('sublocality') ||
      get('administrative_area_level_2')

    const state = get('administrative_area_level_1', 'short_name') || get('administrative_area_level_1')
    let zipCode = get('postal_code')
    const country = get('country', 'short_name') || undefined

    // Sometimes forward geocode returns a partial match without postal_code. If we have a point,
    // reverse geocode it to find the best postal code for that location.
    if (!zipCode) {
      const loc = result?.geometry?.location
      const lat = typeof loc?.lat === 'number' ? loc.lat : null
      const lng = typeof loc?.lng === 'number' ? loc.lng : null
      if (lat !== null && lng !== null) {
        const reverseRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(
            `${lat},${lng}`
          )}&key=${apiKey}`
        )
        if (reverseRes.ok) {
          const reverseData: any = await reverseRes.json().catch(() => null)
          const reverseResults: any[] = reverseData?.results || []
          // Find the first result that contains a postal_code component.
          for (const rr of reverseResults) {
            const rrComponents: Array<{ long_name: string; short_name: string; types: string[] }> =
              rr?.address_components || []
            const postal = rrComponents.find((c) => Array.isArray(c.types) && c.types.includes('postal_code'))
            if (postal?.long_name) {
              zipCode = String(postal.long_name).trim()
              break
            }
          }
        }
      }
    }

    if (!city && !state && !zipCode) return null

    return {
      street,
      city,
      state,
      zipCode,
      country,
    }
  } catch (error) {
    console.error('geocodeAddressPartsFromString error:', error)
    return null
  }
}
