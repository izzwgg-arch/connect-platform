'use client'

import { useCallback, useEffect, useState } from 'react'

export type SortDirection = 'asc' | 'desc'

type PrefsMap = Record<string, unknown>

function storageKey(entity: string) {
  return `trimpro.list.prefs.${entity}`
}

function readPrefs<T extends PrefsMap>(entity: string, defaults: T): T {
  if (typeof window === 'undefined') return defaults
  try {
    const raw = localStorage.getItem(storageKey(entity))
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

function writePrefs<T extends PrefsMap>(entity: string, value: T) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(storageKey(entity), JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/**
 * Persist list preferences (especially sort) in localStorage so they survive
 * leaving the page until the user changes them.
 */
export function useListPreferences<T extends PrefsMap>(entity: string, defaults: T) {
  const [prefs, setPrefsState] = useState<T>(() => readPrefs(entity, defaults))
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setPrefsState(readPrefs(entity, defaults))
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity])

  const setPrefs = useCallback(
    (updates: Partial<T> | ((prev: T) => T)) => {
      setPrefsState((prev) => {
        const next =
          typeof updates === 'function' ? (updates as (p: T) => T)(prev) : { ...prev, ...updates }
        writePrefs(entity, next)
        return next
      })
    },
    [entity]
  )

  return { prefs, setPrefs, hydrated }
}

export function usePersistedSort(
  entity: string,
  defaults: { sortKey: string | null; sortDirection: SortDirection } = {
    sortKey: null,
    sortDirection: 'asc',
  }
) {
  const { prefs, setPrefs, hydrated } = useListPreferences(entity, defaults)

  const setSort = useCallback(
    (sortKey: string, sortDirection: SortDirection) => {
      setPrefs({ sortKey, sortDirection })
    },
    [setPrefs]
  )

  return {
    sortKey: (prefs.sortKey as string | null) ?? null,
    sortDirection: (prefs.sortDirection as SortDirection) || 'asc',
    setSort,
    hydrated,
  }
}
