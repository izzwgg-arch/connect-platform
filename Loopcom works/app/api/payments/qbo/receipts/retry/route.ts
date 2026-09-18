import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { retryPendingPaymentReceipts } from '@/lib/qbo/receipts'

function isAuthorized(request: NextRequest): boolean {
  const secret = String(process.env.QBO_ACH_RECONCILE_SECRET || '').trim()
  if (!secret) return false

  const auth = String(request.headers.get('authorization') || '')
  const tokenFromAuth = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  const tokenFromHeader = String(request.headers.get('x-reconcile-secret') || '').trim()
  const tokenFromQuery = String(request.nextUrl.searchParams.get('secret') || '').trim()
  const provided = tokenFromAuth || tokenFromHeader || tokenFromQuery
  if (!provided) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limitRaw = Number(request.nextUrl.searchParams.get('limit') || '50')
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50
  const result = await retryPendingPaymentReceipts(limit)
  return NextResponse.json({ ok: true, ...result })
}
