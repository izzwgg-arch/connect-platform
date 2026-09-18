'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  DROPDOWN_EMPTY,
  DROPDOWN_ITEM,
  DROPDOWN_LIST,
  DROPDOWN_PANEL,
  DROPDOWN_SEARCH_WRAP,
  DROPDOWN_TRIGGER,
} from '@/components/ui/dropdown-styles'
import { smartMatch, scoreHaystack } from '@/lib/search/scoring'

export interface SearchableSelectOption {
  value: string
  label: string
}

interface SearchableSelectProps {
  value: string
  options: SearchableSelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  emptyText?: string
}

export function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = 'Select option...',
  emptyText = 'No matches found',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) || null,
    [options, value]
  )

  const filteredOptions = useMemo(() => {
    const q = query.trim()
    if (!q) return options
    return [...options]
      .filter((option) => smartMatch(q, [option.label, option.value]))
      .sort((a, b) => scoreHaystack(q, [b.label], []) - scoreHaystack(q, [a.label], []))
  }, [options, query])

  useEffect(() => {
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onDocumentMouseDown)
    return () => document.removeEventListener('mousedown', onDocumentMouseDown)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={DROPDOWN_TRIGGER}
      >
        <span className={`truncate text-left ${selectedOption ? 'text-foreground' : 'text-muted-foreground'}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown className="h-4 w-4 text-gray-500" />
      </button>

      {open && (
        <div className={DROPDOWN_PANEL}>
          <div className={DROPDOWN_SEARCH_WRAP}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              className="h-9 text-sm"
            />
          </div>
          <div className={DROPDOWN_LIST}>
            {filteredOptions.length === 0 ? (
              <div className={DROPDOWN_EMPTY}>{emptyText}</div>
            ) : (
              filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                    setQuery('')
                  }}
                  className={`${DROPDOWN_ITEM} ${option.value === value ? 'bg-[#2E4A59] text-white' : ''}`}
                >
                  {option.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
