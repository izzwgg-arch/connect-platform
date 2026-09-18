'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Save } from 'lucide-react'
import Link from 'next/link'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import { PlaceAutocompleteInput } from '@/components/maps/PlaceAutocompleteInput'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { collectClientEmailsOnFile, collectClientPhonesOnFile } from '@/lib/clients/contact-on-file'

export default function NewClientPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const parentId = searchParams.get('parentId')
  const [loading, setLoading] = useState(false)
  const [availableClients, setAvailableClients] = useState<PickerClient[]>([])
  const [isSubClient, setIsSubClient] = useState(Boolean(parentId))
  const [selectedParentId, setSelectedParentId] = useState(parentId || '')
  const [parentClientName, setParentClientName] = useState<string>('')
  const [billingPlaceId, setBillingPlaceId] = useState<string | null>(null)
  const [shippingPlaceId, setShippingPlaceId] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    companyName: '',
    email: '',
    phone: '',
    website: '',
    notes: '',
    tags: '',
    billingAddress: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'US',
    },
    shippingAddress: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'US',
    },
  })

  useEffect(() => {
    const fetchClients = async () => {
      try {
        setAvailableClients(await fetchAllPickerClients())
      } catch (error) {
        console.error('Error loading client list for sub-client selector:', error)
      }
    }

    fetchClients()
  }, [])

  useEffect(() => {
    setIsSubClient(Boolean(parentId))
    setSelectedParentId(parentId || '')
  }, [parentId])

  useEffect(() => {
    if (!selectedParentId) {
      setParentClientName('')
      return
    }

    const fetchParentClient = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        if (!token) return

        const response = await fetch(`/api/clients/${selectedParentId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

        if (!response.ok) return
        const data = await response.json()
        const parent = data.client
        setParentClientName(parent?.name || '')

        const parentEmails = collectClientEmailsOnFile(parent)
        const parentPhones = collectClientPhonesOnFile(parent)

        const parentBilling = (parent?.addresses || []).find((addr: any) => addr.type === 'billing')
        setFormData((prev) => ({
          ...prev,
          email: parentEmails,
          phone: parentPhones,
          billingAddress: prev.billingAddress.street
            ? prev.billingAddress
            : parentBilling
              ? {
                  street: parentBilling.street || '',
                  city: parentBilling.city || '',
                  state: parentBilling.state || '',
                  zipCode: parentBilling.zipCode || '',
                  country: parentBilling.country || 'US',
                }
              : prev.billingAddress,
        }))

        if (parentBilling?.street) {
          setBillingPlaceId('existing')
        }
      } catch (error) {
        console.error('Error loading parent client for sub-client defaults:', error)
      }
    }

    fetchParentClient()
  }, [selectedParentId])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (formData.billingAddress.street.trim() && !billingPlaceId) {
      alert('Please select a real billing address from the suggestions.')
      return
    }
    if (isSubClient && !selectedParentId) {
      alert('Please select a parent client.')
      return
    }
    if (!isSubClient && formData.shippingAddress.street.trim() && !shippingPlaceId) {
      alert('Please select a real shipping address from the suggestions.')
      return
    }
    setLoading(true)

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: formData.name,
          parentId: isSubClient ? selectedParentId : null,
          companyName: formData.companyName || null,
          email: formData.email || null,
          phone: formData.phone || null,
          website: formData.website && formData.website.trim() ? formData.website.trim() : null,
          notes: formData.notes || null,
          tags: formData.tags ? formData.tags.split(',').map(t => t.trim()).filter(t => t) : [],
          billingAddress: formData.billingAddress.street ? formData.billingAddress : null,
          shippingAddress: isSubClient ? null : (formData.shippingAddress.street ? formData.shippingAddress : null),
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to create client')
        return
      }

      const data = await response.json()
      if (!data.client || !data.client.id) {
        console.error('Invalid response data:', data)
        alert('Client created but invalid response received')
        return
      }
      router.push(`/dashboard/clients/${data.client.id}`)
    } catch (error) {
      console.error('Error creating client:', error)
      alert('Failed to create client')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref="/dashboard/clients" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{isSubClient ? 'New Sub-Client' : 'New Client'}</h1>
          <p className="mt-2 text-gray-600">
            {isSubClient
              ? `Create a sub-client under ${parentClientName || 'the selected parent client'}.`
              : 'Create a new client record'}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Client Information</CardTitle>
            <CardDescription>Enter the client&apos;s basic information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border p-4 space-y-3">
              <label className="flex items-center justify-between gap-3 text-sm font-medium">
                <span>Make this a sub-client</span>
                <input
                  type="checkbox"
                  checked={isSubClient}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setIsSubClient(checked)
                    if (!checked) setSelectedParentId('')
                  }}
                />
              </label>
              {isSubClient && (
                <div className="space-y-2">
                  <Label>Parent Client</Label>
                  <SearchableClientSelect
                    clients={availableClients}
                    value={selectedParentId}
                    onSelect={setSelectedParentId}
                    placeholder="Select a parent client..."
                  />
                  <p className="text-xs text-gray-500">
                    Billing address, email, and phone can be inherited from the selected parent.
                  </p>
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="John Doe"
              />
            </div>

            <div>
              <Label htmlFor="companyName">Company Name</Label>
              <Input
                id="companyName"
                value={formData.companyName}
                onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
                placeholder="Acme Corp"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="text"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@example.com, billing@example.com"
                />
                <p className="mt-1 text-xs text-gray-500">You can enter multiple emails separated by commas.</p>
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="(555) 123-4567"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                type="url"
                value={formData.website}
                onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                placeholder="https://example.com"
              />
            </div>

            <div>
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input
                id="tags"
                value={formData.tags}
                onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                placeholder="VIP, Commercial, Residential"
              />
            </div>

            <div>
              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                rows={4}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Additional notes about this client..."
              />
            </div>
          </CardContent>
        </Card>

        {/* Billing Address */}
        <Card>
          <CardHeader>
            <CardTitle>Billing Address</CardTitle>
            <CardDescription>Primary address for billing</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="billingStreet">Street Address</Label>
              <GoogleMapsLoader>
                <PlaceAutocompleteInput
                  inputId="billingStreet"
                  value={formData.billingAddress.street}
                  onChangeText={(text) => {
                    setBillingPlaceId(null)
                    setFormData((prev) => ({
                      ...prev,
                      billingAddress: { ...prev.billingAddress, street: text, city: '', state: '', zipCode: '' },
                    }))
                  }}
                  onAddressSelected={({ placeId, address }) => {
                    setBillingPlaceId(placeId)
                    setFormData((prev) => ({
                      ...prev,
                      billingAddress: {
                        ...prev.billingAddress,
                        street: address.street || prev.billingAddress.street,
                        city: address.city || '',
                        state: address.state || '',
                        zipCode: address.zipCode || '',
                        country: 'US',
                      },
                    }))
                  }}
                  placeholder="Start typing an address (required to select from list)"
                />
              </GoogleMapsLoader>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="billingCity">City</Label>
                <Input
                  id="billingCity"
                  value={formData.billingAddress.city}
                  readOnly
                  disabled
                  placeholder="City"
                />
              </div>
              <div>
                <Label htmlFor="billingState">State</Label>
                <Input
                  id="billingState"
                  value={formData.billingAddress.state}
                  readOnly
                  disabled
                  placeholder="State"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="billingZip">Zip Code</Label>
                <Input
                  id="billingZip"
                  value={formData.billingAddress.zipCode}
                  readOnly
                  disabled
                  placeholder="12345"
                />
              </div>
              <div>
                <Label htmlFor="billingCountry">Country</Label>
                <Input
                  id="billingCountry"
                  value={formData.billingAddress.country}
                  onChange={(e) => setFormData({
                    ...formData,
                    billingAddress: { ...formData.billingAddress, country: e.target.value }
                  })}
                  placeholder="US"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {!isSubClient && (
          <Card>
            <CardHeader>
              <CardTitle>Shipping Address (Optional)</CardTitle>
              <CardDescription>Different address for shipping if needed</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="shippingStreet">Street Address</Label>
                <GoogleMapsLoader>
                  <PlaceAutocompleteInput
                    inputId="shippingStreet"
                    value={formData.shippingAddress.street}
                    onChangeText={(text) => {
                      setShippingPlaceId(null)
                      setFormData((prev) => ({
                        ...prev,
                        shippingAddress: { ...prev.shippingAddress, street: text, city: '', state: '', zipCode: '' },
                      }))
                    }}
                    onAddressSelected={({ placeId, address }) => {
                      setShippingPlaceId(placeId)
                      setFormData((prev) => ({
                        ...prev,
                        shippingAddress: {
                          ...prev.shippingAddress,
                          street: address.street || prev.shippingAddress.street,
                          city: address.city || '',
                          state: address.state || '',
                          zipCode: address.zipCode || '',
                          country: 'US',
                        },
                      }))
                    }}
                    placeholder="Start typing an address (required to select from list)"
                  />
                </GoogleMapsLoader>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="shippingCity">City</Label>
                  <Input
                    id="shippingCity"
                    value={formData.shippingAddress.city}
                    readOnly
                    disabled
                    placeholder="City"
                  />
                </div>
                <div>
                  <Label htmlFor="shippingState">State</Label>
                  <Input
                    id="shippingState"
                    value={formData.shippingAddress.state}
                    readOnly
                    disabled
                    placeholder="State"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="shippingZip">Zip Code</Label>
                  <Input
                    id="shippingZip"
                    value={formData.shippingAddress.zipCode}
                    readOnly
                    disabled
                    placeholder="12345"
                  />
                </div>
                <div>
                  <Label htmlFor="shippingCountry">Country</Label>
                  <Input
                    id="shippingCountry"
                    value={formData.shippingAddress.country}
                    onChange={(e) => setFormData({
                      ...formData,
                      shippingAddress: { ...formData.shippingAddress, country: e.target.value }
                    })}
                    placeholder="US"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex justify-end space-x-4">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            <Save className="mr-2 h-4 w-4" />
            {loading ? 'Creating...' : 'Create Client'}
          </Button>
        </div>
      </form>
    </div>
  )
}
