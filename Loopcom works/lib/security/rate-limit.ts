/**
 * Minimal in-process rate limiter.
 *
 * This app runs on a long-lived Node process (pm2), so an in-memory limiter is acceptable as a baseline.
 * If you later move to serverless/multi-instance, swap this for Redis/Upstash.
 */

import { NextRequest, NextResponse } from 'next/server'

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

function getIp(request: NextRequest): string {
  const xf = request.headers.get('x-forwarded-for')
  if (xf) return xf.split(',')[0].trim()
  const xr = request.headers.get('x-real-ip')
  if (xr) return xr.trim()
  return 'unknown'
}

export function rateLimitOrThrow(request: NextRequest, opts: { key: string; limit: number; windowMs: number }) {
  const ip = getIp(request)
  const now = Date.now()
  const bucketKey = `${opts.key}:${ip}`
  const existing = buckets.get(bucketKey)

  if (!existing || existing.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + opts.windowMs })
    return
  }

  existing.count += 1
  if (existing.count > opts.limit) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    const res = NextResponse.json(
      { error: 'Too many requests' },
      { status: 429 }
    )
    res.headers.set('Retry-After', String(retryAfter))
    throw res
  }
}

