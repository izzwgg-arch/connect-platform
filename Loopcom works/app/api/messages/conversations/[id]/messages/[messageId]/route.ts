import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { deleteMessageInConversation, editMessageInConversation } from '@/lib/chat/service'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; messageId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.edit')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const text = typeof body?.text === 'string' ? body.text : ''
    const updated = await editMessageInConversation(
      {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
      },
      params.id,
      params.messageId,
      text
    )
    return NextResponse.json({ message: updated })
  } catch (error: any) {
    const message = String(error?.message || 'Internal server error')
    if (
      message.includes('not found') ||
      message.includes('only') ||
      message.includes('required') ||
      message.includes('cannot')
    ) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    console.error('message PATCH error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; messageId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.delete')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const modeRaw = String(body?.mode || 'ME').toUpperCase()
    const mode = modeRaw === 'EVERYONE' ? 'EVERYONE' : 'ME'

    await deleteMessageInConversation(
      {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
      },
      params.id,
      params.messageId,
      mode
    )

    return NextResponse.json({ ok: true })
  } catch (error: any) {
    const message = String(error?.message || 'Internal server error')
    if (
      message.includes('not found') ||
      message.includes('only') ||
      message.includes('required') ||
      message.includes('cannot')
    ) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    console.error('message DELETE error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

