'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/utils'
import { AlertCircle, Calendar, CheckCircle, Clock, Trash2, User } from 'lucide-react'
import { EditableNotesList } from '@/components/notes/editable-notes-list'

interface IssueDetail {
  id: string
  title: string
  description: string | null
  type: string
  status: string
  priority: string
  firstResponseAt: string | null
  resolvedAt: string | null
  closedAt: string | null
  assignee: { id: string; firstName: string; lastName: string; email: string; phone?: string | null } | null
  creator: { id: string; firstName: string; lastName: string } | null
  client: { id: string; name: string; companyName: string | null } | null
  job: { id: string; jobNumber: string; title: string } | null
  tasks: Array<{ id: string; title: string; status: string }>
  notes: Array<{ id: string; content: string; createdAt: string; authorName?: string }>
  attachments: Array<{ id: string; filename: string | null; url: string; type: string; createdAt: string }>
  _count?: { notes: number; tasks: number; watchers: number }
}

const statusBadge: Record<string, string> = {
  OPEN: 'bg-red-100 text-red-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  RESOLVED: 'bg-green-100 text-green-800',
  CLOSED: 'bg-gray-100 text-gray-800',
  CANCELLED: 'bg-gray-100 text-gray-800',
}

export default function IssueDetailPage() {
  const params = useParams()
  const router = useRouter()
  const issueId = params.id as string

  const [issue, setIssue] = useState<IssueDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)

  const badgeClass = useMemo(() => {
    const s = issue?.status || ''
    return statusBadge[s] || 'bg-gray-100 text-gray-800'
  }, [issue?.status])

  useEffect(() => {
    if (!issueId) {
      setError('Invalid issue ID')
      setLoading(false)
      return
    }
    void fetchIssue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId])

  const fetchIssue = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/issues/${issueId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (response.status === 404) {
        setError('Issue not found')
        setIssue(null)
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to load issue' }))
        setError(payload.error || 'Failed to load issue')
        setIssue(null)
        return
      }

      const data = await response.json()
      setIssue(data.issue)
      setError(null)
    } catch (e) {
      console.error('Failed to fetch issue:', e)
      setError('Failed to load issue. Please try again.')
      setIssue(null)
    } finally {
      setLoading(false)
    }
  }

  const updateStatus = async (nextStatus: string) => {
    if (!issue) return
    setUpdating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/issues/${issue.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to update issue' }))
        alert(payload.error || 'Failed to update issue')
        return
      }

      const data = await response.json()
      setIssue(data.issue)
    } catch (e) {
      console.error('Failed to update issue:', e)
      alert('Failed to update issue. Please try again.')
    } finally {
      setUpdating(false)
    }
  }

  const deleteIssue = async () => {
    if (!issue) return
    if (!confirm(`Delete issue "${issue.title}"? This cannot be undone.`)) return

    setDeleting(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/issues/${issue.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to delete issue' }))
        alert(payload.error || 'Failed to delete issue')
        return
      }

      router.push('/dashboard/issues')
    } catch (e) {
      console.error('Failed to delete issue:', e)
      alert('Failed to delete issue. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  const addIssueNote = async () => {
    if (!issue || !noteText.trim()) return
    setAddingNote(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/issues/${issue.id}/notes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteText.trim(), isInternal: false }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to add note' }))
        alert(payload.error || 'Failed to add note')
        return
      }

      setNoteText('')
      await fetchIssue()
    } catch (e) {
      console.error('Failed to add issue note:', e)
      alert('Failed to add note. Please try again.')
    } finally {
      setAddingNote(false)
    }
  }

  const updateIssueNote = async (noteId: string, content: string) => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }

    const response = await fetch(`/api/issues/${issueId}/notes/${noteId}`, {
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

    await fetchIssue()
  }

  const deleteIssueNote = async (noteId: string) => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      return
    }

    const response = await fetch(`/api/issues/${issueId}/notes/${noteId}`, {
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

    await fetchIssue()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading issue...</p>
        </div>
      </div>
    )
  }

  if (error || !issue) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
          <h2 className="mt-4 text-xl font-semibold text-gray-900">Issue Not Found</h2>
          <p className="mt-2 text-gray-600">{error || 'The issue you are looking for does not exist.'}</p>
          <div className="mt-6">
            <Button onClick={() => router.push('/dashboard/issues')}>Back to Issues</Button>
          </div>
        </div>
      </div>
    )
  }

  const canResolve = issue.status !== 'RESOLVED' && issue.status !== 'CLOSED'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <EntityBackButton fallbackHref="/dashboard/issues" />
          <div className="flex items-center gap-3 mt-2">
            <h1 className="text-3xl font-bold text-gray-900">{issue.title}</h1>
            <span className={`px-3 py-1 text-sm rounded-full ${badgeClass}`}>{issue.status.replaceAll('_', ' ')}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={updating} onClick={() => updateStatus('IN_PROGRESS')}>
            <Clock className="mr-2 h-4 w-4" />
            {updating ? 'Updating...' : 'In Progress'}
          </Button>
          <Button variant="outline" disabled={updating || !canResolve} onClick={() => updateStatus('RESOLVED')}>
            <CheckCircle className="mr-2 h-4 w-4" />
            Resolve
          </Button>
          <Button
            variant="outline"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            disabled={deleting}
            onClick={() => deleteIssue()}
            title="Delete issue"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          {issue.description && (
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{issue.description}</p>
              </CardContent>
            </Card>
          )}

          {issue.tasks?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Related Tasks</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {issue.tasks.slice(0, 20).map((t) => (
                    <Link key={t.id} href={`/dashboard/tasks/${t.id}`} className="block text-sm text-blue-600 hover:underline">
                      {t.title} ({t.status})
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-4 space-y-2">
                <textarea
                  rows={3}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Add a note..."
                />
                <div className="flex justify-end">
                  <Button onClick={() => void addIssueNote()} disabled={addingNote || !noteText.trim()}>
                    {addingNote ? 'Saving...' : 'Add Note'}
                  </Button>
                </div>
              </div>
              <EditableNotesList
                notes={issue.notes || []}
                emptyMessage="No notes yet."
                onUpdate={updateIssueNote}
                onDelete={deleteIssueNote}
              />
            </CardContent>
          </Card>

          {issue.attachments?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Attachments</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {issue.attachments.slice(0, 20).map((a) => (
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
                    {issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}` : 'Unassigned'}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-gray-500">Created</p>
                  <p className="font-medium text-gray-900">
                    {/* Issue model doesn't expose createdAt in this payload; keep this stable. */}
                    {issue.firstResponseAt ? formatDate(issue.firstResponseAt) : '—'}
                  </p>
                </div>
              </div>

              {issue.client && (
                <div>
                  <p className="text-gray-500">Client</p>
                  <Link href={`/dashboard/clients/${issue.client.id}`} className="text-blue-600 hover:underline font-medium">
                    {issue.client.name}
                  </Link>
                </div>
              )}

              {issue.job && (
                <div>
                  <p className="text-gray-500">Job</p>
                  <Link href={`/dashboard/jobs/${issue.job.id}`} className="text-blue-600 hover:underline font-medium">
                    {issue.job.jobNumber} - {issue.job.title}
                  </Link>
                </div>
              )}

              <div>
                <p className="text-gray-500">Type / Priority</p>
                <p className="font-medium text-gray-900">
                  {issue.type} • {issue.priority}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

