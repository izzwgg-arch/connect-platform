'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X, ExternalLink } from 'lucide-react'

interface SyncFailure {
  id: string
  type: string
  action: string
  entityId: string | null
  error: string | null
  createdAt: string
}

const POLL_INTERVAL_MS = 60_000 // 1 minute
const STORAGE_KEY = 'qbo-notified-failure-ids'
const INIT_KEY = 'qbo-notifier-initialized-at'

function loadNotifiedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

function saveNotifiedIds(ids: Set<string>) {
  try {
    // Only keep the last 500 ids to avoid unbounded localStorage growth
    const arr = Array.from(ids).slice(-500)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr))
  } catch {}
}

function friendlyType(type: string) {
  const map: Record<string, string> = {
    estimate: 'Estimate',
    invoice: 'Invoice',
    client: 'Client',
    payment: 'Payment',
    vendor: 'Vendor',
    purchase_order: 'Purchase Order',
    project: 'Project',
    item: 'Item',
  }
  return map[type] ?? type
}

export function QboSyncFailureNotifier() {
  const [visibleFailures, setVisibleFailures] = useState<SyncFailure[]>([])
  const notifiedIdsRef = useRef<Set<string>>(new Set())

  const fetchAndNotify = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return

      // Use the timestamp of this session's init as the "since" floor
      const since = localStorage.getItem(INIT_KEY) ?? new Date(Date.now() - 60 * 60 * 1000).toISOString()

      const res = await fetch(`/api/qbo/sync-failures?since=${encodeURIComponent(since)}&limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok) return

      const data = await res.json().catch(() => null)
      if (!Array.isArray(data?.failures)) return

      const notified = notifiedIdsRef.current
      const fresh = (data.failures as SyncFailure[]).filter((f) => !notified.has(f.id))

      if (fresh.length > 0) {
        setVisibleFailures(fresh)
      }
    } catch {}
  }

  useEffect(() => {
    // Record the moment this component mounts so we only alert on failures
    // that happen after the current session started (avoids spamming on every login).
    localStorage.setItem(INIT_KEY, new Date().toISOString())
    notifiedIdsRef.current = loadNotifiedIds()

    fetchAndNotify()
    const timer = setInterval(fetchAndNotify, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dismiss = () => {
    const ids = notifiedIdsRef.current
    for (const f of visibleFailures) ids.add(f.id)
    saveNotifiedIds(ids)
    setVisibleFailures([])
  }

  if (visibleFailures.length === 0) return null

  const count = visibleFailures.length
  // Summarise which entity types failed
  const typesSummary = Array.from(new Set(visibleFailures.map((f) => friendlyType(f.type)))).join(', ')
  // Show the first error message as a hint
  const firstError = visibleFailures[0].error

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed right-4 top-4 z-[200] w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border border-red-300 bg-red-50 p-4 shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-900">
              QuickBooks Sync Failed
            </p>
            <p className="mt-0.5 text-xs text-red-700">
              {count === 1
                ? `1 ${typesSummary} failed to sync.`
                : `${count} items failed to sync (${typesSummary}).`}
            </p>
            {firstError && (
              <p className="mt-1.5 rounded bg-red-100 px-2 py-1 text-xs text-red-800 leading-relaxed line-clamp-3">
                {firstError}
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          aria-label="Dismiss notification"
          className="shrink-0 rounded p-0.5 text-red-600 hover:bg-red-100 hover:text-red-800"
          onClick={dismiss}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Actions */}
      <div className="mt-3 flex items-center gap-3">
        <a
          href="/dashboard/settings/integrations/quickbooks"
          className="flex items-center gap-1 rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
        >
          <ExternalLink className="h-3 w-3" />
          View QBO Settings
        </a>
        <button
          type="button"
          onClick={dismiss}
          className="rounded border border-red-400 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
