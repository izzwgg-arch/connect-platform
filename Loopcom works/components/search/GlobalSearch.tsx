'use client'

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  Search,
  X,
  Loader2,
  Users,
  Building2,
  FileText,
  Receipt,
  CreditCard,
  ShoppingCart,
  Package,
  Briefcase,
  CheckSquare,
  Paperclip,
  StickyNote,
} from 'lucide-react'
import type { SearchGroup } from '@/lib/search/global-search'
import { pushReturnTo } from '@/lib/navigation/nav-stack'

// ── icons & colours per entity type ─────────────────────────────────────────

const ENTITY_META: Record<
  string,
  { icon: React.FC<{ className?: string }>; colour: string }
> = {
  customer:      { icon: Users,         colour: 'text-blue-600 bg-blue-50' },
  contact:       { icon: Users,         colour: 'text-blue-600 bg-blue-50' },
  vendor:        { icon: Building2,     colour: 'text-purple-600 bg-purple-50' },
  estimate:      { icon: FileText,      colour: 'text-green-600 bg-green-50' },
  invoice:       { icon: Receipt,       colour: 'text-amber-600 bg-amber-50' },
  payment:       { icon: CreditCard,    colour: 'text-emerald-600 bg-emerald-50' },
  purchaseOrder: { icon: ShoppingCart,  colour: 'text-orange-600 bg-orange-50' },
  item:          { icon: Package,       colour: 'text-cyan-600 bg-cyan-50' },
  job:           { icon: Briefcase,     colour: 'text-indigo-600 bg-indigo-50' },
  task:          { icon: CheckSquare,   colour: 'text-rose-600 bg-rose-50' },
  file:          { icon: Paperclip,     colour: 'text-slate-600 bg-slate-100' },
  note:          { icon: StickyNote,    colour: 'text-yellow-600 bg-yellow-50' },
}

function EntityIcon({ type }: { type: string }) {
  const meta = ENTITY_META[type] ?? ENTITY_META['item']
  const Icon = meta.icon
  return (
    <span
      className={`inline-flex items-center justify-center w-6 h-6 rounded shrink-0 ${meta.colour}`}
    >
      <Icon className="w-3 h-3" />
    </span>
  )
}

interface FlatResult {
  id: string
  entityType: string
  title: string
  subtitle: string
  url: string
  score: number
}

// ── component ─────────────────────────────────────────────────────────────────

export function GlobalSearch() {
  const [query, setQuery]       = useState('')
  const [groups, setGroups]     = useState<SearchGroup[]>([])
  const [loading, setLoading]   = useState(false)
  const [open, setOpen]         = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)

  const inputRef    = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const router      = useRouter()

  // Ctrl/Cmd+K → focus the bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Click outside → close dropdown
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Debounced search
  useEffect(() => {
    if (!query || query.trim().length < 2) {
      setGroups([])
      setActiveIdx(-1)
      return
    }
    setLoading(true)
    const timer = setTimeout(() => doSearch(query.trim()), 280)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const doSearch = useCallback(async (q: string) => {
    try {
      const token = localStorage.getItem('accessToken') ?? ''
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&limit=8`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (res.ok) {
        const data = await res.json()
        setGroups(data.groups ?? [])
        setActiveIdx(-1)
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  const flat = useMemo<FlatResult[]>(
    () => groups.flatMap((g) => g.results.map((r) => ({ ...r }))),
    [groups]
  )

  const navigate = useCallback(
    (url: string) => {
      setOpen(false)
      setQuery('')
      setGroups([])
      pushReturnTo()
      router.push(url)
    },
    [router]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, -1))
      return
    }
    if (e.key === 'Enter' && activeIdx >= 0 && flat[activeIdx]) {
      navigate(flat[activeIdx].url)
    }
  }

  const showDropdown = open && (query.trim().length >= 2)
  const hasResults   = groups.length > 0
  const showEmpty    = showDropdown && !loading && !hasResults

  let globalIdx = 0

  return (
    <div ref={containerRef} className="relative w-full">
      {/* ── search input ─────────────────────────────────────────────── */}
      <div className="relative flex items-center">
        {loading
          ? <Loader2 className="absolute left-3 h-4 w-4 text-gray-400 animate-spin pointer-events-none" />
          : <Search className="absolute left-3 h-4 w-4 text-gray-400 pointer-events-none" />
        }
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search customers, jobs, invoices…"
          autoComplete="off"
          spellCheck={false}
          className="w-full h-9 pl-9 pr-20 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 transition-all"
        />
        {query ? (
          <button
            onMouseDown={(e) => { e.preventDefault(); setQuery(''); setGroups([]); setOpen(false); inputRef.current?.focus() }}
            className="absolute right-2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <kbd className="absolute right-2 hidden sm:inline-flex items-center gap-0.5 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-400 pointer-events-none">
            <span>⌘</span>K
          </kbd>
        )}
      </div>

      {/* ── dropdown results ─────────────────────────────────────────── */}
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl bg-white border border-gray-200 shadow-xl overflow-hidden max-h-[70vh] overflow-y-auto">

          {showEmpty && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              No results for <span className="font-medium text-gray-600">"{query}"</span>
            </div>
          )}

          {groups.map((group) => (
            <div key={group.type}>
              <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50 border-b border-gray-100">
                {group.label}
              </div>

              {group.results.map((result) => {
                const idx = globalIdx++
                const isActive = idx === activeIdx
                return (
                  <button
                    key={result.id + result.entityType}
                    data-idx={idx}
                    onMouseDown={(e) => { e.preventDefault(); navigate(result.url) }}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                      isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <EntityIcon type={result.entityType} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate leading-tight">
                        {result.title}
                      </div>
                      {result.subtitle && (
                        <div className="text-xs text-gray-500 truncate leading-tight">
                          {result.subtitle}
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          ))}

          {hasResults && (
            <div className="px-3 py-1.5 border-t border-gray-100 bg-gray-50 text-[10px] text-gray-400 flex items-center gap-3">
              <span>↑↓ navigate</span>
              <span>↵ open</span>
              <span>Esc close</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
