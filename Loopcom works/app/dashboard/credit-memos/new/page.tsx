'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { Plus, Trash2, Save } from 'lucide-react'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

interface JobOption {
  id: string
  jobNumber: string
  title: string
}

interface LineItem {
  description: string
  quantity: string
  unitPrice: string
  notes?: string
}

export default function NewCreditMemoPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const invoiceIdParam = searchParams.get('invoiceId')

  const [saving, setSaving] = useState(false)
  const [clients, setClients] = useState<PickerClient[]>([])
  const [jobs, setJobs] = useState<JobOption[]>([])
  const [clientId, setClientId] = useState('')
  const [jobId, setJobId] = useState('')
  const [sourceInvoiceId, setSourceInvoiceId] = useState(invoiceIdParam || '')
  const [title, setTitle] = useState('Credit Memo')
  const [notes, setNotes] = useState('')
  const [taxRate, setTaxRate] = useState('0')
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: '', quantity: '1', unitPrice: '0' },
  ])

  const selectedClient = clients.find((c) => c.id === clientId) || null
  const clientLabel = selectedClient
    ? selectedClient.companyName || selectedClient.name
    : ''

  useEffect(() => {
    fetchAllPickerClients()
      .then(setClients)
      .catch((e) => console.error('Error fetching clients:', e))
  }, [])

  useEffect(() => {
    if (!clientId) {
      setJobs([])
      return
    }
    const loadJobs = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch(`/api/jobs?clientId=${clientId}&limit=1000`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          setJobs([])
          return
        }
        const data = await res.json()
        setJobs(
          (data.jobs || []).map((j: any) => ({
            id: j.id,
            jobNumber: j.jobNumber,
            title: j.title || '',
          }))
        )
      } catch (e) {
        console.error(e)
        setJobs([])
      }
    }
    loadJobs()
  }, [clientId])

  useEffect(() => {
    if (!invoiceIdParam) return
    const loadInvoice = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch(`/api/invoices/${invoiceIdParam}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json()
        const inv = data.invoice
        if (!inv) return
        setClientId(inv.clientId || inv.client?.id || '')
        setJobId(inv.jobId || inv.job?.id || '')
        setSourceInvoiceId(inv.id)
        setTitle(`Credit for ${inv.invoiceNumber}`)
        setTaxRate(String(inv.taxRate || 0))
        const lines = (inv.lineItems || [])
          .filter((li: any) => !li.isSubtotal)
          .map((li: any) => ({
            description: li.description || '',
            quantity: String(li.quantity ?? 1),
            unitPrice: String(li.unitPrice ?? 0),
            notes: li.notes || '',
          }))
        if (lines.length) setLineItems(lines)
      } catch (e) {
        console.error(e)
      }
    }
    loadInvoice()
  }, [invoiceIdParam])

  const subtotal = lineItems.reduce(
    (sum, li) => sum + parseFloat(li.quantity || '0') * parseFloat(li.unitPrice || '0'),
    0
  )
  const taxAmount = subtotal * parseFloat(taxRate || '0')
  const total = subtotal + taxAmount

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!clientId) {
      alert('Please select a client')
      return
    }
    setSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch('/api/credit-memos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          clientId,
          jobId: jobId || null,
          sourceInvoiceId: sourceInvoiceId || null,
          title,
          notes: notes || null,
          taxRate: parseFloat(taxRate || '0'),
          lineItems: lineItems.map((li) => ({
            description: li.description,
            quantity: parseFloat(li.quantity || '0'),
            unitPrice: parseFloat(li.unitPrice || '0'),
            notes: li.notes || null,
          })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to create credit memo')
        return
      }
      router.push(`/dashboard/credit-memos/${data.creditMemo.id}`)
    } catch (error) {
      console.error(error)
      alert('Failed to create credit memo')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <EntityBackButton fallbackHref="/dashboard/credit-memos" />
          <h1 className="mt-2 text-3xl font-bold text-gray-900">New Credit Memo</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Client *</Label>
                <SearchableClientSelect
                  clients={clients}
                  value={clientId}
                  onSelect={(value) => {
                    setClientId(value)
                    setJobId('')
                  }}
                  placeholder="Select a client..."
                  disabled={Boolean(invoiceIdParam)}
                />
                {clientLabel ? (
                  <p className="mt-1 text-sm text-gray-600">Selected: {clientLabel}</p>
                ) : null}
              </div>
              <div>
                <Label>Job</Label>
                <Select
                  value={jobId || '__none__'}
                  onValueChange={(value) => setJobId(value === '__none__' ? '' : value)}
                  disabled={!clientId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={clientId ? 'Optional job' : 'Select a client first'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No job</SelectItem>
                    {jobs.map((job) => (
                      <SelectItem key={job.id} value={job.id}>
                        {job.jobNumber}
                        {job.title ? ` — ${job.title}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <Label>Notes</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Line Items</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {lineItems.map((item, index) => (
                <div key={index} className="flex flex-wrap gap-2 rounded border p-2">
                  <Input
                    className="min-w-[180px] flex-1"
                    placeholder="Description"
                    value={item.description}
                    onChange={(e) => {
                      const next = [...lineItems]
                      next[index] = { ...next[index], description: e.target.value }
                      setLineItems(next)
                    }}
                    required
                  />
                  <Input
                    className="w-24"
                    type="number"
                    step="0.01"
                    placeholder="Qty"
                    value={item.quantity}
                    onChange={(e) => {
                      const next = [...lineItems]
                      next[index] = { ...next[index], quantity: e.target.value }
                      setLineItems(next)
                    }}
                    required
                  />
                  <Input
                    className="w-28"
                    type="number"
                    step="0.01"
                    placeholder="Price"
                    value={item.unitPrice}
                    onChange={(e) => {
                      const next = [...lineItems]
                      next[index] = { ...next[index], unitPrice: e.target.value }
                      setLineItems(next)
                    }}
                    required
                  />
                  {lineItems.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setLineItems(lineItems.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setLineItems([...lineItems, { description: '', quantity: '1', unitPrice: '0' }])
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Add line
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Totals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-sm">
                <span>Subtotal</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              <div>
                <Label>Tax rate</Label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                />
              </div>
              <div className="flex justify-between text-sm">
                <span>Tax</span>
                <span>${taxAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between border-t pt-2 text-lg font-semibold">
                <span>Credit total</span>
                <span>${total.toFixed(2)}</span>
              </div>
              <Button type="submit" className="w-full" disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? 'Saving...' : 'Create Credit Memo'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </form>
    </div>
  )
}
