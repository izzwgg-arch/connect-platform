'use client'

/**
 * Cross-app navigation helpers:
 * - return stack so Back goes to the previous context (job/client/list), not a hard-coded list
 * - list session restore (last opened row + scroll)
 */

const RETURN_STACK_KEY = 'trimpro.nav.returnStack'
const LIST_SESSION_PREFIX = 'trimpro.list.session.'
const MAX_STACK = 40

function canUseStorage() {
  return typeof window !== 'undefined'
}

function normalizeHref(href: string) {
  try {
    const url = new URL(href, window.location.origin)
    return `${url.pathname}${url.search}`
  } catch {
    return href
  }
}

function currentHref() {
  return `${window.location.pathname}${window.location.search}`
}

function readStack(): string[] {
  if (!canUseStorage()) return []
  try {
    const raw = sessionStorage.getItem(RETURN_STACK_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeStack(stack: string[]) {
  if (!canUseStorage()) return
  sessionStorage.setItem(RETURN_STACK_KEY, JSON.stringify(stack.slice(-MAX_STACK)))
}

/** Record where we are before navigating forward to a child page. */
export function pushReturnTo(href?: string) {
  if (!canUseStorage()) return
  const next = normalizeHref(href || currentHref())
  const stack = readStack()
  if (stack[stack.length - 1] === next) return
  // Avoid pushing ephemeral edit/new hops as return targets
  if (/\/(edit|new)(\?|$)/.test(next)) return
  stack.push(next)
  writeStack(stack)
}

export function peekReturnTo(): string | null {
  const stack = readStack()
  return stack.length ? stack[stack.length - 1] : null
}

export function popReturnTo(): string | null {
  const stack = readStack()
  if (!stack.length) return null
  const prev = stack.pop() || null
  writeStack(stack)
  return prev
}

export function clearReturnStack() {
  if (!canUseStorage()) return
  sessionStorage.removeItem(RETURN_STACK_KEY)
}

/** True when the path is an edit/new form hop we should skip when going “back”. */
export function isTransientPath(pathname: string) {
  return /\/(edit|new)(\/|$)/.test(pathname)
}

export type ListSessionState = {
  lastOpenedId?: string | null
  scrollY?: number
  page?: number
  ts?: number
}

export function rememberListSession(entity: string, state: ListSessionState) {
  if (!canUseStorage() || !entity) return
  try {
    const prev = readListSession(entity) || {}
    sessionStorage.setItem(
      `${LIST_SESSION_PREFIX}${entity}`,
      JSON.stringify({ ...prev, ...state, ts: Date.now() })
    )
  } catch {
    /* ignore quota */
  }
}

export function readListSession(entity: string): ListSessionState | null {
  if (!canUseStorage() || !entity) return null
  try {
    const raw = sessionStorage.getItem(`${LIST_SESSION_PREFIX}${entity}`)
    if (!raw) return null
    return JSON.parse(raw) as ListSessionState
  } catch {
    return null
  }
}

export function clearListHighlight(entity: string) {
  const s = readListSession(entity)
  if (!s) return
  rememberListSession(entity, { ...s, lastOpenedId: null })
}

type RouterLike = {
  push: (href: string) => void
  replace: (href: string) => void
  back: () => void
}

/**
 * Navigate forward while stamping the current page as the return target.
 */
export function navigateWithReturn(router: RouterLike, href: string, options?: { replace?: boolean }) {
  pushReturnTo()
  if (options?.replace) router.replace(href)
  else router.push(href)
}

/**
 * Open a list row detail: stamp return + remember which row to highlight on restore.
 */
export function openFromList(
  router: RouterLike,
  opts: { entity: string; detailHref: string; itemId: string; page?: number }
) {
  rememberListSession(opts.entity, {
    lastOpenedId: opts.itemId,
    scrollY: window.scrollY,
    page: opts.page,
  })
  pushReturnTo()
  router.push(opts.detailHref)
}

/**
 * Smart back:
 * 1) Prefer stamped return stack (job/client/list you came from)
 * 2) Else browser history when same-origin history exists
 * 3) Else fallback list/detail href
 *
 * Edit/new pages should pass parentHref and use mode "parent" so they
 * replace to the parent detail without consuming the return stack.
 */
export function smartBack(
  router: RouterLike,
  opts: {
    fallbackHref: string
    /** When set, go here without popping the return stack (edit → detail). */
    parentHref?: string
    mode?: 'default' | 'parent'
  }
) {
  if (!canUseStorage()) {
    router.push(opts.fallbackHref)
    return
  }

  if (opts.mode === 'parent' && opts.parentHref) {
    router.replace(opts.parentHref)
    return
  }

  const pathname = window.location.pathname
  if (isTransientPath(pathname) && opts.parentHref) {
    router.replace(opts.parentHref)
    return
  }

  // If this detail was opened from its entity list, always return to that list
  // so highlight + scroll restore can run (don't get stuck on unrelated history).
  const detailMatch = pathname.match(/^\/dashboard\/([a-z0-9-]+)\/([^/]+)\/?$/)
  if (opts.mode !== 'parent' && detailMatch) {
    const entity = detailMatch[1]
    const itemId = detailMatch[2]
    const session = readListSession(entity)
    if (session?.lastOpenedId && session.lastOpenedId === itemId) {
      const stamped = popReturnTo()
      const listBase = `/dashboard/${entity}`
      const stampedIsList =
        typeof stamped === 'string' &&
        (stamped === listBase || stamped.startsWith(`${listBase}?`))
      router.push(stampedIsList ? stamped! : listBase)
      return
    }
  }

  const stamped = popReturnTo()
  if (stamped && stamped !== currentHref()) {
    router.push(stamped)
    return
  }

  // Skip landing on edit/new if history would bounce there: prefer fallback when no stamp
  if (window.history.length > 1) {
    router.back()
    return
  }

  router.push(opts.fallbackHref)
}
