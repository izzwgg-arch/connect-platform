'use client'

import { useState } from 'react'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export type ReportKey = 'revenue' | 'aging' | 'job-profitability' | 'vendor-spend' | 'customer-statement' | 'payments'

interface EmailReportButtonProps {
  report: ReportKey
  /** Current filter query params for the report (startDate, clientId, etc.) — sent as-is to the server. */
  params: Record<string, string>
  /** Prefills the recipient field, e.g. the currently-selected customer's email. Left empty if none. */
  defaultRecipient?: string
  disabled?: boolean
}

export function EmailReportButton({ report, params, defaultRecipient, disabled }: EmailReportButtonProps) {
  const [open, setOpen] = useState(false)
  const [recipients, setRecipients] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setRecipients(defaultRecipient || '')
      setMessage('')
      setError(null)
      setSent(false)
    }
  }

  const handleSend = async () => {
    const list = recipients
      .split(/[,;\s]+/)
      .map((r) => r.trim())
      .filter(Boolean)
    if (list.length === 0) {
      setError('Enter at least one recipient email address.')
      return
    }
    setSending(true)
    setError(null)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch('/api/reports/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ report, params, recipients: list, message: message || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Failed to send report.')
        return
      }
      setSent(true)
    } catch {
      setError('Failed to send report.')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => handleOpenChange(true)}>
        <Mail className="h-4 w-4 mr-1" /> Email
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email Report</DialogTitle>
            <DialogDescription>Sends this report as a PDF attachment.</DialogDescription>
          </DialogHeader>
          {sent ? (
            <div className="py-4 text-sm text-green-700">Report sent to {recipients}.</div>
          ) : (
            <div className="space-y-4 py-2">
              <div>
                <Label htmlFor="report-email-recipients">To</Label>
                <Input
                  id="report-email-recipients"
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="name@example.com, another@example.com"
                />
              </div>
              <div>
                <Label htmlFor="report-email-message">Message (optional)</Label>
                <Textarea
                  id="report-email-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Add a note..."
                />
              </div>
              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          )}
          <DialogFooter>
            {sent ? (
              <Button onClick={() => handleOpenChange(false)}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sending}>
                  Cancel
                </Button>
                <Button onClick={handleSend} disabled={sending}>
                  {sending ? 'Sending...' : 'Send'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
