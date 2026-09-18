'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Save, AlertCircle, Copy, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { parseAddressParts } from '@/lib/address/parse'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import { PlaceAutocompleteInput } from '@/components/maps/PlaceAutocompleteInput'
import { DocumentAttachments } from '@/components/common/document-attachments'
import { JobTypeSelect } from '@/components/jobs/JobTypeSelect'

type RequestResponse = {
  lead: {
    id: string
    firstName: string
    lastName: string
    email: string | null
    phone: string | null
    company: string | null
    source: string
    status: string
    jobType?: string
    value: string | null
    probability: number
    notes: string | null
    jobSiteAddress: string | null
    jobSiteCity?: string | null
    jobSiteState?: string | null
    jobSiteZipCode?: string | null
    convertedToClientId: string | null
    assignedToId: string | null
  }
}

export default function EditRequestPage() {
  const router = useRouter()
  const params = useParams()
  const requestId = params?.id as string | undefined

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [users, setUsers] = useState<Array<{ id: string; firstName: string; lastName: string }>>([])
  const [clients, setClients] = useState<PickerClient[]>([])
  const [clientMode, setClientMode] = useState<'new' | 'existing'>('new')
  const [jobSitePlaceId, setJobSitePlaceId] = useState<string | null>(null)

  const [formData, setFormData] = useState({
    clientId: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    company: '',
    source: 'OTHER',
    status: 'NEW',
    jobType: 'CUSTOM',
    value: '',
    probability: '50',
    notes: '',
    jobSiteAddress: '',
    jobSiteCity: '',
    jobSiteState: '',
    jobSiteZipCode: '',
    assignedToId: '',
  })

  const normalizedRequestId = useMemo(() => {
    if (!requestId || typeof requestId !== 'string') return null
    return requestId
  }, [requestId])

  useEffect(() => {
    if (!normalizedRequestId) {
      setError('Invalid request ID')
      setLoading(false)
      return
    }

    fetchUsers()
    fetchClients()
    fetchRequest()
  }, [normalizedRequestId])

  const fetchUsers = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/schedules/team', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setUsers(data.teamMembers || [])
      }
    } catch (error) {
      console.error('Error fetching users:', error)
    }
  }

  const fetchClients = async () => {
    try {
      setClients(await fetchAllPickerClients())
    } catch (error) {
      console.error('Error fetching clients:', error)
    }
  }

  const fetchRequest = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const res = await fetch(`/api/leads/${normalizedRequestId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (res.status === 401) {
        router.push('/auth/login')
        return
      }

      if (res.status === 404) {
        setError('Request not found')
        return
      }

      if (!res.ok) {
        const text = await res.text()
        setError(text || 'Failed to load request')
        return
      }

      const data = (await res.json()) as RequestResponse
      const request = data.lead

      setFormData({
        clientId: request.convertedToClientId || '',
        firstName: request.firstName || '',
        lastName: request.lastName || '',
        email: request.email || '',
        phone: request.phone || '',
        company: request.company || '',
        source: request.source || 'OTHER',
        status: request.status || 'NEW',
        jobType: request.jobType || 'CUSTOM',
        value: request.value ? parseFloat(request.value).toString() : '',
        probability: request.probability?.toString() || '50',
        notes: request.notes || '',
        jobSiteAddress: request.jobSiteAddress || '',
        jobSiteCity: request.jobSiteCity || parseAddressParts(request.jobSiteAddress)?.city || '',
        jobSiteState: request.jobSiteState || parseAddressParts(request.jobSiteAddress)?.state || '',
        jobSiteZipCode: request.jobSiteZipCode || parseAddressParts(request.jobSiteAddress)?.zipCode || '',
        assignedToId: request.assignedToId || '',
      })
      setClientMode(request.convertedToClientId ? 'existing' : 'new')
      setJobSitePlaceId(request.jobSiteAddress ? 'existing' : null)
      setError(null)
    } catch (e) {
      console.error('Error loading request:', e)
      setError('Failed to load request')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!normalizedRequestId) return
    if (!formData.firstName.trim() || !formData.lastName.trim()) {
      alert('First name and last name are required')
      return
    }
    if (clientMode === 'existing' && !formData.clientId) {
      alert('Please select a valid existing client from the dropdown.')
      return
    }
    if (formData.jobSiteAddress.trim() && !jobSitePlaceId) {
      alert('Please select a real job site address from the suggestions.')
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
        clientId: clientMode === 'existing' ? formData.clientId || null : null,
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        phone: formData.phone,
        company: formData.company,
        source: formData.source,
        status: formData.status,
        jobType: formData.jobType,
        value: formData.value ? parseFloat(formData.value) : null,
        probability: parseInt(formData.probability),
        notes: formData.notes,
        jobSiteAddress: formData.jobSiteAddress,
        assignedToId: formData.assignedToId || null,
      }

      const res = await fetch(`/api/leads/${normalizedRequestId}`, {
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
        setError('Request not found')
        return
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to update request' }))
        alert(data.error || 'Failed to update request')
        return
      }

      alert('Request updated')
      router.replace(`/dashboard/requests/${normalizedRequestId}`)
    } catch (e) {
      console.error('Error updating request:', e)
      alert('Failed to update request')
    } finally {
      setSaving(false)
    }
  }

  const handleDuplicate = async () => {
    if (!normalizedRequestId) return
    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/leads/${normalizedRequestId}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to duplicate request')
        return
      }

      if (data?.id) {
        router.push(`/dashboard/requests/${data.id}/edit`)
      } else {
        router.push('/dashboard/requests')
      }
    } catch (error) {
      console.error('Duplicate request error:', error)
      alert('Failed to duplicate request')
    } finally {
      setDuplicating(false)
    }
  }

  const handleDelete = async () => {
    if (!normalizedRequestId) return
    if (!confirm(`Are you sure you want to delete request "${formData.firstName} ${formData.lastName}"?`)) {
      return
    }

    setDeleting(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/leads/${normalizedRequestId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to delete request')
        return
      }
      router.push('/dashboard/requests')
    } catch (error) {
      console.error('Delete request error:', error)
      alert('Failed to delete request')
    } finally {
      setDeleting(false)
    }
  }

  const handleExistingClientSelect = (clientId: string) => {
    const selected = clients.find((client) => client.id === clientId)
    if (!selected) {
      setFormData((prev) => ({ ...prev, clientId: '' }))
      return
    }
    const nameParts = selected.name.trim().split(/\s+/)
    setFormData((prev) => ({
      ...prev,
      clientId: selected.id,
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' '),
      email: selected.email || '',
      phone: selected.phone || '',
      company: selected.companyName || '',
    }))
  }

  const syncAddressParts = (address: string) => {
    const parsed = parseAddressParts(address)
    setFormData((prev) => ({
      ...prev,
      jobSiteAddress: address,
      jobSiteCity: parsed?.city || '',
      jobSiteState: parsed?.state || '',
      jobSiteZipCode: parsed?.zipCode || '',
    }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading request...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
          <h2 className="mt-4 text-xl font-semibold text-gray-900">Request Not Found</h2>
          <p className="mt-2 text-gray-600">{error}</p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <Button onClick={() => router.push('/dashboard/requests')}>Back to Requests</Button>
            {normalizedRequestId && (
              <Button variant="outline" onClick={() => router.replace(`/dashboard/requests/${normalizedRequestId}`)}>
                Back to Request
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
        <EntityBackButton fallbackHref={`/dashboard/requests/${normalizedRequestId}`} parentHref={`/dashboard/requests/${normalizedRequestId}`} mode="parent" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Request</h1>
          <p className="mt-2 text-gray-600">Update this request&apos;s information</p>
        </div>
        <Button type="button" variant="outline" onClick={handleDuplicate} disabled={duplicating}>
          <Copy className="mr-2 h-4 w-4" />
          {duplicating ? 'Duplicating...' : 'Duplicate'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleDelete}
          disabled={deleting}
          title="Delete request"
          className="text-red-600 hover:text-red-700 hover:bg-red-50"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {deleting ? 'Deleting...' : 'Delete'}
        </Button>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Request Information</CardTitle>
            <CardDescription>Edit the request details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="clientMode">Client Type</Label>
                <Select
                  value={clientMode}
                  onValueChange={(value) => {
                    const nextMode = value as 'new' | 'existing'
                    setClientMode(nextMode)
                    if (nextMode === 'new') {
                      setFormData((prev) => ({ ...prev, clientId: '' }))
                    }
                  }}
                >
                  <SelectTrigger id="clientMode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">New Client</SelectItem>
                    <SelectItem value="existing">Existing Client</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {clientMode === 'existing' && (
              <>
                <div>
                  <Label htmlFor="clientId">Select Client *</Label>
                  <SearchableClientSelect
                    clients={clients}
                    value={formData.clientId}
                    onSelect={handleExistingClientSelect}
                    placeholder="Select client..."
                  />
                </div>
              </>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="firstName">First Name *</Label>
                <Input
                  id="firstName"
                  required
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  placeholder="John"
                />
              </div>
              <div>
                <Label htmlFor="lastName">Last Name *</Label>
                <Input
                  id="lastName"
                  required
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  placeholder="Doe"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@example.com"
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
              <Label htmlFor="company">Company</Label>
              <Input
                id="company"
                value={formData.company}
                onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                placeholder="Company name"
              />
            </div>

            <div>
              <Label htmlFor="jobSiteAddress">Job Site Address</Label>
              <GoogleMapsLoader>
                <PlaceAutocompleteInput
                  inputId="jobSiteAddress"
                  value={formData.jobSiteAddress}
                  onChangeText={(text) => {
                    setJobSitePlaceId(null)
                    syncAddressParts(text)
                  }}
                  onAddressSelected={({ placeId, description, address }) => {
                    setJobSitePlaceId(placeId)
                    setFormData((prev) => ({
                      ...prev,
                      jobSiteAddress: description,
                      jobSiteCity: address.city || '',
                      jobSiteState: address.state || '',
                      jobSiteZipCode: address.zipCode || '',
                    }))
                  }}
                  placeholder="Start typing an address (required to select from list)"
                />
              </GoogleMapsLoader>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="jobSiteCity">City</Label>
                  <Input
                    id="jobSiteCity"
                    value={formData.jobSiteCity}
                    readOnly
                    disabled
                    placeholder="City"
                  />
                </div>
                <div>
                  <Label htmlFor="jobSiteState">State</Label>
                  <Input
                    id="jobSiteState"
                    value={formData.jobSiteState}
                    readOnly
                    disabled
                    placeholder="State"
                  />
                </div>
                <div>
                  <Label htmlFor="jobSiteZipCode">Zip Code</Label>
                  <Input
                    id="jobSiteZipCode"
                    value={formData.jobSiteZipCode}
                    readOnly
                    disabled
                    placeholder="Zip"
                  />
                </div>
              </div>
              {formData.jobSiteAddress.trim() && (
                <iframe
                  title="Job Site Map"
                  className="mt-3 h-56 w-full rounded-md border"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  src={`https://maps.google.com/maps?q=${encodeURIComponent(formData.jobSiteAddress)}&output=embed`}
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div>
                <Label htmlFor="source">Source</Label>
                <Select value={formData.source} onValueChange={(value) => setFormData({ ...formData, source: value })}>
                  <SelectTrigger id="source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OTHER">Other</SelectItem>
                    <SelectItem value="WEBSITE">Website</SelectItem>
                    <SelectItem value="REFERRAL">Referral</SelectItem>
                    <SelectItem value="SOCIAL_MEDIA">Social Media</SelectItem>
                    <SelectItem value="ADVERTISING">Advertising</SelectItem>
                    <SelectItem value="TRADE_SHOW">Trade Show</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NEW">New</SelectItem>
                    <SelectItem value="CONTACTED">Contacted</SelectItem>
                    <SelectItem value="QUALIFIED">Qualified</SelectItem>
                    <SelectItem value="ESTIMATE_CREATED">Estimate Created</SelectItem>
                    <SelectItem value="ESTIMATE_SENT">Estimate Sent</SelectItem>
                    <SelectItem value="FOLLOW_UP">Follow Up</SelectItem>
                    <SelectItem value="CONVERTED">Converted</SelectItem>
                    <SelectItem value="LOST">Lost</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <JobTypeSelect
                value={formData.jobType}
                onValueChange={(value) => setFormData({ ...formData, jobType: value })}
              />
              <div>
                <Label htmlFor="assignedToId">Assigned To</Label>
                <Select
                  value={formData.assignedToId || '__none__'}
                  onValueChange={(value) => setFormData({ ...formData, assignedToId: value === '__none__' ? '' : value })}
                >
                  <SelectTrigger id="assignedToId" className="w-full">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Unassigned</SelectItem>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.firstName} {user.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="value">Estimated Value ($)</Label>
                <Input
                  id="value"
                  type="number"
                  step="0.01"
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label htmlFor="probability">Probability (%)</Label>
                <Input
                  id="probability"
                  type="number"
                  min="0"
                  max="100"
                  value={formData.probability}
                  onChange={(e) => setFormData({ ...formData, probability: e.target.value })}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                rows={4}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Additional notes about this request..."
              />
            </div>
          </CardContent>
        </Card>

        {normalizedRequestId && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Files</CardTitle>
              <CardDescription>Manage photos, videos, and files for this request</CardDescription>
            </CardHeader>
            <CardContent>
              <DocumentAttachments entityType="request" entityId={normalizedRequestId} />
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
