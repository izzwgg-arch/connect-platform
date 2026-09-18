'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  Send,
  Download,
  Edit,
  Ban,
  CheckCircle,
  Printer,
  FileText,
} from 'lucide-react'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'
import { ContactRecipientPicker } from '@/components/email/contact-recipient-picker'

interface OpenInvoiceRow {
  id: string
  invoiceNumber: string
  title?: string | null
  balance: number
  jobLabel?: string | null
}

interface CreditMemoDetail {
  id: string
  creditMemoNumber: string
  title: string
  status: string
  subtotal: number
  taxAmount: number
  total: number
  appliedAmount: number
  remainingCredit: number
  creditMemoDate: string
  notes?: string | null
  client?: {
    id: string
    name: string
    companyName?: string | null
    email?: string | null
  } | null
  job?: { id: string; jobNumber: string; title?: string | null } | null
  sourceInvoice?: { id: string; invoiceNumber: string; balance?: number; status?: string } | null
  lineItems: Array<{
    id: string
    description: string
    quantity: number
    unitPrice: number
    total: number
    notes?: string | null
  }>
  applications?: Array<{
    id: string
    amount: number
    createdAt: string
    invoice?: { id: string; invoiceNumber: string } | null
  }>
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  PARTIALLY_APPLIED: 'bg-yellow-100 text-yellow-800',
  APPLIED: 'bg-green-100 text-green-800',
  VOID: 'bg-red-100 text-red-800',
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export default function CreditMemoDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params?.id as string
  const [cm, setCm] = useState<CreditMemoDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showSendModal, setShowSendModal] = useState(false)
  const [sending, setSending] = useState(false)
  const [selectedRecipientEmails, setSelectedRecipientEmails] = useState<string[]>([])
  const [customEmails, setCustomEmails] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [sendMessage, setSendMessage] = useState('')
  const [showApplyModal, setShowApplyModal] = useState(false)
  const [openInvoices, setOpenInvoices] = useState<OpenInvoiceRow[]>([])
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([])
  const [applyAmounts, setApplyAmounts] = useState<Record<string, string>>({})
  const [applying, setApplying] = useState(false)

  const fetchCm = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/credit-memos/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        router.push('/auth/login')
        return
      }
      if (!res.ok) {
        router.push('/dashboard/credit-memos')
        return
      }
      const data = await res.json()
      setCm(data.creditMemo)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) fetchCm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const openPdf = async (opts?: { download?: boolean; print?: boolean }) => {
    const token = localStorage.getItem('accessToken')
    const qs = new URLSearchParams()
    if (opts?.download) qs.set('download', '1')
    if (opts?.print) {
      qs.set('format', 'html')
      qs.set('print', '1')
    }
    const res = await fetch(`/api/credit-memos/${id}/pdf?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      alert('Failed to open PDF')
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    if (opts?.download) {
      const a = document.createElement('a')
      a.href = url
      a.download = `CM-${cm?.creditMemoNumber || id}.pdf`
      a.click()
    } else {
      window.open(url, '_blank')
    }
  }

  const openSend = () => {
    if (!cm) return
    setSelectedRecipientEmails([])
    setCustomEmails('')
    setSendSubject(`Credit Memo ${cm.creditMemoNumber}`)
    setSendMessage('Please find your credit memo attached.')
    setShowSendModal(true)
  }

  const submitSend = async () => {
    if (!cm || sending) return
    const customEmailList = customEmails
      .split(/[,\s;]+/g)
      .map((v) => v.trim())
      .filter(Boolean)
    const emails = Array.from(new Set([...selectedRecipientEmails, ...customEmailList]))
    if (!emails.length) {
      alert('Enter at least one email')
      return
    }
    setSending(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/credit-memos/${id}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          emails,
          subject: sendSubject,
          message: sendMessage,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to send')
        return
      }
      alert('Credit memo sent')
      setShowSendModal(false)
      fetchCm()
    } catch (e) {
      console.error(e)
      alert('Failed to send')
    } finally {
      setSending(false)
    }
  }

  const loadOpenInvoices = async (): Promise<OpenInvoiceRow[]> => {
    if (!cm?.client?.id) return []
    const token = localStorage.getItem('accessToken')
    const res = await fetch(`/api/invoices?clientId=${cm.client.id}&limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.invoices || [])
      .map((inv: any) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        title: inv.title || null,
        balance: Number(inv.balance || 0),
        jobLabel: inv.job
          ? `${inv.job.jobNumber}${inv.job.title ? ` — ${inv.job.title}` : ''}`
          : null,
      }))
      .filter((inv: OpenInvoiceRow) => inv.balance > 0)
      .sort((a: OpenInvoiceRow, b: OpenInvoiceRow) => b.balance - a.balance)
  }

  const buildDefaultAmounts = (invoices: OpenInvoiceRow[], remaining: number) => {
    const amounts: Record<string, string> = {}
    let left = remaining
    for (const inv of invoices) {
      const amt = round2(Math.min(left, inv.balance))
      amounts[inv.id] = amt > 0 ? String(amt) : ''
      left = round2(Math.max(0, left - amt))
    }
    return amounts
  }

  const openApply = async (preferredInvoiceId?: string) => {
    if (!cm?.client?.id) return
    try {
      const open = await loadOpenInvoices()
      setOpenInvoices(open)
      const preferred =
        open.find((inv) => inv.id === preferredInvoiceId) ||
        open.find((inv) => inv.id === cm.sourceInvoice?.id) ||
        open[0]
      const selected = preferred ? [preferred.id] : []
      setSelectedInvoiceIds(selected)
      const amounts = buildDefaultAmounts(open, cm.remainingCredit)
      // Only prefill amounts for selected invoices; clear others for clarity
      const nextAmounts: Record<string, string> = {}
      for (const inv of open) {
        nextAmounts[inv.id] = selected.includes(inv.id) ? amounts[inv.id] || '' : ''
      }
      setApplyAmounts(nextAmounts)
      setShowApplyModal(true)
    } catch (e) {
      console.error(e)
    }
  }

  const toggleInvoiceSelected = (invoiceId: string) => {
    if (!cm) return
    const inv = openInvoices.find((i) => i.id === invoiceId)
    if (!inv) return
    setSelectedInvoiceIds((prev) => {
      const isSelected = prev.includes(invoiceId)
      if (isSelected) {
        setApplyAmounts((amounts) => ({ ...amounts, [invoiceId]: '' }))
        return prev.filter((id) => id !== invoiceId)
      }
      const currentlyAllocated = prev.reduce((sum, id) => {
        return sum + (Number(applyAmounts[id] || 0) || 0)
      }, 0)
      const left = round2(Math.max(0, cm.remainingCredit - currentlyAllocated))
      const defaultAmt = round2(Math.min(left, inv.balance))
      setApplyAmounts((amounts) => ({
        ...amounts,
        [invoiceId]: defaultAmt > 0 ? String(defaultAmt) : String(Math.min(inv.balance, cm.remainingCredit)),
      }))
      return [...prev, invoiceId]
    })
  }

  const selectedApplications = useMemo(() => {
    return selectedInvoiceIds
      .map((invoiceId) => {
        const inv = openInvoices.find((i) => i.id === invoiceId)
        const amount = round2(Number(applyAmounts[invoiceId] || 0))
        return inv && amount > 0 ? { invoiceId, amount, invoice: inv } : null
      })
      .filter(Boolean) as Array<{ invoiceId: string; amount: number; invoice: OpenInvoiceRow }>
  }, [selectedInvoiceIds, applyAmounts, openInvoices])

  const totalSelectedApply = round2(
    selectedApplications.reduce((sum, row) => sum + row.amount, 0)
  )
  const applyOverRemaining = Boolean(cm && totalSelectedApply > cm.remainingCredit + 0.001)

  const submitApply = async (opts?: { invoiceId?: string; amount?: number | null }) => {
    if (applying || !cm) return

    // One-click single apply from summary
    if (opts?.invoiceId) {
      setApplying(true)
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch(`/api/credit-memos/${id}/apply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            invoiceId: opts.invoiceId,
            amount: opts.amount,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          alert(data.error || 'Failed to apply credit')
          return
        }
        setShowApplyModal(false)
        fetchCm()
      } catch (e) {
        console.error(e)
        alert('Failed to apply credit')
      } finally {
        setApplying(false)
      }
      return
    }

    if (!selectedApplications.length) {
      alert('Select at least one invoice and enter an amount')
      return
    }
    if (applyOverRemaining) {
      alert(
        `Total apply amount ${formatCurrency(totalSelectedApply)} exceeds remaining credit ${formatCurrency(cm.remainingCredit)}`
      )
      return
    }
    for (const row of selectedApplications) {
      if (row.amount > row.invoice.balance + 0.001) {
        alert(
          `${row.invoice.invoiceNumber}: amount exceeds invoice balance ${formatCurrency(row.invoice.balance)}`
        )
        return
      }
    }

    setApplying(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/credit-memos/${id}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          applications: selectedApplications.map((row) => ({
            invoiceId: row.invoiceId,
            amount: row.amount,
          })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to apply credit')
        return
      }
      setShowApplyModal(false)
      fetchCm()
    } catch (e) {
      console.error(e)
      alert('Failed to apply credit')
    } finally {
      setApplying(false)
    }
  }

  const voidCm = async () => {
    if (!cm || !confirm(`Void credit memo ${cm.creditMemoNumber}?`)) return
    const token = localStorage.getItem('accessToken')
    const res = await fetch(`/api/credit-memos/${id}/void`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      alert(data.error || 'Failed to void')
      return
    }
    fetchCm()
  }

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>
  }
  if (!cm) {
    return <div className="p-8 text-center text-gray-500">Credit memo not found</div>
  }

  const canEdit = cm.status !== 'VOID' && cm.appliedAmount <= 0
  const canApply = cm.status !== 'VOID' && cm.remainingCredit > 0
  const canVoid = cm.status !== 'VOID' && cm.appliedAmount <= 0
  const clientName = cm.client?.companyName || cm.client?.name || '—'
  const jobName = cm.job
    ? `${cm.job.jobNumber}${cm.job.title ? ` — ${cm.job.title}` : ''}`
    : null

  return (
    <div className="space-y-6">
      <Dialog open={showSendModal} onOpenChange={setShowSendModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Credit Memo</DialogTitle>
            <DialogDescription>
              Choose which contacts should receive this credit memo, or add a custom email below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Recipients</Label>
              <ContactRecipientPicker
                clientId={cm.client?.id || null}
                onSelectionChange={(emails) => setSelectedRecipientEmails(emails)}
                manageContactsHref={cm.client ? `/dashboard/clients/${cm.client.id}/edit` : undefined}
              />
            </div>
            <div className="space-y-2">
              <Label>Additional email(s) (optional)</Label>
              <Input
                value={customEmails}
                onChange={(e) => setCustomEmails(e.target.value)}
                placeholder="someone-else@email.com"
              />
              <p className="text-xs text-muted-foreground">You can enter multiple emails separated by commas.</p>
            </div>
            <div>
              <Label>Subject</Label>
              <Input value={sendSubject} onChange={(e) => setSendSubject(e.target.value)} />
            </div>
            <div>
              <Label>Message</Label>
              <Input value={sendMessage} onChange={(e) => setSendMessage(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendModal(false)} disabled={sending}>
              Cancel
            </Button>
            <Button
              onClick={submitSend}
              disabled={sending || (selectedRecipientEmails.length === 0 && !customEmails.trim())}
            >
              {sending ? 'Sending...' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showApplyModal} onOpenChange={setShowApplyModal}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Apply Credit</DialogTitle>
            <DialogDescription>
              Select one or more invoices and set an amount for each. Remaining credit:{' '}
              {formatCurrency(cm.remainingCredit)}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {openInvoices.length ? (
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {openInvoices.map((inv) => {
                  const selected = selectedInvoiceIds.includes(inv.id)
                  const isSource = cm.sourceInvoice?.id === inv.id
                  return (
                    <div
                      key={inv.id}
                      className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                        selected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-gray-200'
                      }`}
                    >
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 accent-blue-600"
                          checked={selected}
                          onChange={() => toggleInvoiceSelected(inv.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">
                              {inv.invoiceNumber}
                              {isSource ? (
                                <span className="ml-2 text-xs font-normal text-primary">Source</span>
                              ) : null}
                            </span>
                            <span className="font-semibold text-red-600">
                              {formatCurrency(inv.balance)} due
                            </span>
                          </div>
                          {(inv.title || inv.jobLabel) && (
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {[inv.title, inv.jobLabel].filter(Boolean).join(' • ')}
                            </div>
                          )}
                          {selected && (
                            <div className="mt-2 flex items-center gap-2">
                              <Label className="text-xs text-muted-foreground">Amount</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0.01"
                                max={inv.balance}
                                className="h-8 w-28"
                                value={applyAmounts[inv.id] || ''}
                                onChange={(e) =>
                                  setApplyAmounts((prev) => ({
                                    ...prev,
                                    [inv.id]: e.target.value,
                                  }))
                                }
                                onClick={(e) => e.stopPropagation()}
                              />
                              <button
                                type="button"
                                className="text-xs font-medium text-primary hover:underline"
                                onClick={(e) => {
                                  e.preventDefault()
                                  const others = selectedInvoiceIds
                                    .filter((sid) => sid !== inv.id)
                                    .reduce(
                                      (sum, sid) => sum + (Number(applyAmounts[sid] || 0) || 0),
                                      0
                                    )
                                  const maxForThis = round2(
                                    Math.min(inv.balance, Math.max(0, cm.remainingCredit - others))
                                  )
                                  setApplyAmounts((prev) => ({
                                    ...prev,
                                    [inv.id]: String(maxForThis),
                                  }))
                                }}
                              >
                                Max
                              </button>
                            </div>
                          )}
                        </div>
                      </label>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-gray-500">No open invoices for this client.</p>
            )}
            <div
              className={`flex justify-between rounded border px-3 py-2 text-sm ${
                applyOverRemaining ? 'border-red-300 bg-red-50 text-red-700' : 'bg-gray-50'
              }`}
            >
              <span>
                Applying to {selectedApplications.length} invoice
                {selectedApplications.length === 1 ? '' : 's'}
              </span>
              <span className="font-semibold">{formatCurrency(totalSelectedApply)}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyModal(false)} disabled={applying}>
              Cancel
            </Button>
            <Button
              onClick={() => submitApply()}
              disabled={applying || !selectedApplications.length || applyOverRemaining}
            >
              {applying
                ? 'Applying...'
                : totalSelectedApply > 0
                  ? `Apply ${formatCurrency(totalSelectedApply)}`
                  : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <EntityBackButton fallbackHref="/dashboard/credit-memos" />
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-900">{cm.creditMemoNumber}</h1>
            <span
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                statusColors[cm.status] || 'bg-gray-100 text-gray-800'
              }`}
            >
              {cm.status.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="mt-1 text-gray-600">
            {clientName}
            {jobName ? ` • ${jobName}` : ''}
            {cm.sourceInvoice ? ` • From ${cm.sourceInvoice.invoiceNumber}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Link href={`/dashboard/credit-memos/${cm.id}/edit`}>
              <Button variant="outline">
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
            </Link>
          )}
          <Button variant="outline" onClick={() => openPdf()}>
            <FileText className="mr-2 h-4 w-4" />
            View PDF
          </Button>
          <Button variant="outline" onClick={() => openPdf({ download: true })}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </Button>
          <Button variant="outline" onClick={() => openPdf({ print: true })}>
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
          <Button variant="outline" onClick={openSend}>
            <Send className="mr-2 h-4 w-4" />
            Send
          </Button>
          {canApply && (
            <Button onClick={() => openApply()}>
              <CheckCircle className="mr-2 h-4 w-4" />
              Apply Credit
            </Button>
          )}
          {canVoid && (
            <Button variant="destructive" onClick={voidCm}>
              <Ban className="mr-2 h-4 w-4" />
              Void
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Line Items</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 text-left">Item</th>
                    <th className="py-2 text-right">Qty</th>
                    <th className="py-2 text-right">Price</th>
                    <th className="py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {cm.lineItems.map((li) => (
                    <tr key={li.id} className="border-b">
                      <td className="py-2">
                        {li.description}
                        {li.notes ? <div className="text-xs text-gray-500">{li.notes}</div> : null}
                      </td>
                      <td className="py-2 text-right">{li.quantity}</td>
                      <td className="py-2 text-right">{formatCurrency(li.unitPrice)}</td>
                      <td className="py-2 text-right">{formatCurrency(li.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {(cm.applications?.length || 0) > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Applications</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {cm.applications!.map((app) => (
                  <div key={app.id} className="flex justify-between border-b py-2">
                    <span>
                      {app.invoice ? (
                        <Link
                          href={`/dashboard/invoices/${app.invoice.id}`}
                          className="text-primary hover:underline"
                        >
                          {app.invoice.invoiceNumber}
                        </Link>
                      ) : (
                        'Invoice'
                      )}{' '}
                      <span className="text-gray-500">• {formatDate(app.createdAt)}</span>
                    </span>
                    <span className="font-medium">{formatCurrency(app.amount)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Client & Job</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-gray-500">Client</p>
                {cm.client ? (
                  <Link
                    href={`/dashboard/clients/${cm.client.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {clientName}
                  </Link>
                ) : (
                  <p className="font-medium">—</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500">Job</p>
                {cm.job ? (
                  <Link
                    href={`/dashboard/jobs/${cm.job.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {jobName}
                  </Link>
                ) : (
                  <p className="text-gray-500">No job linked</p>
                )}
              </div>
              {cm.sourceInvoice ? (
                <div>
                  <p className="text-xs text-gray-500">Source invoice</p>
                  <Link
                    href={`/dashboard/invoices/${cm.sourceInvoice.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {cm.sourceInvoice.invoiceNumber}
                  </Link>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Date</span>
                <span>{formatDate(cm.creditMemoDate)}</span>
              </div>
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatCurrency(cm.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax</span>
                <span>{formatCurrency(cm.taxAmount || 0)}</span>
              </div>
              <div className="flex justify-between border-t pt-2 font-semibold">
                <span>Total</span>
                <span>{formatCurrency(cm.total)}</span>
              </div>
              <div className="flex justify-between">
                <span>Applied</span>
                <span>{formatCurrency(cm.appliedAmount)}</span>
              </div>
              <div className="flex justify-between text-green-700 font-semibold">
                <span>Remaining</span>
                <span>{formatCurrency(cm.remainingCredit)}</span>
              </div>
              {canApply && cm.sourceInvoice && Number(cm.sourceInvoice.balance || 0) > 0 && (
                <Button
                  className="mt-2 w-full"
                  size="sm"
                  disabled={applying}
                  onClick={() => {
                    const amt = Math.min(
                      cm.remainingCredit,
                      Number(cm.sourceInvoice!.balance || 0)
                    )
                    void submitApply({ invoiceId: cm.sourceInvoice!.id, amount: amt })
                  }}
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {applying
                    ? 'Applying...'
                    : `Apply ${formatCurrency(
                        Math.min(cm.remainingCredit, Number(cm.sourceInvoice.balance || 0))
                      )} to ${cm.sourceInvoice.invoiceNumber}`}
                </Button>
              )}
              {canApply && (
                <Button
                  className="mt-2 w-full"
                  size="sm"
                  variant={
                    cm.sourceInvoice && Number(cm.sourceInvoice.balance || 0) > 0
                      ? 'outline'
                      : 'default'
                  }
                  onClick={() => openApply()}
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Apply to invoices
                </Button>
              )}
              {cm.notes ? (
                <div className="border-t pt-2">
                  <p className="text-xs text-gray-500">Notes</p>
                  <p className="whitespace-pre-wrap">{cm.notes}</p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
