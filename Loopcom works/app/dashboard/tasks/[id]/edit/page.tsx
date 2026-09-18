'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, Save, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface User {
  id: string
  firstName: string
  lastName: string
}

interface TaskResponse {
  task: {
    id: string
    title: string
    description: string | null
    status: string
    priority: string
    dueDate: string | null
    assignee: { id: string } | null
  }
}

function toDateTimeLocal(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  const yyyy = date.getFullYear()
  const mm = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const hh = pad(date.getHours())
  const min = pad(date.getMinutes())
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

export default function EditTaskPage() {
  const router = useRouter()
  const params = useParams()
  const taskId = params?.id as string | undefined

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    dueDate: '',
    assigneeId: '',
  })

  const normalizedTaskId = useMemo(() => {
    if (!taskId || typeof taskId !== 'string') return null
    return taskId
  }, [taskId])

  useEffect(() => {
    if (!normalizedTaskId) {
      setError('Invalid task ID')
      setLoading(false)
      return
    }

    void Promise.all([fetchUsers(), fetchTask(normalizedTaskId)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedTaskId])

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
    } catch (e) {
      console.error('Error fetching users:', e)
    }
  }

  const fetchTask = async (id: string) => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/tasks/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (response.status === 404) {
        setError('Task not found')
        return
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to load task' }))
        setError(payload.error || 'Failed to load task')
        return
      }

      const data = (await response.json()) as TaskResponse
      setFormData({
        title: data.task.title || '',
        description: data.task.description || '',
        status: data.task.status || 'TODO',
        priority: data.task.priority || 'MEDIUM',
        dueDate: toDateTimeLocal(data.task.dueDate),
        assigneeId: data.task.assignee?.id || '',
      })
      setError(null)
    } catch (e) {
      console.error('Error loading task:', e)
      setError('Failed to load task')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!normalizedTaskId) return
    if (!formData.title.trim() || !formData.assigneeId) {
      alert('Title and assignee are required')
      return
    }

    setSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/tasks/${normalizedTaskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: formData.title,
          description: formData.description,
          status: formData.status,
          priority: formData.priority,
          dueDate: formData.dueDate || null,
          assigneeId: formData.assigneeId,
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to update task' }))
        alert(payload.error || 'Failed to update task')
        return
      }

      router.replace(`/dashboard/tasks/${normalizedTaskId}`)
    } catch (e) {
      console.error('Error updating task:', e)
      alert('Failed to update task')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!normalizedTaskId) return
    if (!confirm('Delete this task? This cannot be undone.')) return

    setDeleting(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/tasks/${normalizedTaskId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to delete task' }))
        alert(payload.error || 'Failed to delete task')
        return
      }

      router.push('/dashboard/tasks')
    } catch (e) {
      console.error('Error deleting task:', e)
      alert('Failed to delete task')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading task...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
          <h2 className="mt-4 text-xl font-semibold text-gray-900">Unable to Edit Task</h2>
          <p className="mt-2 text-gray-600">{error}</p>
          <div className="mt-6">
            <Button onClick={() => router.push('/dashboard/tasks')}>Back to Tasks</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref={`/dashboard/tasks/${normalizedTaskId}`} parentHref={`/dashboard/tasks/${normalizedTaskId}`} mode="parent" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Task</h1>
          <p className="mt-2 text-gray-600">Update task details</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Task Information</CardTitle>
            <CardDescription>Edit task fields and save changes</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                required
                value={formData.title}
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="Task title"
              />
            </div>

            <div>
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                rows={4}
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Task description..."
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="assigneeId">Assignee *</Label>
                <Select
                  value={formData.assigneeId}
                  onValueChange={(value) => setFormData((prev) => ({ ...prev, assigneeId: value }))}
                >
                  <SelectTrigger id="assigneeId">
                    <SelectValue placeholder="Select assignee" />
                  </SelectTrigger>
                  <SelectContent>
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
                  onValueChange={(value) => setFormData((prev) => ({ ...prev, priority: value }))}
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
                  onValueChange={(value) => setFormData((prev) => ({ ...prev, status: value }))}
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
                  onChange={(e) => setFormData((prev) => ({ ...prev, dueDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="flex justify-between">
              <Button
                type="button"
                variant="outline"
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={handleDelete}
                disabled={deleting || saving}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {deleting ? 'Deleting...' : 'Delete Task'}
              </Button>
              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={() => router.back()} disabled={saving || deleting}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving || deleting}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  )
}
