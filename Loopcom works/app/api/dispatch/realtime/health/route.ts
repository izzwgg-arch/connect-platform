import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getDispatchRealtimeHealth, getDispatchRealtimeReplay } from '@/lib/dispatch-realtime'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'dispatch.view')
  if (permError) return permError

  const user = getAuthUser(request)
  if (!['ADMIN', 'OFFICE', 'ACCOUNTING'].includes(String(user.role))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const health = await getDispatchRealtimeHealth(user.tenantId)
    const sample = await getDispatchRealtimeReplay(
      user.tenantId,
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      12
    )

    return NextResponse.json({
      ok: true,
      tenantId: user.tenantId,
      health,
      replaySampleCount: sample.length,
      replaySample: sample.map((item) => ({
        id: item.id,
        kind: item.kind,
        ts: item.ts,
        jobId: item.jobId || null,
        eventType: item.eventType || null,
      })),
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Dispatch realtime health error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

