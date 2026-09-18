'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Mail, Users } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { splitEmailList } from '@/lib/email'

export interface RecipientOption {
  id: string
  name: string
  email: string
  isPrimary?: boolean
  source: 'client' | 'contact'
}

interface ClientPickerContact {
  id: string
  firstName: string
  lastName: string
  email: string | null
  isPrimary?: boolean
}

interface ClientPickerResponse {
  client?: {
    id: string
    name: string
    email: string | null
    contacts?: ClientPickerContact[]
  }
}

interface ContactRecipientPickerProps {
  /** When provided, the picker fetches the client's contacts + email(s) on file. */
  clientId?: string | null
  /**
   * Alternative to `clientId`: a pre-built list of recipient options. Useful when the
   * caller already has this data loaded and wants to avoid an extra fetch. This value
   * should be a stable/memoized reference — it is only re-read when its identity changes.
   */
  recipients?: RecipientOption[]
  /** Called whenever the selection changes, with the deduped list of emails and the underlying options. */
  onSelectionChange: (emails: string[], selected: RecipientOption[]) => void
  disabled?: boolean
  className?: string
  /** Link shown in the empty state to let the user go add a contact. Defaults to the client's edit page. */
  manageContactsHref?: string
}

function dedupeOptions(options: RecipientOption[]): RecipientOption[] {
  const seen = new Set<string>()
  const result: RecipientOption[] = []
  for (const option of options) {
    const key = option.email.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(option)
  }
  return result
}

function buildOptionsFromClient(client: ClientPickerResponse['client']): RecipientOption[] {
  if (!client) return []

  const contactOptions: RecipientOption[] = (client.contacts || [])
    .filter((c) => Boolean(String(c.email || '').trim()))
    .map((c) => ({
      id: `contact:${c.id}`,
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Contact',
      email: String(c.email).trim(),
      isPrimary: Boolean(c.isPrimary),
      source: 'contact' as const,
    }))

  const clientEmailOptions: RecipientOption[] = splitEmailList(client.email || '').map((email, idx) => ({
    id: `client:${idx}`,
    name: client.name || 'Client',
    email,
    source: 'client' as const,
  }))

  // Contacts take priority over the generic client email(s) when an address is shared.
  return dedupeOptions([...contactOptions, ...clientEmailOptions])
}

export function ContactRecipientPicker({
  clientId,
  recipients,
  onSelectionChange,
  disabled = false,
  className = '',
  manageContactsHref,
}: ContactRecipientPickerProps) {
  const [options, setOptions] = useState<RecipientOption[]>(recipients ? dedupeOptions(recipients) : [])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<boolean>(Boolean(clientId) && !recipients)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (recipients) {
      setOptions(dedupeOptions(recipients))
      setSelectedIds(new Set())
      setLoading(false)
      setError(null)
      return
    }

    if (!clientId) {
      setOptions([])
      setSelectedIds(new Set())
      setLoading(false)
      return
    }

    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch(`/api/clients/${clientId}/picker`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          cache: 'no-store',
        })
        if (!res.ok) {
          throw new Error('Failed to load contacts')
        }
        const data: ClientPickerResponse = await res.json()
        if (cancelled) return
        setOptions(buildOptionsFromClient(data.client))
        setSelectedIds(new Set())
      } catch (e) {
        console.error('Failed to load recipient contacts:', e)
        if (!cancelled) {
          setOptions([])
          setError('Failed to load contacts for this client.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, recipients])

  const emitSelection = (ids: Set<string>, currentOptions: RecipientOption[]) => {
    const selected = currentOptions.filter((o) => ids.has(o.id))
    const emails = Array.from(new Set(selected.map((o) => o.email)))
    onSelectionChange(emails, selected)
  }

  const toggleOption = (id: string) => {
    if (disabled) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      emitSelection(next, options)
      return next
    })
  }

  const selectAll = () => {
    if (disabled) return
    const next = new Set(options.map((o) => o.id))
    setSelectedIds(next)
    emitSelection(next, options)
  }

  const selectNone = () => {
    if (disabled) return
    const next = new Set<string>()
    setSelectedIds(next)
    emitSelection(next, options)
  }

  if (loading) {
    return (
      <div className={`rounded-md border p-3 text-sm text-muted-foreground ${className}`}>
        Loading contacts...
      </div>
    )
  }

  if (error) {
    return (
      <div className={`rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 ${className}`}>
        {error}
      </div>
    )
  }

  if (options.length === 0) {
    return (
      <div className={`rounded-md border border-dashed p-3 text-sm text-muted-foreground ${className}`}>
        <div className="flex items-start gap-2">
          <Users className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>No contacts with an email address on file for this client yet.</p>
            {manageContactsHref && (
              <Link href={manageContactsHref} className="text-primary hover:underline">
                Add a contact
              </Link>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {selectedIds.size} of {options.length} selected
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={selectAll}
            disabled={disabled}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={selectNone}
            disabled={disabled}
            className="text-xs font-medium text-muted-foreground hover:underline disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm hover:bg-gray-50"
          >
            <Checkbox
              checked={selectedIds.has(option.id)}
              onCheckedChange={() => toggleOption(option.id)}
              disabled={disabled}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-gray-900">{option.name}</span>
                {option.isPrimary && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-700">
                    Primary
                  </span>
                )}
                {option.source === 'client' && (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-600">
                    Client
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
                <Mail className="h-3 w-3" />
                {option.email}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

export default ContactRecipientPicker
