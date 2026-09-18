'use client'

import { refreshAccessToken } from '@/lib/auth/client'

export type ClientPickerAddress = {
  id: string
  type: string
  street: string
  city: string
  state: string
  zipCode: string
  country: string
  isDefault?: boolean
}

export type ClientPickerContact = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  mobile: string | null
  isPrimary: boolean
}

export type ClientPickerDetail = {
  id: string
  name: string
  companyName?: string | null
  email?: string | null
  phone?: string | null
  addresses?: ClientPickerAddress[]
  contacts?: ClientPickerContact[]
}

export function pickDefaultClientAddress(addresses: ClientPickerAddress[] | undefined, addressId?: string) {
  if (!Array.isArray(addresses) || addresses.length === 0) return null
  if (addressId) {
    const match = addresses.find((address) => address.id === addressId)
    if (match) return match
  }
  const billingDefault = addresses.find((address) => address.type === 'billing' && address.isDefault)
  if (billingDefault) return billingDefault
  const billingAny = addresses.find((address) => address.type === 'billing')
  if (billingAny) return billingAny
  const anyDefault = addresses.find((address) => address.isDefault)
  if (anyDefault) return anyDefault
  return addresses[0]
}

export function formatClientAddressString(address: ClientPickerAddress | null | undefined): string {
  if (!address?.street) return ''
  return `${address.street}, ${address.city || ''}, ${address.state || ''} ${address.zipCode || ''}`
    .replace(/\s+,/g, ',')
    .trim()
}

export async function fetchClientPickerDetail(clientId: string): Promise<ClientPickerDetail | null> {
  let token = localStorage.getItem('accessToken')
  let response = await fetch(`/api/clients/${clientId}/picker`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (response.status === 401) {
    const refreshed = await refreshAccessToken()
    if (!refreshed) return null
    token = localStorage.getItem('accessToken')
    response = await fetch(`/api/clients/${clientId}/picker`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  if (!response.ok) return null
  const data = await response.json().catch(() => null)
  return (data?.client as ClientPickerDetail) || null
}

export async function fetchClientDefaultAddressString(clientId: string): Promise<string> {
  const client = await fetchClientPickerDetail(clientId)
  if (!client) return ''
  return formatClientAddressString(pickDefaultClientAddress(client.addresses))
}
