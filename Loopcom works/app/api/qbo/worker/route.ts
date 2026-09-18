/**
 * QBO sync worker endpoint.
 *
 * Processes pending QboSyncJob entries from the queue.
 * Designed to be called by:
 *   - Vercel Cron (every 5 minutes, configured in vercel.json)
 *   - Internal background triggers after enqueue
 *   - Admin manual run via POST with { tenantId? }
 *
 * Authentication: requires CRON_SECRET in Authorization header (same
 * pattern used by Vercel's built-in cron invocation).
 */
import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { runQboSyncWorker } from '@/lib/qbo/sync-queue'

export const runtime = 'nodejs'
export const maxDuration = 60

function isAuthorized(request: NextRequest): boolean {
  const secret = String(process.env.CRON_SECRET || '').trim()
  if (!secret) return false

  const auth = String(request.headers.get('authorization') || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim()
  const fromQuery = String(request.nextUrl.searchParams.get('secret') || '').trim()
  const provided = token || fromQuery
  if (!provided) return false

  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let tenantId: string | undefined
  try {
    const body = await request.json().catch(() => ({}))
    tenantId = body?.tenantId || undefined
  } catch {}

  try {
    const result = await runQboSyncWorker({ tenantId, limit: 50 })
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    console.error('[QBO Worker] Error running sync worker:', err)
    return NextResponse.json({ error: err?.message || 'Worker error' }, { status: 500 })
  }
}

// Vercel cron invokes via GET with Authorization header.
export async function GET(request: NextRequest) {
  return POST(request)
}
