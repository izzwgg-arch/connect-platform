'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Save, AlertCircle, Plus, Trash2, Pencil, X, Check } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import { PlaceAutocompleteInput } from '@/components/maps/PlaceAutocompleteInput'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'

type AddressForm = {
  street: string
  city: string
  state: string
  zipCode: string
  country: string
}

type Contact = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  mobile: string | null
  title: string | null
  isPrimary: boolean
}

type ContactFormState = {
  firstName: string
  lastName: string
  email: string
  phone: string
  mobile: string
  title: string
  isPrimary: boolean
}

const EMPTY_CONTACT_FORM: ContactFormState = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  mobile: '',
  title: '',
  isPrimary: false,
}

type ClientResponse = {
  client: {
    id: string
    parentId: string | null
    name: string
    companyName: string | null
    email: string | null
    phone: string | null
    website: string | null
    notes: string | null
    tags: string[]
    isActive: boolean
    addresses: Array<{
      id: string
      type: string
      street: string
      city: string
      state: string
      zipCode: string
      country: string
    }>
  }
}

export default function EditClientPage() {
  const router = useRouter()
  const params = useParams()
  const clientId = params?.id as string | undefined

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [billingPlaceId, setBillingPlaceId] = useState<string | null>(null)
  const [shippingPlaceId, setShippingPlaceId] = useState<string | null>(null)
  const [availableClients, setAvailableClients] = useState<PickerClient[]>([])
  const [isSubClient, setIsSubClient] = useState(false)
  const [selectedParentId, setSelectedParentId] = useState('')

  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(true)
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [editingContactId, setEditingContactId] = useState<string | null>(null)
  const [editContactForm, setEditContactForm] = useState<ContactFormState>(EMPTY_CONTACT_FORM)
  const [savingContactId, setSavingContactId] = useState<string | null>(null)
  const [deletingContactId, setDeletingContactId] = useState<string | null>(null)
  const [showAddContact, setShowAddContact] = useState(false)
  const [newContactForm, setNewContactForm] = useState<ContactFormState>(EMPTY_CONTACT_FORM)
  const [addingContact, setAddingContact] = useState(false)

  const [formData, setFormData] = useState({
    name: '',
    companyName: '',
    email: '',
    phone: '',
    website: '',
    notes: '',
    tags: '',
    isActive: true,
    billingAddress: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'US',
    } as AddressForm,
    shippingAddress: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'US',
    } as AddressForm,
  })

  const normalizedClientId = useMemo(() => {
    if (!clientId || typeof clientId !== 'string') return null
    return clientId
  }, [clientId])

  useEffect(() => {
    if (!normalizedClientId) {
      setError('Invalid client ID')
      setLoading(false)
      return
    }

    const fetchClient = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        if (!token) {
          router.push('/auth/login')
          return
        }

        const [res, availableClients] = await Promise.all([
          fetch(`/api/clients/${normalizedClientId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetchAllPickerClients(),
        ])

        if (res.status === 401) {
          router.push('/auth/login')
          return
        }

        if (res.status === 404) {
          setError('Client not found')
          return
        }

        if (!res.ok) {
          const text = await res.text()
          setError(text || 'Failed to load client')
          return
        }

        const data = (await res.json()) as ClientResponse
        const client = data.client
        const addresses = Array.isArray(client.addresses) ? client.addresses : []
        const billing = addresses.find((a) => a.type === 'billing')
        const shipping = addresses.find((a) => a.type === 'shipping')

        setFormData({
          name: client.name || '',
          companyName: client.companyName || '',
          email: client.email || '',
          phone: client.phone || '',
          website: client.website || '',
          notes: client.notes || '',
          tags: Array.isArray(client.tags) ? client.tags.join(', ') : '',
          isActive: !!client.isActive,
          billingAddress: {
            street: billing?.street || '',
            city: billing?.city || '',
            state: billing?.state || '',
            zipCode: billing?.zipCode || '',
            country: billing?.country || 'US',
          },
          shippingAddress: {
            street: shipping?.street || '',
            city: shipping?.city || '',
            state: shipping?.state || '',
            zipCode: shipping?.zipCode || '',
            country: shipping?.country || 'US',
          },
        })
        setAvailableClients(
          availableClients.filter((item) => item.id !== normalizedClientId)
        )
        setIsSubClient(Boolean(client.parentId))
        setSelectedParentId(client.parentId || '')
        setBillingPlaceId(billing?.street ? 'existing' : null)
        setShippingPlaceId(shipping?.street ? 'existing' : null)
        setError(null)
      } catch (e) {
        console.error('Error loading client:', e)
        setError('Failed to load client')
      } finally {
        setLoading(false)
      }
    }

    fetchClient()
  }, [normalizedClientId, router])

  const fetchContacts = async () => {
    if (!normalizedClientId) return
    setContactsLoading(true)
    setContactsError(null)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const res = await fetch(`/api/clients/${normalizedClientId}/contacts`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!res.ok) {
        setContactsError('Failed to load contacts')
        return
      }
      const data = await res.json()
      setContacts(Array.isArray(data.contacts) ? data.contacts : [])
    } catch (e) {
      console.error('Error loading contacts:', e)
      setContactsError('Failed to load contacts')
    } finally {
      setContactsLoading(false)
    }
  }

  useEffect(() => {
    if (!normalizedClientId) return
    fetchContacts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedClientId])

  const startEditContact = (contact: Contact) => {
    setEditingContactId(contact.id)
    setEditContactForm({
      firstName: contact.firstName || '',
      lastName: contact.lastName || '',
      email: contact.email || '',
      phone: contact.phone || '',
      mobile: contact.mobile || '',
      title: contact.title || '',
      isPrimary: Boolean(contact.isPrimary),
    })
  }

  const cancelEditContact = () => {
    setEditingContactId(null)
    setEditContactForm(EMPTY_CONTACT_FORM)
  }

  const saveEditContact = async () => {
    if (!normalizedClientId || !editingContactId) return
    if (!editContactForm.firstName.trim() || !editContactForm.lastName.trim()) {
      alert('First and last name are required')
      return
    }
    setSavingContactId(editingContactId)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const res = await fetch(`/api/clients/${normalizedClientId}/contacts/${editingContactId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          firstName: editContactForm.firstName.trim(),
          lastName: editContactForm.lastName.trim(),
          email: editContactForm.email.trim() || null,
          phone: editContactForm.phone.trim() || null,
          mobile: editContactForm.mobile.trim() || null,
          title: editContactForm.title.trim() || null,
          isPrimary: editContactForm.isPrimary,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to update contact')
        return
      }
      cancelEditContact()
      await fetchContacts()
    } catch (e) {
      console.error('Error updating contact:', e)
      alert('Failed to update contact')
    } finally {
      setSavingContactId(null)
    }
  }

  const deleteContact = async (contact: Contact) => {
    if (!normalizedClientId) return
    if (!confirm(`Delete contact "${contact.firstName} ${contact.lastName}"?`)) return
    setDeletingContactId(contact.id)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const res = await fetch(`/api/clients/${normalizedClientId}/contacts/${contact.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to delete contact')
        return
      }
      if (editingContactId === contact.id) cancelEditContact()
      await fetchContacts()
    } catch (e) {
      console.error('Error deleting contact:', e)
      alert('Failed to delete contact')
    } finally {
      setDeletingContactId(null)
    }
  }

  const addContact = async () => {
    if (!normalizedClientId) return
    if (!newContactForm.firstName.trim() || !newContactForm.lastName.trim()) {
      alert('First and last name are required')
      return
    }
    setAddingContact(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }
      const res = await fetch(`/api/clients/${normalizedClientId}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          firstName: newContactForm.firstName.trim(),
          lastName: newContactForm.lastName.trim(),
          email: newContactForm.email.trim() || null,
          phone: newContactForm.phone.trim() || null,
          mobile: newContactForm.mobile.trim() || null,
          title: newContactForm.title.trim() || null,
          isPrimary: newContactForm.isPrimary,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to add contact')
        return
      }
      setNewContactForm(EMPTY_CONTACT_FORM)
      setShowAddContact(false)
      await fetchContacts()
    } catch (e) {
      console.error('Error adding contact:', e)
      alert('Failed to add contact')
    } finally {
      setAddingContact(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!normalizedClientId) return
    if (!formData.name.trim()) {
      alert('Name is required')
      return
    }
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

    setSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const payload = {
        name: formData.name,
        companyName: formData.companyName || null,
        email: formData.email || null,
        phone: formData.phone || null,
        website: formData.website && formData.website.trim() ? formData.website.trim() : null,
        notes: formData.notes || null,
        tags: formData.tags
          ? formData.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        isActive: formData.isActive,
        parentId: isSubClient ? selectedParentId : null,
        billingAddress: formData.billingAddress.street ? formData.billingAddress : null,
        shippingAddress: isSubClient ? null : (formData.shippingAddress.street ? formData.shippingAddress : null),
      }

      const res = await fetch(`/api/clients/${normalizedClientId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })

      if (res.status === 401) {
        router.push('/auth/login')
        return
      }

      if (res.status === 404) {
        setError('Client not found')
        return
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to update client' }))
        alert(data.error || 'Failed to update client')
        return
      }

      alert('Client updated')
      router.replace(`/dashboard/clients/${normalizedClientId}`)
    } catch (e) {
      console.error('Error updating client:', e)
      alert('Failed to update client')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading client...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
          <h2 className="mt-4 text-xl font-semibold text-gray-900">Client Not Found</h2>
          <p className="mt-2 text-gray-600">{error}</p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <Button onClick={() => router.push('/dashboard/clients')}>Back to Clients</Button>
            {normalizedClientId && (
              <Button variant="outline" onClick={() => router.replace(`/dashboard/clients/${normalizedClientId}`)}>
                Back to Client
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref={`/dashboard/clients/${normalizedClientId}`} parentHref={`/dashboard/clients/${normalizedClientId}`} mode="parent" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Client</h1>
          <p className="mt-2 text-gray-600">Update this client’s information</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Client Information</CardTitle>
            <CardDescription>Edit the client’s basic information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border p-4 space-y-3">
              <label className="flex items-center justify-between gap-3 text-sm font-medium">
                <span>This client is a sub-client</span>
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
              <Label htmlFor="website">Website (Optional)</Label>
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
              <Label htmlFor="status">Status</Label>
              <Select
                value={formData.isActive ? 'active' : 'inactive'}
                onValueChange={(value) => setFormData({ ...formData, isActive: value === 'active' })}
              >
                <SelectTrigger id="status">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
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

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Contacts</CardTitle>
                <CardDescription>
                  Additional people at this client (used when choosing recipients for estimates/invoices)
                </CardDescription>
              </div>
              {!showAddContact && (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAddContact(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Contact
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {contactsLoading && <p className="text-sm text-gray-500">Loading contacts...</p>}
            {contactsError && <p className="text-sm text-red-600">{contactsError}</p>}

            {!contactsLoading && !contactsError && contacts.length === 0 && !showAddContact && (
              <p className="text-sm text-gray-500">No additional contacts yet.</p>
            )}

            <div className="space-y-3">
              {contacts.map((contact) => {
                const isEditing = editingContactId === contact.id
                if (isEditing) {
                  return (
                    <div key={contact.id} className="rounded-md border p-3 space-y-3 bg-gray-50">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                          <Label htmlFor={`edit-firstName-${contact.id}`}>First Name *</Label>
                          <Input
                            id={`edit-firstName-${contact.id}`}
                            value={editContactForm.firstName}
                            onChange={(e) => setEditContactForm({ ...editContactForm, firstName: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`edit-lastName-${contact.id}`}>Last Name *</Label>
                          <Input
                            id={`edit-lastName-${contact.id}`}
                            value={editContactForm.lastName}
                            onChange={(e) => setEditContactForm({ ...editContactForm, lastName: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`edit-email-${contact.id}`}>Email</Label>
                          <Input
                            id={`edit-email-${contact.id}`}
                            type="email"
                            value={editContactForm.email}
                            onChange={(e) => setEditContactForm({ ...editContactForm, email: e.target.value })}
                            placeholder="name@example.com"
                          />
                        </div>
                        <div>
                          <Label htmlFor={`edit-title-${contact.id}`}>Title</Label>
                          <Input
                            id={`edit-title-${contact.id}`}
                            value={editContactForm.title}
                            onChange={(e) => setEditContactForm({ ...editContactForm, title: e.target.value })}
                            placeholder="Office Manager"
                          />
                        </div>
                        <div>
                          <Label htmlFor={`edit-phone-${contact.id}`}>Phone</Label>
                          <Input
                            id={`edit-phone-${contact.id}`}
                            type="tel"
                            value={editContactForm.phone}
                            onChange={(e) => setEditContactForm({ ...editContactForm, phone: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`edit-mobile-${contact.id}`}>Mobile</Label>
                          <Input
                            id={`edit-mobile-${contact.id}`}
                            type="tel"
                            value={editContactForm.mobile}
                            onChange={(e) => setEditContactForm({ ...editContactForm, mobile: e.target.value })}
                          />
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={editContactForm.isPrimary}
                          onCheckedChange={(checked) =>
                            setEditContactForm({ ...editContactForm, isPrimary: Boolean(checked) })
                          }
                        />
                        Primary contact
                      </label>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={cancelEditContact}
                          disabled={savingContactId === contact.id}
                        >
                          <X className="mr-2 h-4 w-4" />
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={saveEditContact}
                          disabled={savingContactId === contact.id}
                        >
                          <Check className="mr-2 h-4 w-4" />
                          {savingContactId === contact.id ? 'Saving...' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  )
                }

                return (
                  <div
                    key={contact.id}
                    className="flex items-start justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900">
                          {contact.firstName} {contact.lastName}
                        </span>
                        {contact.isPrimary && (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-700">
                            Primary
                          </span>
                        )}
                        {contact.title && <span className="text-sm text-gray-500">{contact.title}</span>}
                      </div>
                      <div className="mt-1 space-y-0.5 text-sm text-gray-600">
                        {contact.email && <p>{contact.email}</p>}
                        {contact.phone && <p>Phone: {contact.phone}</p>}
                        {contact.mobile && <p>Mobile: {contact.mobile}</p>}
                        {!contact.email && !contact.phone && !contact.mobile && (
                          <p className="text-gray-400">No contact details on file</p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditContact(contact)}
                        title="Edit contact"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteContact(contact)}
                        disabled={deletingContactId === contact.id}
                        title="Delete contact"
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>

            {showAddContact && (
              <div className="rounded-md border p-3 space-y-3 bg-gray-50">
                <p className="text-sm font-medium text-gray-700">New Contact</p>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <Label htmlFor="new-firstName">First Name *</Label>
                    <Input
                      id="new-firstName"
                      value={newContactForm.firstName}
                      onChange={(e) => setNewContactForm({ ...newContactForm, firstName: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-lastName">Last Name *</Label>
                    <Input
                      id="new-lastName"
                      value={newContactForm.lastName}
                      onChange={(e) => setNewContactForm({ ...newContactForm, lastName: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-email">Email</Label>
                    <Input
                      id="new-email"
                      type="email"
                      value={newContactForm.email}
                      onChange={(e) => setNewContactForm({ ...newContactForm, email: e.target.value })}
                      placeholder="name@example.com"
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-title">Title</Label>
                    <Input
                      id="new-title"
                      value={newContactForm.title}
                      onChange={(e) => setNewContactForm({ ...newContactForm, title: e.target.value })}
                      placeholder="Office Manager"
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-phone">Phone</Label>
                    <Input
                      id="new-phone"
                      type="tel"
                      value={newContactForm.phone}
                      onChange={(e) => setNewContactForm({ ...newContactForm, phone: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-mobile">Mobile</Label>
                    <Input
                      id="new-mobile"
                      type="tel"
                      value={newContactForm.mobile}
                      onChange={(e) => setNewContactForm({ ...newContactForm, mobile: e.target.value })}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={newContactForm.isPrimary}
                    onCheckedChange={(checked) => setNewContactForm({ ...newContactForm, isPrimary: Boolean(checked) })}
                  />
                  Primary contact
                </label>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setShowAddContact(false)
                      setNewContactForm(EMPTY_CONTACT_FORM)
                    }}
                    disabled={addingContact}
                  >
                    Cancel
                  </Button>
                  <Button type="button" size="sm" onClick={addContact} disabled={addingContact}>
                    <Plus className="mr-2 h-4 w-4" />
                    {addingContact ? 'Adding...' : 'Add Contact'}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

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
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      billingAddress: { ...formData.billingAddress, country: e.target.value },
                    })
                  }
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
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      shippingAddress: { ...formData.shippingAddress, country: e.target.value },
                    })
                  }
                  placeholder="US"
                />
              </div>
            </div>
          </CardContent>
        </Card>
        )}

        <div className="flex justify-end space-x-4">
          <Button type="button" variant="outline" onClick={() => router.back()} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </div>
  )
}

