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
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { useCreateContextPrefill } from '@/src/hooks/useCreateContextPrefill'

interface User {
  id: string
  firstName: string
  lastName: string
}

interface Job {
  id: string
  jobNumber: string
  title: string
  client: {
    id: string
    name: string
    companyName: string | null
  }
}

export default function NewTaskPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const clientIdParam = searchParams.get('clientId')
  const jobIdParam = searchParams.get('jobId')
  const requestIdParam = searchParams.get('requestId')
  const jobNumberParam = searchParams.get('jobNumber') || ''
  const clientNameParam = searchParams.get('clientName') || ''
  const projectTypeParam = searchParams.get('projectType') || ''

  const { prefillClientId, sourceType, sourceId, applyDefaultsOnce } = useCreateContextPrefill('task')
  const [loading, setLoading] = useState(false)
  const [users, setUsers] = useState<User[]>([])
  const [clients, setClients] = useState<PickerClient[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [jobContext, setJobContext] = useState<Job | null>(null)
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    dueDate: '',
    assigneeId: '',
    clientId: clientIdParam || '',
    jobId: jobIdParam || '',
    leadId: '',
  })

  useEffect(() => {
    // Context-aware autofill: when created from a Request, link task -> leadId and client.
    applyDefaultsOnce(
      () => {
        const wantsClient = Boolean(prefillClientId && !formData.clientId)
        const leadFromUrl =
          (sourceType === 'request' ? sourceId : null) || requestIdParam || null
        const wantsLead = Boolean(leadFromUrl && !formData.leadId && !jobIdParam)
        return wantsClient || wantsLead
      },
      () => {
        const leadFromUrl =
          (sourceType === 'request' ? sourceId : null) || requestIdParam || null
        setFormData((prev) => ({
          ...prev,
          clientId: prev.clientId || prefillClientId || '',
          leadId: prev.leadId || (leadFromUrl || ''),
        }))
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillClientId, sourceType, sourceId, requestIdParam, jobIdParam, applyDefaultsOnce])

  useEffect(() => {
    fetchUsers()
    fetchClients()
    if (jobIdParam) {
      fetchJobContext(jobIdParam)
    } else if (formData.clientId) {
      fetchJobs()
    }
  }, [formData.clientId, jobIdParam])

  const fetchUsers = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/schedules/team', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        const teamMembers: User[] = data.teamMembers || []
        setUsers(teamMembers)
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

  const fetchJobs = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/jobs?clientId=${formData.clientId}&limit=1000`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setJobs(data.jobs || [])
      }
    } catch (error) {
      console.error('Error fetching jobs:', error)
    }
  }

  const fetchJobContext = async (jobId: string) => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return

      const data = await response.json()
      const job = data?.job
      if (!job?.id || !job?.client?.id) return

      setJobContext({
        id: job.id,
        jobNumber: job.jobNumber,
        title: job.title,
        client: {
          id: job.client.id,
          name: job.client.name,
          companyName: job.client.companyName || null,
        },
      })

      setFormData((prev) => ({
        ...prev,
        jobId: job.id,
        clientId: job.client.id,
      }))
    } catch (error) {
      console.error('Error fetching job context:', error)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          dueDate: formData.dueDate || null,
          assigneeId: formData.assigneeId || null,
          clientId: formData.clientId || null,
          leadId: formData.leadId || null,
          jobId: formData.jobId || null,
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to create task')
        return
      }

      const data = await response.json()
      const taskId = data?.task?.id || data?.id
      if (taskId) {
        router.push(`/dashboard/tasks/${taskId}`)
      } else {
        router.push('/dashboard/tasks')
      }
    } catch (error) {
      console.error('Error creating task:', error)
      alert('Failed to create task')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref="/dashboard/tasks" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">New Task</h1>
          <p className="mt-2 text-gray-600">Create a new task</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Task Information</CardTitle>
            <CardDescription>Enter the task details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {jobIdParam && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                Linked to Job <strong>{jobContext?.jobNumber || jobNumberParam || 'Loading...'}</strong>
                {` `}for Client <strong>{jobContext?.client.name || clientNameParam || 'Loading...'}</strong>
                {` `}({jobContext?.title || projectTypeParam || 'Project'})
              </div>
            )}
            <div>
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                required
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Task title"
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
                placeholder="Task description..."
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="assigneeId">Assignee</Label>
                <Select
                  value={formData.assigneeId || '__none__'}
                  onValueChange={(value) =>
                    setFormData({ ...formData, assigneeId: value === '__none__' ? '' : value })
                  }
                >
                  <SelectTrigger id="assigneeId">
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
              <div>
                <Label htmlFor="priority">Priority</Label>
                <Select
                  value={formData.priority}
                  onValueChange={(value) => setFormData({ ...formData, priority: value })}
                >
                  <SelectTrigger id="priority">
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOW">Low</SelectItem>
                    <SelectItem value="MEDIUM">Medium</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
                    <SelectItem value="URGENT">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value) => setFormData({ ...formData, status: value })}
                >
                  <SelectTrigger id="status">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TODO">To Do</SelectItem>
                    <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                    <SelectItem value="COMPLETED">Completed</SelectItem>
                    <SelectItem value="CANCELLED">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="dueDate">Due Date</Label>
                <Input
                  id="dueDate"
                  type="datetime-local"
                  value={formData.dueDate}
                  onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="clientId">Client</Label>
                <div className="space-y-2">
                  <SearchableClientSelect
                    clients={clients}
                    value={formData.clientId}
                    onSelect={(value) => setFormData({ ...formData, clientId: value, jobId: '' })}
                    placeholder="Select a client"
                    disabled={Boolean(jobIdParam)}
                  />
                  {formData.clientId && !jobIdParam ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFormData({ ...formData, clientId: '', jobId: '' })}
                    >
                      Clear client
                    </Button>
                  ) : null}
                </div>
              </div>
              <div>
                <Label htmlFor="jobId">Job</Label>
                <Select
                  value={formData.jobId}
                  onValueChange={(value) => setFormData({ ...formData, jobId: value })}
                  disabled={!formData.clientId || Boolean(jobIdParam)}
                >
                  <SelectTrigger id="jobId">
                    <SelectValue placeholder="Select a job" />
                  </SelectTrigger>
                  <SelectContent>
                    {jobs.map((job) => (
                      <SelectItem key={job.id} value={job.id}>
                        {job.jobNumber} - {job.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex justify-end space-x-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !formData.title.trim()}>
                <Save className="mr-2 h-4 w-4" />
                {loading ? 'Creating...' : 'Create Task'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  )
}
