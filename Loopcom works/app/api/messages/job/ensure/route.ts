import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { ensureJobThread, listJobThreadRecipients, listJobThreads } from '@/lib/chat/service'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.send')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const jobId = typeof body?.jobId === 'string' ? body.jobId : ''
    if (!jobId) {
      return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
    }

    const participantIds = Array.isArray(body?.participantIds)
      ? body.participantIds.filter((id: unknown) => typeof id === 'string' && id)
      : undefined
    const title = typeof body?.title === 'string' ? body.title : undefined
    const conversationId =
      typeof body?.conversationId === 'string' ? body.conversationId : undefined

    const conversation = await ensureJobThread(user.tenantId, jobId, user.id, {
      participantIds,
      title,
      conversationId,
    })
    const [recipients, threads] = await Promise.all([
      listJobThreadRecipients(user.tenantId, jobId),
      listJobThreads(user.tenantId, jobId),
    ])

    return NextResponse.json({
      conversationId: conversation.id,
      conversation,
      recipients,
      threads,
    })
  } catch (error: any) {
    const message = String(error?.message || 'Internal server error')
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    console.error('messages job ensure POST error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
