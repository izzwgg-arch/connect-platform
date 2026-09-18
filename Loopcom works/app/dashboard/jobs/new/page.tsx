'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save } from 'lucide-react'
import Link from 'next/link'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import { PlaceAutocompleteInput } from '@/components/maps/PlaceAutocompleteInput'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { fetchClientPickerDetail, pickDefaultClientAddress } from '@/lib/clients/client-picker-api'
import { useCreateContextPrefill } from '@/src/hooks/useCreateContextPrefill'
import { refreshAccessToken } from '@/lib/auth/client'
import { JOB_STATUSES } from '@/lib/jobs/statuses'
import { JobTypeCreateField } from '@/components/jobs/JobTypeCreateField'

export default function NewJobPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const clientIdParam = searchParams.get('clientId')
  const { prefillClientId, address: prefillAddress, noAddressWarning, applyDefaultsOnce } =
    useCreateContextPrefill('job')
  const [loading, setLoading] = useState(false)
  const [clients, setClients] = useState<PickerClient[]>([])
  const [jobSitePlaceId, setJobSitePlaceId] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    clientId: clientIdParam || '',
    title: '',
    description: '',
    status: 'QUOTE',
    jobType: 'CUSTOM',
    priority: '3',
    scheduledStart: '',
    scheduledEnd: '',
    estimateAmount: '',
    jobSite: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'US',
      notes: '',
    },
  })

  useEffect(() => {
    fetchClients()
  }, [])

  useEffect(() => {
    // Context-aware autofill: apply once, don't overwrite user edits.
    applyDefaultsOnce(
      () => {
        const wantsClient = Boolean(prefillClientId && !formData.clientId)
        const wantsAddress = Boolean(
          prefillAddress &&
            !jobSitePlaceId &&
            !formData.jobSite.street &&
            !formData.jobSite.city &&
            !formData.jobSite.state &&
            !formData.jobSite.zipCode
        )
        return wantsClient || wantsAddress
      },
      () => {
        setFormData((prev) => ({
          ...prev,
          clientId: prev.clientId || prefillClientId || '',
          jobSite:
            prefillAddress &&
            !prev.jobSite.street &&
            !prev.jobSite.city &&
            !prev.jobSite.state &&
            !prev.jobSite.zipCode
              ? {
                  ...prev.jobSite,
                  street: prefillAddress.street,
                  city: prefillAddress.city,
                  state: prefillAddress.state,
                  zipCode: prefillAddress.zipCode,
                  country: prefillAddress.country || 'US',
                }
              : prev.jobSite,
        }))
        if (prefillAddress && !jobSitePlaceId) {
          // Job form requires a "place id" when street is filled; use a stable marker for stored addresses.
          setJobSitePlaceId(`stored:${prefillAddress.id}`)
        }
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillClientId, prefillAddress, applyDefaultsOnce])

  const fetchClients = async () => {
    try {
      setClients(await fetchAllPickerClients())
    } catch (error) {
      console.error('Error fetching clients:', error)
    }
  }

  const fetchClientDefaultAddress = async (clientId: string) => {
    const client = await fetchClientPickerDetail(clientId)
    if (!client?.addresses?.length) return null
    return pickDefaultClientAddress(client.addresses)
  }

  const handleClientChange = async (value: string) => {
    setFormData((prev) => ({ ...prev, clientId: value }))

    // Only update job site if user hasn't chosen/entered one yet.
    const isJobSiteEmpty =
      !formData.jobSite.street && !formData.jobSite.city && !formData.jobSite.state && !formData.jobSite.zipCode
    if (!isJobSiteEmpty) return

    const addr = await fetchClientDefaultAddress(value)
    if (!addr?.street) return

    setFormData((prev) => {
      if (prev.clientId !== value) return prev
      const stillEmpty =
        !prev.jobSite.street && !prev.jobSite.city && !prev.jobSite.state && !prev.jobSite.zipCode
      if (!stillEmpty) return prev
      return {
        ...prev,
        jobSite: {
          ...prev.jobSite,
          street: addr.street,
          city: addr.city || '',
          state: addr.state || '',
          zipCode: addr.zipCode || '',
          country: addr.country || 'US',
        },
      }
    })
    setJobSitePlaceId(`stored:${addr.id || value}`)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (formData.jobSite.street.trim() && !jobSitePlaceId) {
      alert('Please select a real job site address from the suggestions.')
      return
    }
    setLoading(true)

    try {
      const token = localStorage.getItem('accessToken')
      
      // Convert datetime-local to ISO string
      // datetime-local format is "YYYY-MM-DDTHH:mm", we need to convert to ISO 8601
      const scheduledStart = formData.scheduledStart && formData.scheduledStart.trim()
        ? (() => {
            const date = new Date(formData.scheduledStart)
            return isNaN(date.getTime()) ? null : date.toISOString()
          })()
        : null
      const scheduledEnd = formData.scheduledEnd && formData.scheduledEnd.trim()
        ? (() => {
            const date = new Date(formData.scheduledEnd)
            return isNaN(date.getTime()) ? null : date.toISOString()
          })()
        : null
      
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          clientId: formData.clientId,
          title: formData.title,
          description: formData.description,
          status: formData.status,
          jobType: formData.jobType,
          priority: parseInt(formData.priority),
          scheduledStart: scheduledStart,
          scheduledEnd: scheduledEnd,
          estimateAmount: formData.estimateAmount ? parseFloat(formData.estimateAmount) : null,
          jobSite: formData.jobSite.street ? formData.jobSite : null,
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to create job')
        return
      }

      const data = await response.json()
      if (data.job && data.job.id) {
        router.push(`/dashboard/jobs/${data.job.id}`)
      } else {
        alert('Job created but unable to redirect. Please refresh the page.')
        router.push('/dashboard/jobs')
      }
    } catch (error) {
      console.error('Error creating job:', error)
      alert('Failed to create job')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref="/dashboard/jobs" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">New Job</h1>
          <p className="mt-2 text-gray-600">Create a new job</p>
        </div>
      </div>

      {noAddressWarning && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Client has no address on file. Job site address was not auto-filled.
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Job Information</CardTitle>
            <CardDescription>Enter the job details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="clientId">Client *</Label>
              <SearchableClientSelect
                clients={clients}
                value={formData.clientId}
                onSelect={handleClientChange}
                placeholder="Select a client"
              />
            </div>

            <div>
              <Label htmlFor="title">Job Title *</Label>
              <Input
                id="title"
                required
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Kitchen Cabinet Installation"
              />
            </div>

            <div>
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                rows={4}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Job description and requirements..."
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value) => setFormData({ ...formData, status: value })}
                >
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {JOB_STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <JobTypeCreateField
                value={formData.jobType}
                onValueChange={(value) => setFormData((prev) => ({ ...prev, jobType: value }))}
              />
            </div>

            <div>
              <Label htmlFor="priority">Priority (1-5)</Label>
              <Input
                id="priority"
                type="number"
                min="1"
                max="5"
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="scheduledStart">Scheduled Start</Label>
                <Input
                  id="scheduledStart"
                  type="datetime-local"
                  value={formData.scheduledStart}
                  onChange={(e) => setFormData({ ...formData, scheduledStart: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="scheduledEnd">Scheduled End</Label>
                <Input
                  id="scheduledEnd"
                  type="datetime-local"
                  value={formData.scheduledEnd}
                  onChange={(e) => setFormData({ ...formData, scheduledEnd: e.target.value })}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="estimateAmount">Estimate Amount</Label>
              <Input
                id="estimateAmount"
                type="number"
                step="0.01"
                value={formData.estimateAmount}
                onChange={(e) => setFormData({ ...formData, estimateAmount: e.target.value })}
                placeholder="0.00"
              />
            </div>
          </CardContent>
        </Card>

        {/* Job Site Address */}
        <Card>
          <CardHeader>
            <CardTitle>Job Site Address</CardTitle>
            <CardDescription>Location where the work will be performed</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="jobSiteStreet">Street Address</Label>
              <GoogleMapsLoader>
                <PlaceAutocompleteInput
                  inputId="jobSiteStreet"
                  value={formData.jobSite.street}
                  onChangeText={(text) => {
                    setJobSitePlaceId(null)
                    setFormData((prev) => ({
                      ...prev,
                      jobSite: {
                        ...prev.jobSite,
                        street: text,
                        city: '',
                        state: '',
                        zipCode: '',
                      },
                    }))
                  }}
                  onAddressSelected={({ placeId, address }) => {
                    setJobSitePlaceId(placeId)
                    setFormData((prev) => ({
                      ...prev,
                      jobSite: {
                        ...prev.jobSite,
                        street: address.street || prev.jobSite.street,
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="jobSiteCity">City</Label>
                <Input
                  id="jobSiteCity"
                  value={formData.jobSite.city}
                  readOnly
                  disabled
                  placeholder="City"
                />
              </div>
              <div>
                <Label htmlFor="jobSiteState">State</Label>
                <Input
                  id="jobSiteState"
                  value={formData.jobSite.state}
                  readOnly
                  disabled
                  placeholder="State"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="jobSiteZip">Zip Code</Label>
                <Input
                  id="jobSiteZip"
                  value={formData.jobSite.zipCode}
                  readOnly
                  disabled
                  placeholder="12345"
                />
              </div>
              <div>
                <Label htmlFor="jobSiteCountry">Country</Label>
                <Input
                  id="jobSiteCountry"
                  value={formData.jobSite.country}
                  onChange={(e) => setFormData({
                    ...formData,
                    jobSite: { ...formData.jobSite, country: e.target.value }
                  })}
                  placeholder="US"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="jobSiteNotes">Location Notes</Label>
              <textarea
                id="jobSiteNotes"
                rows={2}
                value={formData.jobSite.notes}
                onChange={(e) => setFormData({
                  ...formData,
                  jobSite: { ...formData.jobSite, notes: e.target.value }
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Special instructions or landmarks..."
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end space-x-4">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            <Save className="mr-2 h-4 w-4" />
            {loading ? 'Creating...' : 'Create Job'}
          </Button>
        </div>
      </form>
    </div>
  )
}
