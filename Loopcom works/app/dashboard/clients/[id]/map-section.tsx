'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const AddressMap = dynamic(() => import('@/components/maps/AddressMap').then(mod => ({ default: mod.AddressMap })), {
  ssr: false,
  loading: () => <div className="p-4 bg-gray-50 rounded-lg text-center text-gray-600">Loading map...</div>
})

interface Address {
  id: string
  type: string
  street: string
  city: string
  state: string
  zipCode: string
  country: string
}

interface AddressMapSectionProps {
  addresses: Address[]
}

export function AddressMapSection({ addresses }: AddressMapSectionProps) {
  // Defensive: Ensure addresses is an array
  const safeAddresses = (addresses && Array.isArray(addresses)) ? addresses : []
  const [selectedAddress, setSelectedAddress] = useState<Address | null>(safeAddresses[0] || null)

  if (!safeAddresses.length) {
    return (
      <div className="p-4 bg-gray-50 rounded-lg text-center text-gray-600">
        No addresses available to display on map
      </div>
    )
  }

  return (
    <GoogleMapsLoader>
      <div className="space-y-4">
        {safeAddresses.length > 1 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Address
            </label>
            <Select
              value={selectedAddress?.id || ''}
              onValueChange={(value) => {
                const addr = safeAddresses.find((a) => a.id === value)
                setSelectedAddress(addr || null)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select address" />
              </SelectTrigger>
              <SelectContent>
                {safeAddresses.map((addr) => (
                  <SelectItem key={addr.id} value={addr.id}>
                    {addr.type} - {addr.street}, {addr.city}, {addr.state}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {selectedAddress && <AddressMap address={selectedAddress} />}
      </div>
    </GoogleMapsLoader>
  )
}
