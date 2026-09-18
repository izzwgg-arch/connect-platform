import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { createOrGetDmConversation } from '@/lib/chat/service'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.send')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const targetUserId = typeof body?.userId === 'string' ? body.userId : ''
    if (!targetUserId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }

    const conversation = await createOrGetDmConversation(user.tenantId, user.id, targetUserId)
    return NextResponse.json({ conversationId: conversation.id, conversation })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 400 })
  }
}
