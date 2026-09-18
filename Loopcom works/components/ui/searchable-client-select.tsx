'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import {
  DROPDOWN_LIST,
  DROPDOWN_PANEL,
  DROPDOWN_SEARCH_INPUT,
  DROPDOWN_SEARCH_WRAP,
  DROPDOWN_TRIGGER,
} from '@/components/ui/dropdown-styles'
import { smartMatch, scoreHaystack } from '@/lib/search/scoring'

type ClientOption = {
  id: string
  name: string
  companyName?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
}

interface SearchableClientSelectProps {
  clients: ClientOption[]
  value: string
  onSelect: (clientId: string) => void
  placeholder?: string
  disabled?: boolean
}

export function SearchableClientSelect({
  clients,
  value,
  onSelect,
  placeholder = 'Select client...',
  disabled = false,
}: SearchableClientSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selectedClient = clients.find((c) => c.id === value) || null

  const filteredClients = useMemo(() => {
    const q = query.trim()
    if (!q) return clients
    return [...clients]
      .filter((client) =>
        smartMatch(q, [client.name, client.companyName, client.email, client.phone, client.address])
      )
      .sort(
        (a, b) =>
          scoreHaystack(q, [b.name, b.companyName], [b.email, b.phone, b.address]) -
          scoreHaystack(q, [a.name, a.companyName], [a.email, a.phone, a.address])
      )
  }, [clients, query])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus())
    } else {
      setQuery('')
    }
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          setOpen((prev) => !prev)
        }}
        className={`${DROPDOWN_TRIGGER} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
        disabled={disabled}
      >
        <span className={selectedClient ? 'text-foreground' : 'text-muted-foreground'}>
          {selectedClient
            ? `${selectedClient.name}${selectedClient.companyName ? ` — ${selectedClient.companyName}` : ''}`
            : placeholder}
        </span>
        <ChevronDown className="h-4 w-4 opacity-70" />
      </button>

      {open && !disabled && (
        <div className={DROPDOWN_PANEL}>
          <div className={DROPDOWN_SEARCH_WRAP}>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search client..."
              className={DROPDOWN_SEARCH_INPUT}
            />
          </div>
          <div className={DROPDOWN_LIST}>
            {filteredClients.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No clients found</div>
            ) : (
              filteredClients.map((client) => {
                const selected = client.id === value
                return (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => {
                      onSelect(client.id)
                      setOpen(false)
                    }}
                    className={`group flex w-full items-start justify-between rounded-sm px-3 py-2 text-left text-sm hover:bg-[#2E4A59] hover:text-white ${
                      selected ? 'bg-[#2E4A59] text-white' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{client.name}</div>
                      <div
                        className={`truncate text-xs ${
                          selected ? 'text-white/90' : 'text-muted-foreground group-hover:text-white'
                        }`}
                      >
                        {[client.companyName, client.email, client.phone, client.address].filter(Boolean).join(' • ') || 'No extra details'}
                      </div>
                    </div>
                    {selected && <Check className="ml-2 h-4 w-4 shrink-0 text-white" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
