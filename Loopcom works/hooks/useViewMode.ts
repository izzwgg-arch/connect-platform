'use client'

import { useEffect, useState } from 'react'

export type ViewMode = 'grid' | 'rowCompact' | 'rowDetailed' | 'table'

const VIEW_MODES: ViewMode[] = ['grid', 'rowCompact', 'rowDetailed', 'table']

function isViewMode(value: string | null): value is ViewMode {
  return value !== null && VIEW_MODES.includes(value as ViewMode)
}

export function useViewMode(pageKey: string, defaultMode: ViewMode = 'grid') {
  const [viewMode, setViewMode] = useState<ViewMode>(defaultMode)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = window.localStorage.getItem(`viewMode.${pageKey}`)
    if (isViewMode(saved)) {
      setViewMode(saved)
    }
  }, [pageKey])

  const updateViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`viewMode.${pageKey}`, mode)
    }
  }

  return [viewMode, updateViewMode] as const
}

