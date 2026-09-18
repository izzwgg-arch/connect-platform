'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/utils'
import { AlertCircle, Calendar, CheckSquare, Pencil, Trash2, User } from 'lucide-react'
import { TaskStatusSelect } from '@/components/tasks/TaskStatusSelect'
import { EditableNotesList } from '@/components/notes/editable-notes-list'
import { taskStatusColors, formatTaskStatus } from '@/lib/tasks/statuses'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'

interface TaskDetail {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  dueDate: string | null
  completedAt: string | null
  createdAt: string
  assignee: { id: string; firstName: string; lastName: string; email: string; phone?: string | null } | null
  creator: { id: string; firstName: string; lastName: string } | null
  client: { id: string; name: string; companyName: string | null } | null
  job: { id: string; jobNumber: string; title: string } | null
  invoice: { id: string; invoiceNumber: string; title: string } | null
  issue: { id: string; title: string; status: string } | null
  subtasks: Array<{ id: string; title: string; isCompleted: boolean }>
  attachments: Array<{ id: string; filename: string | null; url: string; type: string; createdAt: string }>
}

interface TaskNote {
  id: string
  content: string
  createdAt: string
  authorName?: string
}

const statusBadge = taskStatusColors

export default function TaskDetailPage() {
  const params = useParams()
  const router = useRouter()
  const taskId = params.id as string
  const { permissions } = usePermissions()
  const canEditStatus = hasPermission(permissions, 'tasks.edit')

  const [task, setTask] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notes, setNotes] = useState<TaskNote[]>([])
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)

  const badgeClass = useMemo(() => {
    const s = task?.status || ''
    return statusBadge[s] || 'bg-gray-100 text-gray-800'
  }, [task?.status])

  useEffect(() => {
    if (!taskId) {
      setError('Invalid task ID')
      setLoading(false)
      return
    }
    void fetchTask()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const fetchTask = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (response.status === 404) {
        setError('Task not found')
        setTask(null)
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to load task' }))
        setError(payload.error || 'Failed to load task')
        setTask(null)
        return
      }

      const data = await response.json()
      setTask(data.task)
      setError(null)
      await fetchTaskNotes()
    } catch (e) {
      console.error('Failed to fetch task:', e)
      setError('Failed to load task. Please try again.')
      setTask(null)
    } finally {
      setLoading(false)
    }
  }

  const fetchTaskNotes = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const response = await fetch(`/api/tasks/${taskId}/notes`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return
      const data = await response.json()
      setNotes(Array.isArray(data.notes) ? data.notes : [])
    } catch (e) {
      console.error('Failed to fetch task notes:', e)
    }
  }

  const updateStatus = async (nextStatus: string) => {
    if (!task) return
    setUpdating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
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

      const data = await response.json()
      setTask(data.task)
    } catch (e) {
      console.error('Failed to update task:', e)
      alert('Failed to update task. Please try again.')
    } finally {
      setUpdating(false)
    }
  }

  const deleteTask = async () => {
    if (!task) return
    if (!confirm(`Delete task "${task.title}"? This cannot be undone.`)) return

    setDeleting(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/tasks/${task.id}`, {
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
      console.error('Failed to delete task:', e)
      alert('Failed to delete task. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  const appendTaskNote = async () => {
    if (!task || !noteText.trim()) return
    setAddingNote(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/tasks/${task.id}/notes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteText.trim() }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to append note' }))
        alert(payload.error || 'Failed to append note')
        return
      }

      setNoteText('')
      await fetchTaskNotes()
    } catch (e) {
      console.error('Failed to append task note:', e)
      alert('Failed to append note. Please try again.')
    } finally {
      setAddingNote(false)
    }
  }

  const updateTaskNote = async (noteId: string, content: string) => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }

    const response = await fetch(`/api/tasks/${taskId}/notes/${noteId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    })

    if (response.status === 401) {
      router.push('/auth/login')
      return
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'Failed to update note' }))
      alert(payload.error || 'Failed to update note')
      return
    }

    await fetchTaskNotes()
  }

  const deleteTaskNote = async (noteId: string) => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }

    const response = await fetch(`/api/tasks/${taskId}/notes/${noteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 401) {
      router.push('/auth/login')
      return
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'Failed to delete note' }))
      alert(payload.error || 'Failed to delete note')
      return
    }

    await fetchTaskNotes()
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

  if (error || !task) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
          <h2 className="mt-4 text-xl font-semibold text-gray-900">Task Not Found</h2>
          <p className="mt-2 text-gray-600">{error || 'The task you are looking for does not exist.'}</p>
          <div className="mt-6">
            <Button onClick={() => router.push('/dashboard/tasks')}>Back to Tasks</Button>
          </div>
        </div>
      </div>
    )
  }

  const isCompleted = task.status === 'COMPLETED'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <EntityBackButton fallbackHref="/dashboard/tasks" />
          <div className="flex items-center gap-3 mt-2">
            <h1 className="text-3xl font-bold text-gray-900">{task.title}</h1>
            {canEditStatus ? (
              <TaskStatusSelect
                taskId={task.id}
                status={task.status}
                onUpdated={(nextStatus) => setTask((current) => (current ? { ...current, status: nextStatus } : current))}
              />
            ) : (
              <span className={`px-3 py-1 text-sm rounded-full ${badgeClass}`}>{formatTaskStatus(task.status)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/dashboard/tasks/${task.id}/edit`)}
            title="Edit task"
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          {canEditStatus && (
            <Button
              variant="outline"
              disabled={updating}
              onClick={() => updateStatus(isCompleted ? 'TODO' : 'COMPLETED')}
              title={isCompleted ? 'Reopen task' : 'Mark task completed'}
            >
              <CheckSquare className="mr-2 h-4 w-4" />
              {updating ? 'Updating...' : isCompleted ? 'Reopen' : 'Mark Complete'}
            </Button>
          )}
          <Button
            variant="outline"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            disabled={deleting}
            onClick={() => deleteTask()}
            title="Delete task"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          {task.description && (
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{task.description}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <textarea
                rows={3}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Add a note to task description..."
              />
              <div className="flex justify-end">
                <Button onClick={() => void appendTaskNote()} disabled={addingNote || !noteText.trim()}>
                  {addingNote ? 'Saving...' : 'Add Note'}
                </Button>
              </div>
              <EditableNotesList
                notes={notes}
                emptyMessage="No notes yet."
                onUpdate={updateTaskNote}
                onDelete={deleteTaskNote}
                canEdit={canEditStatus}
              />
            </CardContent>
          </Card>

          {task.subtasks?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Subtasks</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {task.subtasks.map((st) => (
                    <div key={st.id} className="flex items-center gap-2 text-sm">
                      <CheckSquare className={`h-4 w-4 ${st.isCompleted ? 'text-green-600' : 'text-gray-300'}`} />
                      <span className={st.isCompleted ? 'line-through text-gray-400' : 'text-gray-700'}>{st.title}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {task.attachments?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Attachments</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {task.attachments.slice(0, 20).map((a) => (
                    <a
                      key={a.id}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-sm text-blue-600 hover:underline"
                    >
                      {a.filename || a.type || 'Attachment'}
                    </a>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-start gap-2">
                <User className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-gray-500">Assignee</p>
                  <p className="font-medium text-gray-900">
                    {task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}` : 'Unassigned'}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-gray-500">Created</p>
                  <p className="font-medium text-gray-900">{formatDate(task.createdAt)}</p>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-gray-500">Due</p>
                  <p className="font-medium text-gray-900">{task.dueDate ? formatDate(task.dueDate) : 'No due date'}</p>
                </div>
              </div>

              {task.client && (
                <div>
                  <p className="text-gray-500">Client</p>
                  <Link href={`/dashboard/clients/${task.client.id}`} className="text-blue-600 hover:underline font-medium">
                    {task.client.name}
                  </Link>
                </div>
              )}

              {task.job && (
                <div>
                  <p className="text-gray-500">Job</p>
                  <Link href={`/dashboard/jobs/${task.job.id}`} className="text-blue-600 hover:underline font-medium">
                    {task.job.jobNumber} - {task.job.title}
                  </Link>
                </div>
              )}

              {task.issue && (
                <div>
                  <p className="text-gray-500">Related Issue</p>
                  <Link href={`/dashboard/issues/${task.issue.id}`} className="text-blue-600 hover:underline font-medium">
                    {task.issue.title}
                  </Link>
                </div>
              )}

              {task.invoice && (
                <div>
                  <p className="text-gray-500">Invoice</p>
                  <Link href={`/dashboard/invoices/${task.invoice.id}`} className="text-blue-600 hover:underline font-medium">
                    {task.invoice.invoiceNumber}
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

