import type { NextRequest } from 'next/server'

function isIpHost(host: string) {
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)
}

function isLocalHost(host: string) {
  return host.includes('localhost') || host.includes('127.0.0.1')
}

export function getPublicBaseUrl(request?: NextRequest): string {
  // Prefer the actual request host in local/dev so /uploads stay reachable.
  if (request) {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || ''
    if (host && (isLocalHost(host) || isIpHost(host))) {
      const proto = request.headers.get('x-forwarded-proto') || 'http'
      return `${proto}://${host}`.replace(/\/+$/, '')
    }
  }

  const envUrl =
    process.env.PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    ''

  if (envUrl.trim()) {
    try {
      const parsed = new URL(envUrl.trim())
      if (!isIpHost(parsed.host) && !isLocalHost(parsed.host)) {
        parsed.protocol = 'https:'
        return parsed.toString().replace(/\/+$/, '')
      }
    } catch {
      // fall through
    }
  }

  if (request) {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || ''
    if (host && !isIpHost(host) && !isLocalHost(host)) {
      return `https://${host}`.replace(/\/+$/, '')
    }
  }

  return 'https://app.trimprony.com'
}

export function normalizePublicFileUrl(rawUrl: string, request?: NextRequest): string {
  const value = String(rawUrl || '').trim()
  if (!value) return value

  const base = getPublicBaseUrl(request)

  try {
    const parsed = new URL(value)
    if (isIpHost(parsed.host) || isLocalHost(parsed.host)) {
      return `${base}${parsed.pathname}${parsed.search}`
    }
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    return parsed.toString()
  } catch {
    if (value.startsWith('/')) {
      return `${base}${value}`
    }
    return value
  }
}
