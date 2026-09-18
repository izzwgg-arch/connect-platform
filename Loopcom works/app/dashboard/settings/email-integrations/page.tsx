'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Mail, Plus, Save, Send, Trash2 } from 'lucide-react'
import { refreshAccessToken } from '@/lib/auth/client'

interface EmailIntegration {
  id: string
  provider: string
  status: 'ACTIVE' | 'ERROR' | 'DISABLED'
  displayName: string
  fromEmail: string
  fromName: string | null
  replyToEmail: string | null
  isActive: boolean
  lastTestedAt: string | null
  lastError: string | null
  assignmentsCount: number
}

interface AssignmentUser {
  id: string
  email: string
  firstName: string
  lastName: string
  fullName: string
  role: string
  status: string
  integrationId: string | null
}

interface AssignmentIntegrationOption {
  id: string
  displayName: string
  fromEmail: string
  status: string
}

type FormState = {
  id?: string
  displayName: string
  fromEmail: string
  fromName: string
  replyToEmail: string
  smtpUser: string
  smtpAppPassword: string
}

const emptyForm: FormState = {
  displayName: '',
  fromEmail: '',
  fromName: '',
  replyToEmail: '',
  smtpUser: '',
  smtpAppPassword: '',
}

export default function EmailIntegrationsPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [integrations, setIntegrations] = useState<EmailIntegration[]>([])
  const [assignmentUsers, setAssignmentUsers] = useState<AssignmentUser[]>([])
  const [assignmentIntegrations, setAssignmentIntegrations] = useState<AssignmentIntegrationOption[]>([])
  const [fallbackSender, setFallbackSender] = useState<any>(null)
  const [form, setForm] = useState<FormState>(emptyForm)

  const isEditing = Boolean(form.id)

  const integrationMap = useMemo(() => {
    return new Map(assignmentIntegrations.map((i) => [i.id, i]))
  }, [assignmentIntegrations])

  const authFetch = async (url: string, init?: RequestInit) => {
    let token = localStorage.getItem('accessToken')
    if (!token) {
      const refreshed = await refreshAccessToken()
      if (!refreshed) {
        router.push('/auth/login')
        return null
      }
      token = localStorage.getItem('accessToken')
    }

    let response = await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })

    if (response.status === 401) {
      const refreshed = await refreshAccessToken()
      if (!refreshed) {
        router.push('/auth/login')
        return null
      }
      token = localStorage.getItem('accessToken')
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        },
      })
    }
    return response
  }

  const loadData = async () => {
    setLoading(true)
    try {
      const [integrationsRes, assignmentsRes] = await Promise.all([
        authFetch('/api/email-integrations'),
        authFetch('/api/email-integrations/assignments'),
      ])
      if (!integrationsRes || !assignmentsRes) return

      if (!integrationsRes.ok) {
        if (integrationsRes.status === 403) {
          alert('Only admins can manage email integrations.')
        } else {
          alert('Failed to load email integrations.')
        }
        return
      }
      if (!assignmentsRes.ok) {
        alert('Failed to load user assignments.')
        return
      }

      const integrationsData = await integrationsRes.json()
      const assignmentsData = await assignmentsRes.json()
      setIntegrations(integrationsData.integrations || [])
      setFallbackSender(integrationsData.fallbackSender || null)
      setAssignmentUsers(assignmentsData.users || [])
      setAssignmentIntegrations(assignmentsData.integrations || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const resetForm = () => setForm(emptyForm)

  const saveIntegration = async () => {
    setSaving(true)
    try {
      const url = isEditing ? `/api/email-integrations/${form.id}` : '/api/email-integrations'
      const method = isEditing ? 'PATCH' : 'POST'
      const payload: any = {
        displayName: form.displayName,
        fromEmail: form.fromEmail,
        fromName: form.fromName || undefined,
        replyToEmail: form.replyToEmail || undefined,
        smtpUser: form.smtpUser || undefined,
        smtpAppPassword: form.smtpAppPassword || undefined,
      }

      const response = await authFetch(url, { method, body: JSON.stringify(payload) })
      if (!response) return
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(result.error || 'Failed to save integration.')
        return
      }
      resetForm()
      await loadData()
    } finally {
      setSaving(false)
    }
  }

  const deleteIntegration = async (id: string) => {
    if (!confirm('Delete this integration and unassign it from all users?')) return
    const response = await authFetch(`/api/email-integrations/${id}`, { method: 'DELETE' })
    if (!response) return
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      alert(data.error || 'Failed to delete integration.')
      return
    }
    await loadData()
  }

  const testIntegration = async (id: string) => {
    const toEmail = prompt('Send test email to (leave blank to send to your own email):') || undefined
    const response = await authFetch(`/api/email-integrations/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ toEmail }),
    })
    if (!response) return
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      alert(data.error || 'Test failed.')
      return
    }
    alert(data.message || 'Test email sent.')
    await loadData()
  }

  const updateAssignment = async (userId: string, integrationId: string | null) => {
    const response = await authFetch('/api/email-integrations/assignments', {
      method: 'PUT',
      body: JSON.stringify({ userId, integrationId }),
    })
    if (!response) return
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      alert(data.error || 'Failed to update assignment.')
      return
    }
    setAssignmentUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, integrationId } : u))
    )
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-600">Loading email integrations...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <EntityBackButton fallbackHref="/dashboard/settings/integrations" />
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Email Integrations</h1>
            <p className="text-gray-600">Invoice and estimate sender overrides by user assignment.</p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Sender Rules
          </CardTitle>
          <CardDescription>
            System email remains default for platform mail and fallback for invoice/estimate when no user assignment exists.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-gray-700">
          <p>
            System sender: <strong>{fallbackSender?.fromEmail || 'noreply@trimpro.com'}</strong>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{isEditing ? 'Edit Integration' : 'Add Integration'}</CardTitle>
          <CardDescription>Google Workspace SMTP credentials are encrypted at rest.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div>
            <Label>Display Name</Label>
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Accounting Team" />
          </div>
          <div>
            <Label>From Email</Label>
            <Input value={form.fromEmail} onChange={(e) => setForm({ ...form, fromEmail: e.target.value })} placeholder="billing@company.com" />
          </div>
          <div>
            <Label>From Name</Label>
            <Input value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} placeholder="TrimPro Billing" />
          </div>
          <div>
            <Label>Reply-To (optional)</Label>
            <Input value={form.replyToEmail} onChange={(e) => setForm({ ...form, replyToEmail: e.target.value })} placeholder="support@company.com" />
          </div>
          <div>
            <Label>SMTP User (Google Workspace)</Label>
            <Input value={form.smtpUser} onChange={(e) => setForm({ ...form, smtpUser: e.target.value })} placeholder="billing@company.com" />
          </div>
          <div>
            <Label>SMTP App Password {isEditing ? '(optional)' : ''}</Label>
            <Input type="password" value={form.smtpAppPassword} onChange={(e) => setForm({ ...form, smtpAppPassword: e.target.value })} placeholder="16-character app password" />
          </div>
          <div className="md:col-span-2 flex gap-2">
            <Button onClick={saveIntegration} disabled={saving}>
              {isEditing ? <Save className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
              {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Integration'}
            </Button>
            {isEditing && (
              <Button variant="outline" onClick={resetForm}>
                Cancel Edit
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configured Accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {integrations.length === 0 && <p className="text-sm text-gray-500">No email integrations configured yet.</p>}
          {integrations.map((integration) => (
            <div key={integration.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{integration.displayName}</p>
                  <p className="text-sm text-gray-600">{integration.fromEmail}</p>
                  <p className="text-xs text-gray-500">Assigned users: {integration.assignmentsCount}{' \u2022 '}Status: {integration.status}</p>
                  {integration.lastError && <p className="text-xs text-red-600 mt-1">{integration.lastError}</p>}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setForm({
                        id: integration.id,
                        displayName: integration.displayName,
                        fromEmail: integration.fromEmail,
                        fromName: integration.fromName || '',
                        replyToEmail: integration.replyToEmail || '',
                        smtpUser: '',
                        smtpAppPassword: '',
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => testIntegration(integration.id)}>
                    <Send className="mr-1 h-3 w-3" />
                    Test
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => deleteIntegration(integration.id)}>
                    <Trash2 className="mr-1 h-3 w-3" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>User Assignments</CardTitle>
          <CardDescription>
            Assigned integration overrides sender for invoice/estimate sends only. Unassigned users use system fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {assignmentUsers.map((user) => (
            <div key={user.id} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center border rounded-md p-3">
              <div>
                <p className="font-medium">{user.fullName}</p>
                <p className="text-xs text-gray-600">{user.email}{' \u2022 '}{user.role}</p>
              </div>
              <div className="md:col-span-2">
                <Select
                  value={user.integrationId || '__none'}
                  onValueChange={(value) => updateAssignment(user.id, value === '__none' ? null : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="System fallback sender" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">System fallback sender</SelectItem>
                    {assignmentIntegrations.map((integration) => (
                      <SelectItem key={integration.id} value={integration.id}>
                        {integration.displayName} ({integration.fromEmail})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {user.integrationId && integrationMap.get(user.integrationId) ? (
                  <p className="text-xs text-gray-500 mt-1">
                    Uses {integrationMap.get(user.integrationId)?.fromEmail} for invoice/estimate sends.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">Uses system sender fallback.</p>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
