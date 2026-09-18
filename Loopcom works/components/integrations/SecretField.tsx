'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Copy, Eye, EyeOff, RefreshCw, AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface SecretFieldProps {
  label: string
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  onRegenerate?: () => Promise<void>
  warningText?: string
}

export function SecretField({
  label,
  value,
  onChange,
  readOnly = false,
  onRegenerate,
  warningText = 'Keep this secret private. Anyone with it can spoof inbound webhooks.',
}: SecretFieldProps) {
  const [visible, setVisible] = useState(true) // Default to visible for webhook secrets
  const [showRegenerateDialog, setShowRegenerateDialog] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy:', error)
      // Fallback for older browsers
      const textArea = document.createElement('textarea')
      textArea.value = value
      textArea.style.position = 'fixed'
      textArea.style.opacity = '0'
      document.body.appendChild(textArea)
      textArea.select()
      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch (err) {
        console.error('Fallback copy failed:', err)
      }
      document.body.removeChild(textArea)
    }
  }

  const handleRegenerate = async () => {
    if (!onRegenerate) return
    setRegenerating(true)
    try {
      await onRegenerate()
      setShowRegenerateDialog(false)
    } catch (error) {
      console.error('Failed to regenerate secret:', error)
      alert('Failed to regenerate secret. Please try again.')
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="secret-field">{label}</Label>
      <div className="flex space-x-2">
        <div className="relative flex-1">
          <Input
            id="secret-field"
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            readOnly={readOnly}
            className="font-mono text-sm"
            placeholder="Auto-generated"
          />
          <button
            type="button"
            onClick={() => setVisible(!visible)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={!value}
          className="shrink-0"
        >
          <Copy className="h-4 w-4 mr-1" />
          {copied ? 'Copied!' : 'Copy'}
        </Button>
        {onRegenerate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowRegenerateDialog(true)}
            className="shrink-0"
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Regenerate
          </Button>
        )}
      </div>
      {warningText && (
        <div className="flex items-start space-x-2 text-sm text-amber-600 bg-amber-50 p-2 rounded">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{warningText}</span>
        </div>
      )}

      <Dialog open={showRegenerateDialog} onOpenChange={setShowRegenerateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate Webhook Secret?</DialogTitle>
            <DialogDescription>
              This will generate a new webhook secret and invalidate the old one. You must update the secret in
              web.whatis with the new value. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRegenerateDialog(false)} disabled={regenerating}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRegenerate} disabled={regenerating}>
              {regenerating ? 'Regenerating...' : 'Yes, Regenerate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
