import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getDispatchRealtimeReplay, subscribeDispatchRealtime } from '@/lib/dispatch-realtime'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'dispatch.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const sinceParam = searchParams.get('since')
  const parsedSince = sinceParam ? new Date(sinceParam) : null
  const since = parsedSince && !Number.isNaN(parsedSince.getTime()) ? parsedSince : new Date(Date.now() - 60_000)

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      send('hello', { ok: true, ts: new Date().toISOString() })
      // Send a small initial snapshot for users joining late.
      try {
        const replay = await getDispatchRealtimeReplay(user.tenantId, since.toISOString(), 220)
        if (replay.length > 0) {
          send('feed', {
            items: replay,
            cursor: replay[replay.length - 1]!.ts,
            source: 'redis_replay',
          })
        }

        const recentEvents = await prisma.dispatchEvent.findMany({
          where: {
            tenantId: user.tenantId,
            timestamp: { gt: since },
          },
          include: {
            job: {
              select: { id: true, jobNumber: true, title: true, client: { select: { name: true } } },
            },
          },
          orderBy: { timestamp: 'asc' },
          take: 80,
        })
        if (recentEvents.length > 0 && replay.length === 0) {
          send('feed', {
            items: recentEvents.map((e) => ({
              id: `ev_${e.id}`,
              kind: 'dispatch_event',
              ts: e.timestamp.toISOString(),
              jobId: e.jobId,
              eventType: e.eventType,
              payload: e.payload,
              job: e.job,
            })),
            cursor: recentEvents[recentEvents.length - 1]!.timestamp.toISOString(),
            source: 'db_snapshot',
          })
        }
      } catch (error) {
        send('error', { error: 'snapshot_error' })
      }

      const unsubscribe = await subscribeDispatchRealtime(user.tenantId, (message) => {
        send('feed', { items: [message], cursor: message.ts })
      })

      const heartbeat = setInterval(() => {
        send('ping', { t: new Date().toISOString() })
      }, 15_000)

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        unsubscribe()
        controller.close()
      })
    },
    cancel: () => {},
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}

