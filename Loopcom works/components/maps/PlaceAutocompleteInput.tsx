'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MapPin } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  DROPDOWN_EMPTY,
  DROPDOWN_ITEM,
  DROPDOWN_LIST,
  DROPDOWN_PANEL,
  DROPDOWN_SEARCH_WRAP,
} from '@/components/ui/dropdown-styles'

type AddressParts = {
  street: string
  city: string
  state: string
  zipCode: string
}

type Suggestion = {
  placeId: string
  description: string
  primaryText?: string
  secondaryText?: string
}

function parseAddressComponents(
  components: Array<{ long_name: string; short_name: string; types: string[] }>
): AddressParts {
  const get = (type: string, which: 'short_name' | 'long_name' = 'long_name') => {
    const comp = components.find((c) => Array.isArray(c.types) && c.types.includes(type))
    return comp ? String(comp[which] || '').trim() : ''
  }
  const streetNumber = get('street_number')
  const route = get('route')
  const street = [streetNumber, route].filter(Boolean).join(' ').trim()
  const city =
    get('locality') ||
    get('postal_town') ||
    get('sublocality') ||
    get('administrative_area_level_2')
  const state = get('administrative_area_level_1', 'short_name') || get('administrative_area_level_1')
  const zipCode = get('postal_code')
  return { street, city, state, zipCode }
}

async function reverseGeocodeZip(location: { lat: number; lng: number }): Promise<string> {
  if (!window.google?.maps?.Geocoder) return ''
  const geocoder = new window.google.maps.Geocoder()
  const res = await new Promise<any>((resolve) => {
    geocoder.geocode({ location }, (results: any, status: any) => {
      resolve({ results, status })
    })
  })
  if (res.status !== 'OK' || !Array.isArray(res.results)) return ''
  for (const rr of res.results) {
    const comps = rr?.address_components || []
    const postal = comps.find((c: any) => Array.isArray(c.types) && c.types.includes('postal_code'))
    if (postal?.long_name) return String(postal.long_name).trim()
  }
  return ''
}

export function PlaceAutocompleteInput(props: {
  value: string
  onChangeText: (value: string) => void
  onAddressSelected: (params: {
    placeId: string
    description: string
    address: AddressParts
  }) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  inputId?: string
}) {
  const {
    value,
    onChangeText,
    onAddressSelected,
    placeholder = 'Start typing an address…',
    disabled,
    className,
    inputId,
  } = props

  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const sessionTokenRef = useRef<any>(null)
  const lastQueryRef = useRef<string>('')

  const hasGooglePlaces = Boolean((window as any)?.google?.maps?.places?.AutocompleteService)

  useEffect(() => {
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocumentMouseDown)
    return () => document.removeEventListener('mousedown', onDocumentMouseDown)
  }, [])

  useEffect(() => {
    if (!open) return
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      () => {
        // Ignore (permission denied, etc). Autocomplete will still work.
      },
      { maximumAge: 60_000, timeout: 4000 }
    )
  }, [open])

  const service = useMemo(() => {
    if (!hasGooglePlaces) return null
    return new (window as any).google.maps.places.AutocompleteService()
  }, [hasGooglePlaces])

  const detailsService = useMemo(() => {
    if (!(window as any)?.google?.maps?.places?.PlacesService) return null
    // PlacesService needs an "HTMLDivElement" container; it doesn't have to be mounted.
    const div = document.createElement('div')
    return new (window as any).google.maps.places.PlacesService(div)
  }, [])

  const ensureSessionToken = () => {
    const ctor = (window as any)?.google?.maps?.places?.AutocompleteSessionToken
    if (!ctor) return null
    if (!sessionTokenRef.current) sessionTokenRef.current = new ctor()
    return sessionTokenRef.current
  }

  useEffect(() => {
    if (!open) return
    if (!service) return

    const q = String(value || '').trim()
    if (q.length < 3) {
      setSuggestions([])
      setLoading(false)
      setError(null)
      return
    }

    const handle = window.setTimeout(() => {
      if (!service) return
      if (lastQueryRef.current === q) return
      lastQueryRef.current = q
      setLoading(true)
      setError(null)

      const token = ensureSessionToken()
      const request: any = {
        input: q,
        types: ['address'],
        sessionToken: token || undefined,
        componentRestrictions: { country: 'us' },
      }

      // Bias results toward the user's current location when available.
      if (userLocation) {
        request.location = new (window as any).google.maps.LatLng(userLocation.lat, userLocation.lng)
        request.radius = 50_000 // 50km bias
      }

      service.getPlacePredictions(request, (predictions: any[], status: any) => {
        setLoading(false)
        if (status !== (window as any).google.maps.places.PlacesServiceStatus.OK || !predictions) {
          setSuggestions([])
          if (status && status !== (window as any).google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
            setError('Unable to load address suggestions.')
          }
          return
        }

        const mapped: Suggestion[] = predictions.slice(0, 8).map((p: any) => ({
          placeId: String(p.place_id),
          description: String(p.description),
          primaryText: p?.structured_formatting?.main_text,
          secondaryText: p?.structured_formatting?.secondary_text,
        }))
        setSuggestions(mapped)
      })
    }, 220)

    return () => window.clearTimeout(handle)
  }, [open, service, userLocation, value])

  const selectSuggestion = async (s: Suggestion) => {
    setOpen(false)
    setError(null)

    if (!detailsService) {
      // Fallback: we still set the text, but we can't reliably parse components.
      onAddressSelected({
        placeId: s.placeId,
        description: s.description,
        address: { street: s.description, city: '', state: '', zipCode: '' },
      })
      sessionTokenRef.current = null
      return
    }

    const token = ensureSessionToken()
    setLoading(true)

    const place = await new Promise<any>((resolve) => {
      detailsService.getDetails(
        {
          placeId: s.placeId,
          sessionToken: token || undefined,
          fields: ['address_components', 'geometry', 'formatted_address'],
        },
        (res: any, status: any) => resolve({ res, status })
      )
    })

    setLoading(false)
    if (place.status !== (window as any).google.maps.places.PlacesServiceStatus.OK || !place.res) {
      setError('Unable to load address details.')
      return
    }

    const formatted = String(place.res.formatted_address || s.description || '').trim()
    const components = place.res.address_components || []
    const parsed = parseAddressComponents(components)

    let zipCode = parsed.zipCode
    const loc = place.res?.geometry?.location
    const lat = typeof loc?.lat === 'function' ? loc.lat() : typeof loc?.lat === 'number' ? loc.lat : null
    const lng = typeof loc?.lng === 'function' ? loc.lng() : typeof loc?.lng === 'number' ? loc.lng : null
    if (!zipCode && lat !== null && lng !== null) {
      zipCode = await reverseGeocodeZip({ lat, lng })
    }

    onAddressSelected({
      placeId: s.placeId,
      description: formatted,
      address: {
        street: parsed.street || formatted,
        city: parsed.city,
        state: parsed.state,
        zipCode,
      },
    })

    // End this billing session.
    sessionTokenRef.current = null
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Input
          id={inputId}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChangeText(e.target.value)
            setOpen(true)
          }}
          className="pr-10"
          aria-autocomplete="list"
          aria-expanded={open}
          autoComplete="off"
        />
        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1 text-muted-foreground">
          <MapPin className="h-4 w-4 opacity-70" />
          <ChevronDown className="h-4 w-4 opacity-70" />
        </div>
      </div>

      {open && (
        <div className={cn(DROPDOWN_PANEL, 'mt-2')}>
          <div className={DROPDOWN_SEARCH_WRAP}>
            <div className="text-xs text-muted-foreground">
              {hasGooglePlaces ? 'Select a real address from the list.' : 'Loading Google Places…'}
            </div>
          </div>

          <div className={DROPDOWN_LIST}>
            {error ? <div className={DROPDOWN_EMPTY}>{error}</div> : null}
            {!error && loading ? <div className={DROPDOWN_EMPTY}>Searching…</div> : null}
            {!error && !loading && suggestions.length === 0 ? (
              <div className={DROPDOWN_EMPTY}>Start typing to see suggestions.</div>
            ) : null}

            {!error &&
              suggestions.map((s) => (
                <button
                  key={s.placeId}
                  type="button"
                  className={cn('group', DROPDOWN_ITEM)}
                  onClick={() => void selectSuggestion(s)}
                >
                  <div className="truncate font-medium">{s.primaryText || s.description}</div>
                  {s.secondaryText ? (
                    <div className="truncate text-xs text-muted-foreground group-hover:text-white">
                      {s.secondaryText}
                    </div>
                  ) : null}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

