'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Trash2, Save } from 'lucide-react'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

interface LineItem {
  description: string
  quantity: string
  unitPrice: string
  notes?: string
}

interface JobOption {
  id: string
  jobNumber: string
  title: string
}

export default function EditCreditMemoPage() {
  const params = useParams()
  const router = useRouter()
  const id = params?.id as string
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientName, setClientName] = useState('')
  const [jobId, setJobId] = useState('')
  const [jobs, setJobs] = useState<JobOption[]>([])
  const [title, setTitle] = useState('Credit Memo')
  const [notes, setNotes] = useState('')
  const [taxRate, setTaxRate] = useState('0')
  const [lineItems, setLineItems] = useState<LineItem[]>([])

  useEffect(() => {
    const load = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch(`/api/credit-memos/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          router.push('/dashboard/credit-memos')
          return
        }
        const data = await res.json()
        const cm = data.creditMemo
        if (Number(cm.appliedAmount) > 0 || cm.status === 'VOID') {
          alert('This credit memo can no longer be edited')
          router.push(`/dashboard/credit-memos/${id}`)
          return
        }
        setClientId(cm.client?.id || cm.clientId || '')
        setClientName(cm.client?.companyName || cm.client?.name || '—')
        setJobId(cm.job?.id || cm.jobId || '')
        setTitle(cm.title || 'Credit Memo')
        setNotes(cm.notes || '')
        setTaxRate(String(cm.taxRate || 0))
        setLineItems(
          (cm.lineItems || []).map((li: any) => ({
            description: li.description || '',
            quantity: String(li.quantity ?? 1),
            unitPrice: String(li.unitPrice ?? 0),
            notes: li.notes || '',
          }))
        )
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    if (id) load()
  }, [id, router])

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

  const subtotal = lineItems.reduce(
    (sum, li) => sum + parseFloat(li.quantity || '0') * parseFloat(li.unitPrice || '0'),
    0
  )
  const taxAmount = subtotal * parseFloat(taxRate || '0')
  const total = subtotal + taxAmount

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/credit-memos/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title,
          notes: notes || null,
          jobId: jobId || null,
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
        alert(data.error || 'Failed to save')
        return
      }
      router.push(`/dashboard/credit-memos/${id}`)
    } catch (e) {
      console.error(e)
      alert('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-8 text-center text-gray-500">Loading...</div>

  return (
    <div className="space-y-6">
      <EntityBackButton fallbackHref={`/dashboard/credit-memos/${id}`} />
      <h1 className="text-3xl font-bold text-gray-900">Edit Credit Memo</h1>
      <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Client</Label>
                <p className="mt-1 text-sm font-medium">
                  {clientId ? (
                    <Link href={`/dashboard/clients/${clientId}`} className="text-primary hover:underline">
                      {clientName}
                    </Link>
                  ) : (
                    clientName
                  )}
                </p>
              </div>
              <div>
                <Label>Job</Label>
                <Select
                  value={jobId || '__none__'}
                  onValueChange={(value) => setJobId(value === '__none__' ? '' : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Optional job" />
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
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
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
              <Input type="number" step="0.0001" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </div>
            <div className="flex justify-between text-sm">
              <span>Tax</span>
              <span>${taxAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-t pt-2 font-semibold">
              <span>Total</span>
              <span>${total.toFixed(2)}</span>
            </div>
            <Button type="submit" className="w-full" disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  )
}
