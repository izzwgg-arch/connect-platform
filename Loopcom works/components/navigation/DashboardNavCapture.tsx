'use client'

import { useEffect } from 'react'
import { isTransientPath, pushReturnTo, rememberListSession } from '@/lib/navigation/nav-stack'

/**
 * Captures in-app dashboard link clicks and stamps the current page
 * so EntityBackButton can return to the real previous context.
 * Skips /edit and /new hops so form steps don't pollute the return stack.
 * Also remembers list → detail opens for scroll/highlight restore.
 */
export function DashboardNavCapture() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const target = event.target as HTMLElement | null
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return

      const hrefAttr = anchor.getAttribute('href')
      if (!hrefAttr || hrefAttr.startsWith('#') || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:')) {
        return
      }

      let url: URL
      try {
        url = new URL(hrefAttr, window.location.origin)
      } catch {
        return
      }

      if (url.origin !== window.location.origin) return
      if (!url.pathname.startsWith('/dashboard')) return

      const next = `${url.pathname}${url.search}`
      const current = `${window.location.pathname}${window.location.search}`
      if (next === current) return

      // Leaving an edit/new page via a normal link: don't stamp the transient page.
      if (isTransientPath(window.location.pathname)) return

      // Going into /edit should not stamp (save/cancel returns to detail without polluting stack).
      if (/\/edit(\/|$)/.test(url.pathname)) return

      // Going into /new SHOULD stamp current context (job/client/list) so Back returns there.
      if (/\/new(\/|$)/.test(url.pathname)) {
        pushReturnTo(current)
        return
      }

      const listMatch = window.location.pathname.match(/^\/dashboard\/([a-z0-9-]+)\/?$/)
      const detailMatch = url.pathname.match(/^\/dashboard\/([a-z0-9-]+)\/([^/]+)\/?$/)
      if (
        listMatch &&
        detailMatch &&
        listMatch[1] === detailMatch[1] &&
        !['new', 'edit'].includes(detailMatch[2])
      ) {
        rememberListSession(listMatch[1], {
          lastOpenedId: detailMatch[2],
          scrollY: window.scrollY,
        })
      }

      pushReturnTo(current)
    }

    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  return null
}
