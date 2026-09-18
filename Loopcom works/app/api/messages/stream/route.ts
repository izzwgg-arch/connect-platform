import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getUserFromToken } from '@/lib/auth'

export const runtime = 'nodejs'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tokenFromQuery = searchParams.get('token')
  let user: any = null

  if (tokenFromQuery) {
    const tokenUser = await getUserFromToken(tokenFromQuery)
    if (tokenUser && tokenUser.status === 'ACTIVE') {
      user = {
        id: tokenUser.id,
        tenantId: tokenUser.tenantId,
        email: tokenUser.email,
        role: tokenUser.role,
      }
    }
  }

  if (!user) {
    const authError = await authenticateRequest(request)
    if (authError) return authError
    user = getAuthUser(request)
  }

  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError

  const sinceRaw = searchParams.get('since')
  let since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 60_000)
  if (Number.isNaN(since.getTime())) since = new Date(Date.now() - 60_000)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const send = (event: string, payload: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }

      send('hello', { ok: true, since: since.toISOString() })

      while (!request.signal.aborted) {
        try {
          const memberships = await prisma.chatConversationMember.findMany({
            where: { tenantId: user.tenantId, userId: user.id },
            select: { conversationId: true },
          })
          const conversationIds = memberships.map((m) => m.conversationId)

          if (conversationIds.length > 0) {
            const newMessages = await prisma.chatMessage.findMany({
              where: {
                tenantId: user.tenantId,
                conversationId: { in: conversationIds },
                createdAt: { gt: since },
              },
              orderBy: { createdAt: 'asc' },
              take: 100,
            })

            if (newMessages.length > 0) {
              since = newMessages[newMessages.length - 1]!.createdAt
              for (const message of newMessages) {
                send('new_message', {
                  id: message.id,
                  conversationId: message.conversationId,
                  senderId: message.senderId,
                  createdAt: message.createdAt,
                })
              }
            } else {
              send('ping', { t: new Date().toISOString() })
            }
          } else {
            send('ping', { t: new Date().toISOString() })
          }
        } catch (error) {
          send('error', { error: 'stream_failed' })
        }

        await sleep(1000)
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
