'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatDate } from '@/lib/utils'
import { smartMatch } from '@/lib/search/scoring'
import {
  Mail,
  Plus,
  Send,
  FileText,
  Trash2,
  Edit,
  RefreshCw,
  Eye,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  Filter,
} from 'lucide-react'
import Link from 'next/link'

interface EmailTemplate {
  id: string
  name: string
  subject: string
  body: string
  category: string | null
  variables: Record<string, any> | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface EmailLog {
  id: string
  to: string
  subject: string
  status: string
  createdAt: string
  sentAt: string | null
  user: string | null
  client: string | null
  providerId: string | null
  error: string | null
}

interface Client {
  id: string
  name: string
  email: string | null
  contacts: Array<{
    id: string
    email: string | null
  }>
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  DELIVERED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  BOUNCED: 'bg-orange-100 text-orange-800',
  READ: 'bg-purple-100 text-purple-800',
}

export default function EmailPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'send' | 'templates' | 'log'>('send')
  const [loading, setLoading] = useState(false)
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [emailLog, setEmailLog] = useState<EmailLog[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  // Send form state
  const [toEmails, setToEmails] = useState('')
  const [subject, setSubject] = useState('')
  const [bodyHtml, setBodyHtml] = useState('')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('none')
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({})
  const [selectedClientId, setSelectedClientId] = useState<string>('none')

  // Template form state
  const [showTemplateForm, setShowTemplateForm] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null)
  const [templateForm, setTemplateForm] = useState({
    name: '',
    subject: '',
    body: '',
    category: 'SYSTEM',
  })

  useEffect(() => {
    if (activeTab === 'templates') {
      fetchTemplates()
    } else if (activeTab === 'log') {
      fetchEmailLog()
    }
    if (activeTab === 'send') {
      fetchClients()
      fetchTemplates() // Need templates for selector
    }
  }, [activeTab])

  useEffect(() => {
    if (selectedTemplateId && selectedTemplateId !== 'none') {
      loadTemplate(selectedTemplateId)
    }
  }, [selectedTemplateId])

  useEffect(() => {
    if (selectedClientId && selectedClientId !== 'none') {
      loadClientEmails(selectedClientId)
    }
  }, [selectedClientId])

  const fetchTemplates = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/email/templates', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = await response.json()
        setTemplates(data.templates || [])
      }
    } catch (error) {
      console.error('Failed to fetch templates:', error)
    }
  }

  const fetchEmailLog = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.append('status', statusFilter)
      params.append('page', '1')
      params.append('limit', '100')

      const response = await fetch(`/api/email/log?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = await response.json()
        setEmailLog(data.emails || [])
      }
    } catch (error) {
      console.error('Failed to fetch email log:', error)
    }
  }

  const fetchClients = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/clients?limit=5000', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = await response.json()
        setClients(data.clients || [])
      }
    } catch (error) {
      console.error('Failed to fetch clients:', error)
    }
  }

  const loadTemplate = async (templateId: string) => {
    if (templateId === 'none') return
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/email/templates/${templateId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = await response.json()
        const template = data.template
        setSubject(template.subject)
        setBodyHtml(template.body)

        // Extract variables from template
        const varRegex = /\{\{(\w+)\}\}/g
        const vars: string[] = []
        let match
        while ((match = varRegex.exec(template.body + template.subject)) !== null) {
          if (!vars.includes(match[1])) {
            vars.push(match[1])
          }
        }

        // Initialize template variables
        const varsObj: Record<string, string> = {}
        vars.forEach((v) => {
          varsObj[v] = templateVariables[v] || ''
        })
        setTemplateVariables(varsObj)
      }
    } catch (error) {
      console.error('Failed to load template:', error)
    }
  }

  const loadClientEmails = (clientId: string) => {
    if (clientId === 'none') return
    const client = clients.find((c) => c.id === clientId)
    if (client) {
      const emails: string[] = []
      if (client.email) emails.push(client.email)
      client.contacts?.forEach((contact) => {
        if (contact.email && !emails.includes(contact.email)) {
          emails.push(contact.email)
        }
      })
      setToEmails(emails.join(', '))
    }
  }

  const handleSendEmail = async () => {
    if (!toEmails.trim() || !subject.trim() || !bodyHtml.trim()) {
      alert('Please fill in all required fields')
      return
    }

    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/email/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          to: toEmails.split(',').map((e) => e.trim()),
          subject,
          html: bodyHtml,
          templateId: selectedTemplateId !== 'none' ? selectedTemplateId : undefined,
          variables: Object.keys(templateVariables).length > 0 ? templateVariables : undefined,
          clientId: selectedClientId !== 'none' ? selectedClientId : undefined,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to send email')
        return
      }

      alert('Email sent successfully!')
      setToEmails('')
      setSubject('')
      setBodyHtml('')
      setSelectedTemplateId('none')
      setTemplateVariables({})
      setSelectedClientId('none')
      if (activeTab === 'log') {
        fetchEmailLog()
      }
    } catch (error) {
      console.error('Failed to send email:', error)
      alert('Failed to send email')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveTemplate = async () => {
    if (!templateForm.name || !templateForm.subject || !templateForm.body) {
      alert('Please fill in all required fields')
      return
    }

    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      const url = editingTemplate
        ? `/api/email/templates/${editingTemplate.id}`
        : '/api/email/templates'
      const method = editingTemplate ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(templateForm),
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to save template')
        return
      }

      alert(`Template ${editingTemplate ? 'updated' : 'created'} successfully!`)
      setShowTemplateForm(false)
      setEditingTemplate(null)
      setTemplateForm({ name: '', subject: '', body: '', category: 'SYSTEM' })
      fetchTemplates()
    } catch (error) {
      console.error('Failed to save template:', error)
      alert('Failed to save template')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteTemplate = async (templateId: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/email/templates/${templateId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        alert('Template deleted successfully')
        fetchTemplates()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to delete template')
      }
    } catch (error) {
      console.error('Failed to delete template:', error)
      alert('Failed to delete template')
    }
  }

  const handleRetryEmail = async (emailId: string) => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/email/retry/${emailId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        alert('Email retry initiated')
        fetchEmailLog()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to retry email')
      }
    } catch (error) {
      console.error('Failed to retry email:', error)
      alert('Failed to retry email')
    }
  }

  const filteredLog = emailLog.filter((email) =>
    smartMatch(searchQuery, [email.subject, email.to, email.client])
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Email</h1>
        <p className="mt-1 text-gray-600">Send emails, manage templates, and view email logs</p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
        <TabsList>
          <TabsTrigger value="send">
            <Send className="mr-2 h-4 w-4" />
            Send
          </TabsTrigger>
          <TabsTrigger value="templates">
            <FileText className="mr-2 h-4 w-4" />
            Templates
          </TabsTrigger>
          <TabsTrigger value="log">
            <Mail className="mr-2 h-4 w-4" />
            Log
          </TabsTrigger>
        </TabsList>

        {/* Send Tab */}
        <TabsContent value="send" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Compose Email</CardTitle>
              <CardDescription>Send an email to clients or contacts</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="client">Client (Optional)</Label>
                <Select value={selectedClientId} onValueChange={(value) => setSelectedClientId(value === 'none' ? 'none' : value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a client to auto-fill email addresses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {clients.filter(c => c.id && c.id.trim() !== '').map((client) => (
                      <SelectItem key={client.id} value={client.id}>
                        {client.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="to">To *</Label>
                <Input
                  id="to"
                  type="text"
                  placeholder="email@example.com, another@example.com"
                  value={toEmails}
                  onChange={(e) => setToEmails(e.target.value)}
                  required
                />
                <p className="text-xs text-gray-500 mt-1">Separate multiple emails with commas</p>
              </div>

              <div>
                <Label htmlFor="template">Template (Optional)</Label>
                <Select value={selectedTemplateId} onValueChange={(value) => setSelectedTemplateId(value === 'none' ? 'none' : value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a template to auto-fill" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {templates
                      .filter((t) => t.isActive && t.id && t.id.trim() !== '')
                      .map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              {Object.keys(templateVariables).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Template Variables</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {Object.keys(templateVariables).map((key) => (
                      <div key={key}>
                        <Label htmlFor={`var-${key}`} className="text-xs">
                          {key}
                        </Label>
                        <Input
                          id={`var-${key}`}
                          value={templateVariables[key]}
                          onChange={(e) =>
                            setTemplateVariables({ ...templateVariables, [key]: e.target.value })
                          }
                          placeholder={`Enter value for {{${key}}}`}
                        />
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              <div>
                <Label htmlFor="subject">Subject *</Label>
                <Input
                  id="subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject"
                  required
                />
              </div>

              <div>
                <Label htmlFor="body">Body (HTML) *</Label>
                <Textarea
                  id="body"
                  value={bodyHtml}
                  onChange={(e) => setBodyHtml(e.target.value)}
                  placeholder="<p>Your email content here...</p>"
                  rows={10}
                  required
                />
                <p className="text-xs text-gray-500 mt-1">HTML content supported</p>
              </div>

              <Button onClick={handleSendEmail} disabled={loading} className="w-full">
                <Send className="mr-2 h-4 w-4" />
                {loading ? 'Sending...' : 'Send Email'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Templates Tab */}
        <TabsContent value="templates" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Email Templates</h2>
              <p className="text-sm text-gray-600 mt-1">Create and manage email templates</p>
            </div>
            <Button onClick={() => {
              setShowTemplateForm(true)
              setEditingTemplate(null)
              setTemplateForm({ name: '', subject: '', body: '', category: 'SYSTEM' })
            }}>
              <Plus className="mr-2 h-4 w-4" />
              New Template
            </Button>
          </div>

          {showTemplateForm && (
            <Card>
              <CardHeader>
                <CardTitle>{editingTemplate ? 'Edit Template' : 'New Template'}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="template-name">Name *</Label>
                  <Input
                    id="template-name"
                    value={templateForm.name}
                    onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                    placeholder="Template name"
                  />
                </div>

                <div>
                  <Label htmlFor="template-category">Category</Label>
                  <Select
                    value={templateForm.category}
                    onValueChange={(value) => setTemplateForm({ ...templateForm, category: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SYSTEM">System</SelectItem>
                      <SelectItem value="INVOICE">Invoice</SelectItem>
                      <SelectItem value="DISPATCH">Dispatch</SelectItem>
                      <SelectItem value="MARKETING">Marketing</SelectItem>
                      <SelectItem value="SUPPORT">Support</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="template-subject">Subject *</Label>
                  <Input
                    id="template-subject"
                    value={templateForm.subject}
                    onChange={(e) => setTemplateForm({ ...templateForm, subject: e.target.value })}
                    placeholder="Email subject (use {{variableName}} for variables)"
                  />
                </div>

                <div>
                  <Label htmlFor="template-body">Body (HTML) *</Label>
                  <Textarea
                    id="template-body"
                    value={templateForm.body}
                    onChange={(e) => setTemplateForm({ ...templateForm, body: e.target.value })}
                    placeholder="<p>Email body... Use {{variableName}} for variables</p>"
                    rows={10}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Use {'{{variableName}}'} syntax for variables (e.g., {'{{clientName}}'}, {'{{jobNumber}}'})
                  </p>
                </div>

                <div className="flex space-x-2">
                  <Button onClick={handleSaveTemplate} disabled={loading}>
                    {loading ? 'Saving...' : 'Save Template'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowTemplateForm(false)
                      setEditingTemplate(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {templates.length === 0 ? (
              <Card className="md:col-span-2 lg:col-span-3">
                <CardContent className="pt-6 text-center">
                  <FileText className="mx-auto h-12 w-12 text-gray-400" />
                  <p className="mt-4 text-gray-600">No email templates yet</p>
                  <p className="text-sm text-gray-500 mt-1">Create your first template to get started</p>
                </CardContent>
              </Card>
            ) : (
              templates.map((template) => (
                <Card key={template.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-lg">{template.name}</CardTitle>
                        <CardDescription className="mt-1">{template.category || 'System'}</CardDescription>
                      </div>
                      {!template.isActive && (
                        <span className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-600">Inactive</span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <div className="text-xs font-medium text-gray-500">Subject</div>
                      <div className="text-sm text-gray-700 mt-1">{template.subject}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-gray-500">Body Preview</div>
                      <div className="text-sm text-gray-600 mt-1 line-clamp-2">
                        {template.body.replace(/<[^>]*>/g, '').substring(0, 100)}...
                      </div>
                    </div>
                    <div className="flex space-x-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingTemplate(template)
                          setTemplateForm({
                            name: template.name,
                            subject: template.subject,
                            body: template.body,
                            category: template.category || 'SYSTEM',
                          })
                          setShowTemplateForm(true)
                        }}
                      >
                        <Edit className="h-4 w-4 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteTemplate(template.id)}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>

        {/* Log Tab */}
        <TabsContent value="log" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Email Log</h2>
              <p className="text-sm text-gray-600 mt-1">View sent emails and retry failed ones</p>
            </div>
          </div>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center space-x-4 mb-4">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="Search emails..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="SENT">Sent</SelectItem>
                    <SelectItem value="DELIVERED">Delivered</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                    <SelectItem value="BOUNCED">Bounced</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              {filteredLog.length === 0 ? (
                <div className="text-center py-12">
                  <Mail className="mx-auto h-12 w-12 text-gray-400" />
                  <p className="mt-4 text-gray-600">No emails found</p>
                  <p className="text-sm text-gray-500 mt-1">Sent emails will appear here</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredLog.map((email) => (
                    <div key={email.id} className="p-4 border rounded-lg">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-2">
                            <div className="font-semibold">{email.subject}</div>
                            <span className={`px-2 py-1 text-xs rounded-full ${statusColors[email.status] || 'bg-gray-100 text-gray-800'}`}>
                              {email.status}
                            </span>
                          </div>
                          <div className="text-sm text-gray-600 mt-1">To: {email.to}</div>
                          {email.client && <div className="text-xs text-gray-500 mt-1">Client: {email.client}</div>}
                          <div className="text-xs text-gray-500 mt-1">
                            {email.sentAt ? `Sent: ${formatDate(email.sentAt)}` : `Created: ${formatDate(email.createdAt)}`}
                          </div>
                          {email.error && (
                            <div className="text-xs text-red-600 mt-2">
                              Error: {email.error}
                            </div>
                          )}
                        </div>
                        {email.status === 'FAILED' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRetryEmail(email.id)}
                          >
                            <RefreshCw className="h-4 w-4 mr-1" />
                            Retry
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
