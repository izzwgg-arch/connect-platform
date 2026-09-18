import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { enqueueQboSync, type QboEntityType } from '@/lib/qbo/sync-queue'

const EVENT_TO_ENTITY: Record<string, QboEntityType> = {
  'client.created': 'client',
  'request.created': 'lead',
  'job.created': 'job',
  'estimate.created': 'estimate',
  'invoice.created': 'invoice',
  'payment.recorded': 'payment',
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const body = await request.json().catch(() => ({}))
    const event = String(body?.event || '')
    const entityId = String(body?.entityId || '')
    if (!event || !entityId) {
      return NextResponse.json({ error: 'event and entityId are required' }, { status: 400 })
    }

    const entityType = EVENT_TO_ENTITY[event]
    if (!entityType) {
      return NextResponse.json({ error: 'Unsupported event type' }, { status: 400 })
    }

    // Admin-triggered syncs run immediately (synchronous) so the caller sees the result.
    await enqueueQboSync(user.tenantId, entityType, entityId, { processImmediately: true })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('QBO trigger sync error:', error)
    return NextResponse.json({ error: error?.message || 'Trigger sync failed' }, { status: 500 })
  }
}
