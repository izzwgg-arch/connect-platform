'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Save, Copy } from 'lucide-react'
import Link from 'next/link'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import { PlaceAutocompleteInput } from '@/components/maps/PlaceAutocompleteInput'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { JOB_STATUSES } from '@/lib/jobs/statuses'
import { JobTypeSelect } from '@/components/jobs/JobTypeSelect'

type JobResponse = {
  job: {
    id: string
    title: string
    description: string | null
    status: string
    jobType?: string
    priority: number
    scheduledStart: string | null
    scheduledEnd: string | null
    actualStart: string | null
    actualEnd: string | null
    estimateAmount: number | null
    actualAmount: number | null
    laborCost: number | null
    materialCost: number | null
    clientId: string
    client: {
      id: string
      name: string
    }
    jobSite: {
      street: string
      city: string
      state: string
      zipCode: string
      country: string
      notes: string | null
    } | null
  }
}

export default function EditJobPage() {
  const router = useRouter()
  const params = useParams()
  const jobId = params?.id as string | undefined

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clients, setClients] = useState<PickerClient[]>([])
  const [jobSitePlaceId, setJobSitePlaceId] = useState<string | null>(null)

  const [formData, setFormData] = useState({
    clientId: '',
    title: '',
    description: '',
    status: 'QUOTE',
    jobType: 'CUSTOM',
    priority: '3',
    scheduledStart: '',
    scheduledEnd: '',
    actualStart: '',
    actualEnd: '',
    estimateAmount: '',
    actualAmount: '',
    laborCost: '',
    materialCost: '',
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
    if (jobId) {
      fetchJob()
      fetchClients()
    }
  }, [jobId])

  const fetchClients = async () => {
    try {
      setClients(await fetchAllPickerClients())
    } catch (error) {
      console.error('Error fetching clients:', error)
    }
  }

  const fetchJob = async () => {
    if (!jobId) return

    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/jobs/${jobId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        setError(error.error || 'Failed to load job')
        setLoading(false)
        return
      }

      const data: JobResponse = await response.json()
      if (data.job) {
        const job = data.job
        const jobSite = job.jobSite || {
          street: '',
          city: '',
          state: '',
          zipCode: '',
          country: 'US',
          notes: null,
        }

        setFormData({
          clientId: job.clientId,
          title: job.title,
          description: job.description || '',
          status: job.status,
          jobType: job.jobType || 'CUSTOM',
          priority: job.priority.toString(),
          scheduledStart: job.scheduledStart ? new Date(job.scheduledStart).toISOString().slice(0, 16) : '',
          scheduledEnd: job.scheduledEnd ? new Date(job.scheduledEnd).toISOString().slice(0, 16) : '',
          actualStart: job.actualStart ? new Date(job.actualStart).toISOString().slice(0, 16) : '',
          actualEnd: job.actualEnd ? new Date(job.actualEnd).toISOString().slice(0, 16) : '',
          estimateAmount: job.estimateAmount?.toString() || '',
          actualAmount: job.actualAmount?.toString() || '',
          laborCost: job.laborCost?.toString() || '',
          materialCost: job.materialCost?.toString() || '',
          jobSite: {
            street: jobSite.street || '',
            city: jobSite.city || '',
            state: jobSite.state || '',
            zipCode: jobSite.zipCode || '',
            country: jobSite.country || 'US',
            notes: jobSite.notes || '',
          },
        })
        setJobSitePlaceId(jobSite.street ? 'existing' : null)
      }
    } catch (error) {
      console.error('Error fetching job:', error)
      setError('Failed to load job')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!jobId) return
    if (formData.jobSite.street.trim() && !jobSitePlaceId) {
      setError('Please select a real job site address from the suggestions.')
      return
    }

    setSaving(true)
    setError(null)

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
      const actualStart = formData.actualStart && formData.actualStart.trim()
        ? (() => {
            const date = new Date(formData.actualStart)
            return isNaN(date.getTime()) ? null : date.toISOString()
          })()
        : null
      const actualEnd = formData.actualEnd && formData.actualEnd.trim()
        ? (() => {
            const date = new Date(formData.actualEnd)
            return isNaN(date.getTime()) ? null : date.toISOString()
          })()
        : null
      
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: formData.title,
          description: formData.description,
          status: formData.status,
          jobType: formData.jobType,
          priority: parseInt(formData.priority),
          scheduledStart: scheduledStart,
          scheduledEnd: scheduledEnd,
          actualStart: actualStart,
          actualEnd: actualEnd,
          estimateAmount: formData.estimateAmount ? parseFloat(formData.estimateAmount) : null,
          actualAmount: formData.actualAmount ? parseFloat(formData.actualAmount) : null,
          laborCost: formData.laborCost ? parseFloat(formData.laborCost) : null,
          materialCost: formData.materialCost ? parseFloat(formData.materialCost) : null,
          jobSite: formData.jobSite.street ? formData.jobSite : null,
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        setError(error.error || 'Failed to update job')
        setSaving(false)
        return
      }

      const data = await response.json()
      if (data.job && data.job.id) {
        router.replace(`/dashboard/jobs/${data.job.id}`)
      } else {
        router.replace(`/dashboard/jobs/${jobId}`)
      }
    } catch (error) {
      console.error('Error updating job:', error)
      setError('Failed to update job')
      setSaving(false)
    }
  }

  const handleDuplicate = async () => {
    if (!jobId) return
    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/jobs/${jobId}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to duplicate job')
        return
      }
      if (data?.id) {
        router.push(`/dashboard/jobs/${data.id}/edit`)
      } else {
        router.push('/dashboard/jobs')
      }
    } catch (error) {
      console.error('Duplicate job error:', error)
      alert('Failed to duplicate job')
    } finally {
      setDuplicating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading job...</p>
        </div>
      </div>
    )
  }

  if (error && !formData.title) {
    return (
      <div className="text-center py-12">
        <div className="text-red-600 text-xl font-semibold mb-2">Error</div>
        <p className="text-gray-600 mb-4">{error}</p>
        <Button variant="outline" onClick={() => router.push('/dashboard/jobs')}>
          ← Back to Jobs
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <Link href={jobId ? `/dashboard/jobs/${jobId}` : '/dashboard/jobs'}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Job</h1>
          <p className="mt-2 text-gray-600">Update job information</p>
        </div>
        <Button type="button" variant="outline" onClick={handleDuplicate} disabled={duplicating}>
          <Copy className="mr-2 h-4 w-4" />
          {duplicating ? 'Duplicating...' : 'Duplicate'}
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Job Information</CardTitle>
            <CardDescription>Update the job details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="clientId">Client *</Label>
              <SearchableClientSelect
                clients={clients}
                value={formData.clientId}
                onSelect={(value) => setFormData({ ...formData, clientId: value })}
                placeholder="Select a client"
                disabled
              />
              <p className="text-sm text-gray-500 mt-1">Client cannot be changed after job creation</p>
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
              <JobTypeSelect
                value={formData.jobType}
                onValueChange={(value) => setFormData({ ...formData, jobType: value })}
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

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="actualStart">Actual Start</Label>
                <Input
                  id="actualStart"
                  type="datetime-local"
                  value={formData.actualStart}
                  onChange={(e) => setFormData({ ...formData, actualStart: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="actualEnd">Actual End</Label>
                <Input
                  id="actualEnd"
                  type="datetime-local"
                  value={formData.actualEnd}
                  onChange={(e) => setFormData({ ...formData, actualEnd: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
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
              <div>
                <Label htmlFor="actualAmount">Actual Amount</Label>
                <Input
                  id="actualAmount"
                  type="number"
                  step="0.01"
                  value={formData.actualAmount}
                  onChange={(e) => setFormData({ ...formData, actualAmount: e.target.value })}
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="laborCost">Labor Cost</Label>
                <Input
                  id="laborCost"
                  type="number"
                  step="0.01"
                  value={formData.laborCost}
                  onChange={(e) => setFormData({ ...formData, laborCost: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label htmlFor="materialCost">Material Cost</Label>
                <Input
                  id="materialCost"
                  type="number"
                  step="0.01"
                  value={formData.materialCost}
                  onChange={(e) => setFormData({ ...formData, materialCost: e.target.value })}
                  placeholder="0.00"
                />
              </div>
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
                <Input id="jobSiteCity" value={formData.jobSite.city} readOnly disabled placeholder="City" />
              </div>
              <div>
                <Label htmlFor="jobSiteState">State</Label>
                <Input id="jobSiteState" value={formData.jobSite.state} readOnly disabled placeholder="State" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="jobSiteZip">Zip Code</Label>
                <Input id="jobSiteZip" value={formData.jobSite.zipCode} readOnly disabled placeholder="12345" />
              </div>
              <div>
                <Label htmlFor="jobSiteCountry">Country</Label>
                <Input
                  id="jobSiteCountry"
                  value={formData.jobSite.country}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      jobSite: { ...prev.jobSite, country: e.target.value },
                    }))
                  }
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
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    jobSite: { ...prev.jobSite, notes: e.target.value },
                  }))
                }
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
          <Button type="submit" disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </div>
  )
}
