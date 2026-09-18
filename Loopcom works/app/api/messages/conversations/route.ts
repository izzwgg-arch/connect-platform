import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { listConversationsForUser } from '@/lib/chat/service'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const conversations = await listConversationsForUser(user.tenantId, user.id)
    return NextResponse.json({ conversations })
  } catch (error) {
    console.error('messages conversations GET error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
