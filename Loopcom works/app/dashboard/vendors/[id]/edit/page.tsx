'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save, Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'

interface VendorContact {
  id?: string
  name: string
  title: string
  email: string
  phone: string
  isPrimary: boolean
  notes: string
}

export default function EditVendorPage() {
  const router = useRouter()
  const params = useParams()
  const vendorId = params?.id as string | undefined

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sameAsBilling, setSameAsBilling] = useState(false)
  const [showTaxId, setShowTaxId] = useState(false)
  const [contacts, setContacts] = useState<VendorContact[]>([])
  const [formData, setFormData] = useState({
    name: '',
    vendorCode: '',
    status: 'ACTIVE',
    email: '',
    phone: '',
    website: '',
    notes: '',
    billingStreet: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
    billingCountry: 'USA',
    shippingStreet: '',
    shippingCity: '',
    shippingState: '',
    shippingZip: '',
    shippingCountry: 'USA',
    paymentTerms: 'NET_30',
    customTermsText: '',
    taxId: '',
    defaultCurrency: 'USD',
  })

  useEffect(() => {
    if (vendorId) {
      fetchVendor()
    }
  }, [vendorId])

  useEffect(() => {
    if (sameAsBilling) {
      setFormData(prev => ({
        ...prev,
        shippingStreet: prev.billingStreet,
        shippingCity: prev.billingCity,
        shippingState: prev.billingState,
        shippingZip: prev.billingZip,
        shippingCountry: prev.billingCountry,
      }))
    }
  }, [sameAsBilling, formData.billingStreet, formData.billingCity, formData.billingState, formData.billingZip, formData.billingCountry])

  const fetchVendor = async () => {
    if (!vendorId) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/vendors/${vendorId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to load vendor')
        router.push('/dashboard/vendors')
        return
      }

      const data = await response.json()
      const vendor = data.vendor

      setFormData({
        name: vendor.name || '',
        vendorCode: vendor.vendorCode || '',
        status: vendor.status || 'ACTIVE',
        email: vendor.email || '',
        phone: vendor.phone || '',
        website: vendor.website || '',
        notes: vendor.notes || '',
        billingStreet: vendor.billingStreet || vendor.address || '',
        billingCity: vendor.billingCity || vendor.city || '',
        billingState: vendor.billingState || vendor.state || '',
        billingZip: vendor.billingZip || vendor.zipCode || '',
        billingCountry: vendor.billingCountry || vendor.country || 'USA',
        shippingStreet: vendor.shippingStreet || '',
        shippingCity: vendor.shippingCity || '',
        shippingState: vendor.shippingState || '',
        shippingZip: vendor.shippingZip || '',
        shippingCountry: vendor.shippingCountry || 'USA',
        paymentTerms: vendor.paymentTerms || 'NET_30',
        customTermsText: vendor.customTermsText || '',
        taxId: vendor.taxId || '',
        defaultCurrency: vendor.defaultCurrency || 'USD',
      })

      setContacts(
        vendor.contacts?.map((c: any) => ({
          id: c.id,
          name: c.name || '',
          title: c.title || '',
          email: c.email || '',
          phone: c.phone || '',
          isPrimary: c.isPrimary || false,
          notes: c.notes || '',
        })) || []
      )

      // Check if shipping same as billing
      if (vendor.shippingStreet && vendor.shippingStreet === vendor.billingStreet) {
        setSameAsBilling(true)
      }
    } catch (error) {
      console.error('Error fetching vendor:', error)
      alert('Failed to load vendor')
    } finally {
      setLoading(false)
    }
  }

  const addContact = () => {
    setContacts([
      ...contacts,
      {
        name: '',
        title: '',
        email: '',
        phone: '',
        isPrimary: contacts.length === 0,
        notes: '',
      },
    ])
  }

  const removeContact = (index: number) => {
    const newContacts = contacts.filter((_, i) => i !== index)
    if (newContacts.length > 0 && !newContacts.some(c => c.isPrimary)) {
      newContacts[0].isPrimary = true
    }
    setContacts(newContacts)
  }

  const updateContact = (index: number, field: keyof VendorContact, value: string | boolean) => {
    const updated = [...contacts]
    updated[index] = { ...updated[index], [field]: value }
    
    if (field === 'isPrimary' && value === true) {
      updated.forEach((c, i) => {
        if (i !== index) c.isPrimary = false
      })
    }
    
    setContacts(updated)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/vendors/${vendorId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          contacts: contacts.filter(c => c.name.trim()),
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to update vendor')
        setSaving(false)
        return
      }

      const data = await response.json()
      if (!data.vendor || !data.vendor.id) {
        console.error('Invalid response data:', data)
        alert('Vendor updated but invalid response received')
        setSaving(false)
        return
      }
      router.replace(`/dashboard/vendors/${data.vendor.id}`)
    } catch (error) {
      console.error('Error updating vendor:', error)
      alert('Failed to update vendor. Check console for details.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading vendor...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref={`/dashboard/vendors/${vendorId}`} parentHref={`/dashboard/vendors/${vendorId}`} mode="parent" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Vendor</h1>
          <p className="mt-2 text-gray-600">Update vendor information</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 space-y-6">
            {/* Basic Info */}
            <Card>
              <CardHeader>
                <CardTitle>Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="name">Vendor Name *</Label>
                  <Input
                    id="name"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Vendor name"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="vendorCode">Vendor Code</Label>
                    <Input
                      id="vendorCode"
                      value={formData.vendorCode}
                      onChange={(e) => setFormData({ ...formData, vendorCode: e.target.value })}
                      placeholder="VENDOR-001"
                    />
                  </div>
                  <div>
                    <Label htmlFor="status">Status</Label>
                    <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                      <SelectTrigger id="status">
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ACTIVE">Active</SelectItem>
                        <SelectItem value="INACTIVE">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Contact Info */}
            <Card>
              <CardHeader>
                <CardTitle>Contact Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      placeholder="vendor@example.com"
                    />
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
              </CardContent>
            </Card>

            {/* Addresses */}
            <Card>
              <CardHeader>
                <CardTitle>Addresses</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h3 className="font-semibold mb-4">Billing Address</h3>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="billingStreet">Street</Label>
                      <Input
                        id="billingStreet"
                        value={formData.billingStreet}
                        onChange={(e) => setFormData({ ...formData, billingStreet: e.target.value })}
                        placeholder="123 Main St"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="billingCity">City</Label>
                        <Input
                          id="billingCity"
                          value={formData.billingCity}
                          onChange={(e) => setFormData({ ...formData, billingCity: e.target.value })}
                          placeholder="City"
                        />
                      </div>
                      <div>
                        <Label htmlFor="billingState">State</Label>
                        <Input
                          id="billingState"
                          value={formData.billingState}
                          onChange={(e) => setFormData({ ...formData, billingState: e.target.value })}
                          placeholder="State"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="billingZip">ZIP Code</Label>
                        <Input
                          id="billingZip"
                          value={formData.billingZip}
                          onChange={(e) => setFormData({ ...formData, billingZip: e.target.value })}
                          placeholder="12345"
                        />
                      </div>
                      <div>
                        <Label htmlFor="billingCountry">Country</Label>
                        <Input
                          id="billingCountry"
                          value={formData.billingCountry}
                          onChange={(e) => setFormData({ ...formData, billingCountry: e.target.value })}
                          placeholder="USA"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center space-x-2 mb-4">
                    <input
                      type="checkbox"
                      id="sameAsBilling"
                      checked={sameAsBilling}
                      onChange={(e) => setSameAsBilling(e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="sameAsBilling">Shipping address same as billing</Label>
                  </div>
                  <h3 className="font-semibold mb-4">Shipping Address</h3>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="shippingStreet">Street</Label>
                      <Input
                        id="shippingStreet"
                        value={formData.shippingStreet}
                        onChange={(e) => setFormData({ ...formData, shippingStreet: e.target.value })}
                        placeholder="123 Main St"
                        disabled={sameAsBilling}
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="shippingCity">City</Label>
                        <Input
                          id="shippingCity"
                          value={formData.shippingCity}
                          onChange={(e) => setFormData({ ...formData, shippingCity: e.target.value })}
                          placeholder="City"
                          disabled={sameAsBilling}
                        />
                      </div>
                      <div>
                        <Label htmlFor="shippingState">State</Label>
                        <Input
                          id="shippingState"
                          value={formData.shippingState}
                          onChange={(e) => setFormData({ ...formData, shippingState: e.target.value })}
                          placeholder="State"
                          disabled={sameAsBilling}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="shippingZip">ZIP Code</Label>
                        <Input
                          id="shippingZip"
                          value={formData.shippingZip}
                          onChange={(e) => setFormData({ ...formData, shippingZip: e.target.value })}
                          placeholder="12345"
                          disabled={sameAsBilling}
                        />
                      </div>
                      <div>
                        <Label htmlFor="shippingCountry">Country</Label>
                        <Input
                          id="shippingCountry"
                          value={formData.shippingCountry}
                          onChange={(e) => setFormData({ ...formData, shippingCountry: e.target.value })}
                          placeholder="USA"
                          disabled={sameAsBilling}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Terms & Tax */}
            <Card>
              <CardHeader>
                <CardTitle>Terms & Tax</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="paymentTerms">Payment Terms</Label>
                  <Select value={formData.paymentTerms} onValueChange={(value) => setFormData({ ...formData, paymentTerms: value })}>
                    <SelectTrigger id="paymentTerms">
                      <SelectValue placeholder="Select terms" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NET_15">Net 15</SelectItem>
                      <SelectItem value="NET_30">Net 30</SelectItem>
                      <SelectItem value="NET_45">Net 45</SelectItem>
                      <SelectItem value="DUE_ON_RECEIPT">Due on Receipt</SelectItem>
                      <SelectItem value="CUSTOM">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.paymentTerms === 'CUSTOM' && (
                  <div>
                    <Label htmlFor="customTermsText">Custom Terms</Label>
                    <textarea
                      id="customTermsText"
                      value={formData.customTermsText}
                      onChange={(e) => setFormData({ ...formData, customTermsText: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                      rows={3}
                      placeholder="Enter custom payment terms"
                    />
                  </div>
                )}
                <div>
                  <Label htmlFor="taxId">Tax ID / EIN</Label>
                  <div className="flex items-center space-x-2">
                    <Input
                      id="taxId"
                      type={showTaxId ? 'text' : 'password'}
                      value={formData.taxId}
                      onChange={(e) => setFormData({ ...formData, taxId: e.target.value })}
                      placeholder="12-3456789"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowTaxId(!showTaxId)}
                    >
                      {showTaxId ? 'Hide' : 'Show'}
                    </Button>
                  </div>
                </div>
                <div>
                  <Label htmlFor="defaultCurrency">Default Currency</Label>
                  <Input
                    id="defaultCurrency"
                    value={formData.defaultCurrency}
                    onChange={(e) => setFormData({ ...formData, defaultCurrency: e.target.value })}
                    placeholder="USD"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Vendor Contacts */}
            <Card>
              <CardHeader>
                <CardTitle>Vendor Contacts</CardTitle>
                <CardDescription>Add contacts for this vendor</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button type="button" variant="outline" onClick={addContact}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Contact
                </Button>

                {contacts.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No contacts added yet
                  </div>
                ) : (
                  <div className="space-y-4">
                    {contacts.map((contact, index) => (
                      <div key={index} className="border rounded-lg p-4">
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center space-x-2">
                            <input
                              type="checkbox"
                              checked={contact.isPrimary}
                              onChange={(e) => updateContact(index, 'isPrimary', e.target.checked)}
                              className="rounded"
                            />
                            <Label>Primary Contact</Label>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeContact(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <Label>Name *</Label>
                            <Input
                              value={contact.name}
                              onChange={(e) => updateContact(index, 'name', e.target.value)}
                              placeholder="Contact name"
                              required
                            />
                          </div>
                          <div>
                            <Label>Title / Role</Label>
                            <Input
                              value={contact.title}
                              onChange={(e) => updateContact(index, 'title', e.target.value)}
                              placeholder="e.g., Sales Manager"
                            />
                          </div>
                          <div>
                            <Label>Email</Label>
                            <Input
                              type="email"
                              value={contact.email}
                              onChange={(e) => updateContact(index, 'email', e.target.value)}
                              placeholder="contact@vendor.com"
                            />
                          </div>
                          <div>
                            <Label>Phone</Label>
                            <Input
                              type="tel"
                              value={contact.phone}
                              onChange={(e) => updateContact(index, 'phone', e.target.value)}
                              placeholder="(555) 123-4567"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Notes */}
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                  rows={4}
                  placeholder="Internal notes about this vendor"
                />
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <div className="flex flex-col space-y-2">
              <Button type="submit" disabled={saving} className="w-full">
                <Save className="mr-2 h-4 w-4" />
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()} className="w-full">
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}
