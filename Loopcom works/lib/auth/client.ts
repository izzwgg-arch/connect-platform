// Client-side auth helpers (token storage + refresh).
// Goal: prevent "random logouts" caused by concurrent refresh token rotation.
//
// We rotate refresh tokens on every refresh. If multiple requests refresh at once,
// one of them will succeed and invalidate the old refresh token, and another will
// fail with 401. Without a mutex + retry, the UI often redirects to /auth/login.

let refreshInFlight: Promise<boolean> | null = null

async function refreshWithToken(refreshToken: string): Promise<boolean> {
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, clientType: 'web' }),
  })

  if (!response.ok) return false
  const data = await readResponseJson<{ accessToken?: string; refreshToken?: string }>(response).catch(
    () => null
  )
  if (!data?.accessToken || !data?.refreshToken) return false
  localStorage.setItem('accessToken', data.accessToken)
  localStorage.setItem('refreshToken', data.refreshToken)
  return true
}

export async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const initialRefreshToken = localStorage.getItem('refreshToken')
    if (!initialRefreshToken) return false

    // Attempt refresh with the token we started with.
    let ok = false
    try {
      ok = await refreshWithToken(initialRefreshToken)
    } catch {
      ok = false
    }

    if (ok) return true

    // If refresh failed, we might have raced another refresh (same tab or another tab)
    // that already rotated the refreshToken in localStorage.
    const currentRefreshToken = localStorage.getItem('refreshToken')
    const currentAccessToken = localStorage.getItem('accessToken')

    if (currentRefreshToken && currentRefreshToken !== initialRefreshToken && currentAccessToken) {
      return true
    }

    // One more best-effort retry with the latest refreshToken if it changed.
    if (currentRefreshToken && currentRefreshToken !== initialRefreshToken) {
      try {
        return await refreshWithToken(currentRefreshToken)
      } catch {
        return false
      }
    }

    return false
  })().finally(() => {
    refreshInFlight = null
  })

  return refreshInFlight
}

function buildAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init || {})
  const token = localStorage.getItem('accessToken')
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return headers
}

/**
 * Read a fetch Response as JSON, with a clear error when the server returns HTML
 * (login page, Next error page, proxy page, etc.) instead of JSON.
 */
export async function readResponseJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed) return {} as T

  if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
    throw new Error(`Server returned a web page instead of data (${response.status})`)
  }

  try {
    return JSON.parse(trimmed) as T
  } catch {
    throw new Error(`Invalid server response (${response.status})`)
  }
}

/**
 * Authenticated fetch for dashboard API calls.
 * On 401, refreshes the access token once and retries the request.
 */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const first = await fetch(input, { ...init, headers: buildAuthHeaders(init.headers) })
  if (first.status !== 401) return first

  if (init.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  const refreshed = await refreshAccessToken()
  if (!refreshed) return first

  if (init.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  return fetch(input, { ...init, headers: buildAuthHeaders(init.headers) })
}
