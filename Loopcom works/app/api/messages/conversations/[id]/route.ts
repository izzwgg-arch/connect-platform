import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getConversationForMember, listConversationsForUser, listMessages } from '@/lib/chat/service'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const baseConversation = await getConversationForMember(user.tenantId, params.id, user.id)
    if (!baseConversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const cursor = searchParams.get('cursor')
    const limitParam = Number(searchParams.get('limit') || 40)
    const [messages, conversationList] = await Promise.all([
      listMessages(user.tenantId, params.id, user.id, cursor, limitParam),
      listConversationsForUser(user.tenantId, user.id),
    ])

    // Prefer the enriched conversation row so clients always get a user/team display title.
    const enrichedConversation = conversationList.find((item) => item.id === params.id)
    const conversation = enrichedConversation || baseConversation

    return NextResponse.json({
      conversation,
      messages,
    })
  } catch (error) {
    console.error('messages conversation detail GET error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
