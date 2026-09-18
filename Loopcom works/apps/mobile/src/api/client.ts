import { API_BASE_URL } from '../config/env'
import { getAccessToken, getOrCreateDeviceId, getRefreshToken, saveTokens } from '../auth/secure-storage'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const DEFAULT_FETCH_TIMEOUT_MS = 15_000

let unauthorizedHandler: (() => void) | null = null
let refreshInFlight: Promise<boolean> | null = null

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function refreshAccessTokenSilently(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const refreshToken = await getRefreshToken()
    if (!refreshToken) {
      console.info('[auth] refresh skipped: no refresh token')
      return false
    }

    try {
      console.info('[auth] refresh attempt started')
      const deviceId = await getOrCreateDeviceId()
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'TrimProMobile',
        },
        body: JSON.stringify({ refreshToken, deviceId, clientType: 'mobile' }),
      })

      if (!response.ok) {
        console.warn(`[auth] refresh failed with status ${response.status}`)
        return false
      }

      const payload = (await response.json()) as { accessToken?: string; refreshToken?: string }
      if (!payload.accessToken || !payload.refreshToken) {
        console.warn('[auth] refresh failed: missing tokens in response')
        return false
      }

      await saveTokens(payload.accessToken, payload.refreshToken)
      console.info('[auth] refresh success')
      return true
    } catch (error) {
      console.warn('[auth] refresh error', error)
      return false
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

export async function getValidAccessToken(forceRefresh = false): Promise<string | null> {
  const current = await getAccessToken()
  if (current && !forceRefresh) return current

  const refreshed = await refreshAccessTokenSilently()
  if (!refreshed) {
    return forceRefresh ? null : current || null
  }
  return (await getAccessToken()) || null
}

export async function apiRequest<T>(
  path: string,
  method: HttpMethod = 'GET',
  body?: unknown,
  extraHeaders?: Record<string, string>,
  hasRetried = false
): Promise<T> {
  const token = await getAccessToken()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'TrimProMobile',
    ...(extraHeaders || {}),
  }

  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })

  if (response.status === 401 && !hasRetried) {
    const refreshToken = await getRefreshToken()
    const shouldAttemptRefresh = Boolean(token) || Boolean(refreshToken)
    const refreshed = shouldAttemptRefresh ? await refreshAccessTokenSilently() : false
    if (refreshed) {
      return apiRequest<T>(path, method, body, extraHeaders, true)
    }
    if (unauthorizedHandler && Boolean(token || refreshToken)) {
      console.warn('[auth] forced logout after refresh failure')
      unauthorizedHandler()
    }
  } else if (response.status === 401 && unauthorizedHandler && Boolean(token)) {
    unauthorizedHandler()
  }

  if (!response.ok) {
    const errorPayload = await response
      .json()
      .catch(() => ({ error: `Request failed with status ${response.status}` }))
    throw new Error(errorPayload?.error || `Request failed with status ${response.status}`)
  }

  return (await response.json()) as T
}

