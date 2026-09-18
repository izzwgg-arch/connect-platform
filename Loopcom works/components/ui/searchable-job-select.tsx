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

export type JobOption = {
  id: string
  jobNumber: string
  title: string
  status?: string | null
  client?: { id?: string; name?: string | null; companyName?: string | null } | null
}

interface SearchableJobSelectProps {
  jobs: JobOption[]
  value: string
  onSelect: (jobId: string) => void
  placeholder?: string
  disabled?: boolean
  allowNone?: boolean
  noneLabel?: string
  /** Optional remote search — called as the user types (debounced). */
  onSearch?: (query: string) => void | Promise<void>
}

function jobLabel(job: JobOption) {
  return `${job.jobNumber} - ${job.title}`
}

function jobSecondary(job: JobOption) {
  const clientName = job.client?.companyName || job.client?.name || ''
  return [clientName, job.status].filter(Boolean).join(' • ')
}

export function SearchableJobSelect({
  jobs,
  value,
  onSelect,
  placeholder = 'Search jobs...',
  disabled = false,
  allowNone = true,
  noneLabel = 'No job',
  onSearch,
}: SearchableJobSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const onSearchRef = useRef(onSearch)
  onSearchRef.current = onSearch
  const remote = Boolean(onSearch)

  const selectedJob = jobs.find((job) => job.id === value) || null

  const filteredJobs = useMemo(() => {
    const q = query.trim()
    // When remote search is wired, trust the provided jobs list (already filtered server-side).
    if (remote) return jobs
    if (!q) return jobs
    return [...jobs]
      .filter((job) =>
        smartMatch(q, [
          job.jobNumber,
          job.title,
          job.status,
          job.client?.name,
          job.client?.companyName,
        ])
      )
      .sort(
        (a, b) =>
          scoreHaystack(
            q,
            [b.jobNumber, b.title],
            [b.client?.name, b.client?.companyName, b.status]
          ) -
          scoreHaystack(
            q,
            [a.jobNumber, a.title],
            [a.client?.name, a.client?.companyName, a.status]
          )
      )
  }, [jobs, query, remote])

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

  useEffect(() => {
    if (!open || !onSearchRef.current) return
    const q = query.trim()
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        await onSearchRef.current?.(q)
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

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
        <span className={selectedJob ? 'text-foreground' : 'text-muted-foreground'}>
          {selectedJob ? jobLabel(selectedJob) : placeholder}
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
              placeholder="Search by job #, title, or client..."
              className={DROPDOWN_SEARCH_INPUT}
            />
          </div>
          <div className={DROPDOWN_LIST}>
            {allowNone && (
              <button
                type="button"
                onClick={() => {
                  onSelect('')
                  setOpen(false)
                }}
                className={`group flex w-full items-start justify-between rounded-sm px-3 py-2 text-left text-sm hover:bg-[#2E4A59] hover:text-white ${
                  !value ? 'bg-[#2E4A59] text-white' : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{noneLabel}</div>
                </div>
                {!value && <Check className="ml-2 h-4 w-4 shrink-0 text-white" />}
              </button>
            )}
            {filteredJobs.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {searching ? 'Searching…' : 'No jobs found'}
              </div>
            ) : (
              filteredJobs.map((job) => {
                const selected = job.id === value
                const secondary = jobSecondary(job)
                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => {
                      onSelect(job.id)
                      setOpen(false)
                    }}
                    className={`group flex w-full items-start justify-between rounded-sm px-3 py-2 text-left text-sm hover:bg-[#2E4A59] hover:text-white ${
                      selected ? 'bg-[#2E4A59] text-white' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{jobLabel(job)}</div>
                      {secondary ? (
                        <div
                          className={`truncate text-xs ${
                            selected ? 'text-white/90' : 'text-muted-foreground group-hover:text-white'
                          }`}
                        >
                          {secondary}
                        </div>
                      ) : null}
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
