import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/middleware'
import { geocodeAddressPartsFromString } from '@/lib/geocoding'

const STREET_SUFFIXES = new Set([
  'st',
  'street',
  'ave',
  'avenue',
  'rd',
  'road',
  'dr',
  'drive',
  'blvd',
  'boulevard',
  'ln',
  'lane',
  'ct',
  'court',
  'pl',
  'place',
  'pkwy',
  'parkway',
  'hwy',
  'highway',
  'way',
  'trl',
  'trail',
  'cir',
  'circle',
])

function buildQueryVariants(input: string): string[] {
  const query = input.trim().replace(/\s+/g, ' ')
  const variants = new Set<string>([query, `${query}, USA`])

  const tokens = query.split(' ')
  const suffixIndex = tokens.findIndex((t) => STREET_SUFFIXES.has(t.toLowerCase().replace(/[.,]/g, '')))
  if (suffixIndex >= 1 && suffixIndex < tokens.length - 1 && !query.includes(',')) {
    const streetPart = tokens.slice(0, suffixIndex + 1).join(' ')
    const localityPart = tokens.slice(suffixIndex + 1).join(' ')
    variants.add(`${streetPart}, ${localityPart}`)
    variants.add(`${streetPart}, ${localityPart}, USA`)
  }

  return Array.from(variants)
}

function normalizePredictions(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = String(raw || '').trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}

async function fetchPlacesV1Predictions(query: string, apiKey: string): Promise<string[]> {
  const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'suggestions.placePrediction.text.text',
    },
    body: JSON.stringify({
      input: query,
      languageCode: 'en',
    }),
  })

  if (!response.ok) return []
  const data: any = await response.json()
  if (!Array.isArray(data?.suggestions)) return []
  return data.suggestions
    .map((s: any) => String(s?.placePrediction?.text?.text || '').trim())
    .filter(Boolean)
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const apiKey =
    process.env.GOOGLE_MAPS_SERVER_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Google Maps API key not configured' }, { status: 500 })
  }

  const mode = String(request.nextUrl.searchParams.get('mode') || 'suggest')

  if (mode === 'resolve') {
    const address = String(request.nextUrl.searchParams.get('address') || '').trim()
    if (!address) {
      return NextResponse.json({ error: 'address is required' }, { status: 400 })
    }

    const parsed = await geocodeAddressPartsFromString(address)
    if (!parsed) {
      return NextResponse.json({ error: 'Unable to resolve address' }, { status: 404 })
    }

    return NextResponse.json({ address: parsed })
  }

  const query = String(request.nextUrl.searchParams.get('q') || '').trim()
  const limit = Math.min(parseInt(String(request.nextUrl.searchParams.get('limit') || '8'), 10) || 8, 12)

  if (query.length < 3) {
    return NextResponse.json({ predictions: [] })
  }

  try {
    const queryVariants = buildQueryVariants(query)
    const providerErrors: string[] = []

    // 0) Places Autocomplete v1 (works on projects using the new Places API).
    for (const variant of queryVariants) {
      try {
        const predictions = normalizePredictions(await fetchPlacesV1Predictions(variant, apiKey), limit)
        if (predictions.length > 0) {
          return NextResponse.json({ predictions })
        }
      } catch (error: any) {
        providerErrors.push(`places_v1:${error?.message || 'failed'}`)
      }
    }

    // 1) Google Places Autocomplete (preferred for "native Google suggestions" UX)
    for (const variant of queryVariants) {
      const placesUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
        variant
      )}&types=address&language=en&key=${encodeURIComponent(apiKey)}`
      const placesResponse = await fetch(placesUrl)
      if (!placesResponse.ok) continue
      const placesData: any = await placesResponse.json()
      if (placesData?.status && placesData.status !== 'OK' && placesData.status !== 'ZERO_RESULTS') {
        providerErrors.push(`autocomplete_legacy:${placesData.status}`)
      }
      if (Array.isArray(placesData?.predictions) && placesData.predictions.length > 0) {
        const predictions = normalizePredictions(
          placesData.predictions.map((p: any) => String(p?.description || '')),
          limit
        )
        if (predictions.length > 0) {
          return NextResponse.json({ predictions })
        }
      }
    }

    // 2) Find Place from Text
    for (const variant of queryVariants) {
      const findPlaceUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(
        variant
      )}&inputtype=textquery&fields=formatted_address&key=${encodeURIComponent(apiKey)}`
      const findPlaceResponse = await fetch(findPlaceUrl)
      if (!findPlaceResponse.ok) continue
      const findPlaceData: any = await findPlaceResponse.json()
      if (findPlaceData?.status && findPlaceData.status !== 'OK' && findPlaceData.status !== 'ZERO_RESULTS') {
        providerErrors.push(`find_place:${findPlaceData.status}`)
      }
      const predictions = normalizePredictions(
        (findPlaceData?.candidates || []).map((c: any) => String(c?.formatted_address || '')),
        limit
      )
      if (predictions.length > 0) {
        return NextResponse.json({ predictions })
      }
    }

    // 3) Geocode
    for (const variant of queryVariants) {
      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        variant
      )}&key=${encodeURIComponent(apiKey)}`
      const geocodeResponse = await fetch(geocodeUrl)
      if (!geocodeResponse.ok) continue
      const geocodeData: any = await geocodeResponse.json()
      if (geocodeData?.status && geocodeData.status !== 'OK' && geocodeData.status !== 'ZERO_RESULTS') {
        providerErrors.push(`geocode:${geocodeData.status}`)
      }
      if (!Array.isArray(geocodeData?.results)) continue
      const predictions = normalizePredictions(
        geocodeData.results.map((r: any) => String(r?.formatted_address || '')),
        limit
      )
      if (predictions.length > 0) {
        return NextResponse.json({ predictions })
      }
    }

    const uniqueErrors = Array.from(new Set(providerErrors)).slice(0, 4)
    if (uniqueErrors.length > 0) {
      return NextResponse.json({
        predictions: [],
        warning: `Google provider returned no results (${uniqueErrors.join(', ')})`,
      })
    }
    return NextResponse.json({ predictions: [] })
  } catch (error) {
    console.error('Mobile places suggest error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

