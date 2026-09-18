export interface ParsedAddressParts {
  street: string
  city: string
  state: string
  zipCode: string
  country?: string
}

export function parseAddressParts(address: string | null | undefined): ParsedAddressParts | null {
  if (!address) return null
  const raw = String(address).trim()
  if (!raw) return null

  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  if (parts.length === 0) return null

  const street = parts[0] || ''
  const city = parts[1] || ''
  const stateZip = parts[2] || ''
  const country = parts[3] || undefined

  const stateZipMatch = stateZip.match(/^([A-Za-z]{2})\s+(.+)$/)
  const state = stateZipMatch ? stateZipMatch[1] : stateZip
  const zipCode = stateZipMatch ? stateZipMatch[2] : ''

  return {
    street,
    city,
    state,
    zipCode,
    country,
  }
}

export function formatAddressParts(address: {
  street?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
} | null | undefined): string | null {
  if (!address) return null
  const parts = [
    (address.street || '').trim(),
    (address.city || '').trim(),
    `${(address.state || '').trim()} ${(address.zipCode || '').trim()}`.trim(),
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}
