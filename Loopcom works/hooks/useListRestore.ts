'use client'

import { useEffect, useState } from 'react'
import { clearListHighlight, readListSession } from '@/lib/navigation/nav-stack'

function scrollRowIntoView(id: string): boolean {
  const el = document.querySelector(`[data-row-id="${CSS.escape(id)}"]`) as HTMLElement | null
  if (!el) return false

  // Dashboard scrolls inside <main>, not the window.
  const main = document.querySelector('main.overflow-y-auto') as HTMLElement | null
  if (main) {
    const mainRect = main.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const delta = elRect.top - mainRect.top - main.clientHeight / 2 + elRect.height / 2
    main.scrollBy({ top: delta, behavior: 'smooth' })
  } else {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  return true
}

/**
 * After returning to a list, restore page/scroll and highlight the last-opened row.
 * Waits until list rows are in the DOM before scrolling.
 */
export function useListRestore(
  entity: string,
  options?: {
    highlightMs?: number
    /** Set true once the current page of rows has finished loading. */
    ready?: boolean
  }
) {
  const highlightMs = options?.highlightMs ?? 4500
  const ready = options?.ready ?? true
  const initial = typeof window !== 'undefined' ? readListSession(entity) : null
  const [highlightedId, setHighlightedId] = useState<string | null>(initial?.lastOpenedId || null)
  const restoredPage =
    typeof initial?.page === 'number' && initial.page > 0 ? initial.page : null

  useEffect(() => {
    if (!ready || !highlightedId) return

    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setInterval> | null = null

    const finish = () => {
      window.setTimeout(() => {
        if (cancelled) return
        setHighlightedId(null)
        clearListHighlight(entity)
      }, highlightMs)
    }

    const tryScroll = () => {
      if (cancelled) return true
      attempts += 1
      if (scrollRowIntoView(highlightedId)) {
        if (timer) clearInterval(timer)
        finish()
        return true
      }
      if (attempts >= 60) {
        if (timer) clearInterval(timer)
        finish()
        return true
      }
      return false
    }

    // Rows often mount after fetch — retry briefly.
    if (!tryScroll()) {
      timer = setInterval(tryScroll, 50)
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [entity, highlightMs, highlightedId, ready])

  return { highlightedId, restoredPage, savedScrollY: initial?.scrollY ?? null }
}
