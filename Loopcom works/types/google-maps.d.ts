declare namespace google {
  namespace maps {
    class Map {
      constructor(element: HTMLElement, options?: MapOptions)
    }

    class Marker {
      constructor(options?: MarkerOptions)
      addListener(event: string, handler: Function): void
    }

    class Geocoder {
      geocode(request: GeocoderRequest, callback: (results: GeocoderResult[] | null, status: GeocoderStatus) => void): void
    }

    class InfoWindow {
      constructor(options?: InfoWindowOptions)
      open(map: Map, marker?: Marker): void
    }

    interface MapOptions {
      center?: LatLng | LatLngLiteral
      zoom?: number
      mapTypeControl?: boolean
      streetViewControl?: boolean
      fullscreenControl?: boolean
    }

    interface MarkerOptions {
      position?: LatLng | LatLngLiteral
      map?: Map
      title?: string
      icon?: string | Icon
    }

    interface InfoWindowOptions {
      content?: string | HTMLElement
    }

    interface GeocoderRequest {
      address?: string
      location?: LatLng | LatLngLiteral
    }

    interface GeocoderResult {
      geometry: GeocoderGeometry
    }

    interface GeocoderGeometry {
      location: LatLng
    }

    type GeocoderStatus = 'OK' | 'ZERO_RESULTS' | 'OVER_QUERY_LIMIT' | 'REQUEST_DENIED' | 'INVALID_REQUEST' | 'UNKNOWN_ERROR'

    interface LatLng {
      lat(): number
      lng(): number
    }

    interface LatLngLiteral {
      lat: number
      lng: number
    }

    interface Icon {
      url: string
    }
  }
}

interface Window {
  google?: typeof google
}
