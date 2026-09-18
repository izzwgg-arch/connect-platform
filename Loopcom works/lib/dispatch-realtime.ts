import { createClient, type RedisClientType } from 'redis'

type DispatchRealtimeMessage = {
  id: string
  kind: 'dispatch_event' | 'photo' | 'video' | 'file' | 'message' | 'system'
  ts: string
  jobId?: string | null
  eventType?: string
  payload?: any
  body?: string | null
  attachment?: any
  media?: any[]
  job?: {
    id?: string
    jobNumber?: string
    title?: string
    client?: { name?: string }
  }
}

type Listener = (message: DispatchRealtimeMessage) => void

const listeners = new Map<string, Set<Listener>>()
const redisUrl = process.env.REDIS_URL || ''
const replayMax = Math.max(100, Number(process.env.DISPATCH_REPLAY_MAX || 600))
let pubClient: RedisClientType | null = null
let subClient: RedisClientType | null = null
let redisReady = false
const subscribedTenants = new Set<string>()

function channelForTenant(tenantId: string) {
  return `dispatch:tenant:${tenantId}`
}

function replayKeyForTenant(tenantId: string) {
  return `dispatch:replay:${tenantId}`
}

async function ensureRedisClients(): Promise<boolean> {
  if (!redisUrl) return false
  if (redisReady && pubClient && subClient && pubClient.isOpen && subClient.isOpen) return true
  try {
    if (!pubClient) pubClient = createClient({ url: redisUrl })
    if (!subClient) subClient = createClient({ url: redisUrl })
    if (!pubClient.isOpen) await pubClient.connect()
    if (!subClient.isOpen) await subClient.connect()
    redisReady = true
    return true
  } catch (error) {
    redisReady = false
    console.error('[dispatch-realtime] Redis init failed, using in-memory fallback:', error)
    return false
  }
}

function fanoutLocal(tenantId: string, message: DispatchRealtimeMessage) {
  const set = listeners.get(tenantId)
  if (!set || set.size === 0) return
  for (const listener of set) {
    try {
      listener(message)
    } catch (error) {
      console.error('[dispatch-realtime] listener error', error)
    }
  }
}

export async function subscribeDispatchRealtime(tenantId: string, listener: Listener): Promise<() => void> {
  if (!listeners.has(tenantId)) listeners.set(tenantId, new Set())
  listeners.get(tenantId)!.add(listener)

  const ready = await ensureRedisClients()
  if (ready && subClient && !subscribedTenants.has(tenantId)) {
    subscribedTenants.add(tenantId)
    await subClient.subscribe(channelForTenant(tenantId), (raw: string) => {
      try {
        const msg = JSON.parse(raw) as DispatchRealtimeMessage
        fanoutLocal(tenantId, msg)
      } catch {
        // Ignore malformed payloads.
      }
    })
  }

  return () => {
    const set = listeners.get(tenantId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(tenantId)
  }
}

export function publishDispatchRealtime(tenantId: string, message: DispatchRealtimeMessage): void {
  // Immediate same-process updates.
  fanoutLocal(tenantId, message)
  // Best-effort cross-process fanout.
  void (async () => {
    const ready = await ensureRedisClients()
    if (!ready || !pubClient) return
    try {
      await pubClient.publish(channelForTenant(tenantId), JSON.stringify(message))
      await pubClient.lPush(replayKeyForTenant(tenantId), JSON.stringify(message))
      await pubClient.lTrim(replayKeyForTenant(tenantId), 0, replayMax - 1)
    } catch (error) {
      console.error('[dispatch-realtime] Redis publish failed:', error)
    }
  })()
}

export async function getDispatchRealtimeReplay(
  tenantId: string,
  sinceIso: string,
  limit: number = 180
): Promise<DispatchRealtimeMessage[]> {
  const ready = await ensureRedisClients()
  if (!ready || !pubClient) return []

  const sinceTs = new Date(sinceIso).getTime()
  if (!Number.isFinite(sinceTs)) return []

  try {
    const scanCount = Math.max(limit * 3, 200)
    const rows = await pubClient.lRange(replayKeyForTenant(tenantId), 0, scanCount - 1)
    const parsed: DispatchRealtimeMessage[] = []
    for (const raw of rows) {
      try {
        const item = JSON.parse(raw) as DispatchRealtimeMessage
        const ts = new Date(item.ts).getTime()
        if (Number.isFinite(ts) && ts > sinceTs) parsed.push(item)
      } catch {
        // Ignore malformed rows.
      }
    }
    // Replay in ascending order.
    return parsed.reverse().slice(-limit)
  } catch (error) {
    console.error('[dispatch-realtime] replay load failed:', error)
    return []
  }
}

export async function getDispatchRealtimeHealth(tenantId: string): Promise<{
  redisConfigured: boolean
  redisConnected: boolean
  replayDepth: number
  replayMax: number
  latestReplayTs: string | null
  localSubscribers: number
}> {
  const redisConfigured = Boolean(redisUrl)
  const localSubscribers = listeners.get(tenantId)?.size || 0
  const ready = await ensureRedisClients()

  if (!ready || !pubClient) {
    return {
      redisConfigured,
      redisConnected: false,
      replayDepth: 0,
      replayMax,
      latestReplayTs: null,
      localSubscribers,
    }
  }

  try {
    const [depth, latestRaw] = await Promise.all([
      pubClient.lLen(replayKeyForTenant(tenantId)),
      pubClient.lIndex(replayKeyForTenant(tenantId), 0),
    ])

    let latestReplayTs: string | null = null
    if (latestRaw) {
      try {
        const parsed = JSON.parse(latestRaw) as DispatchRealtimeMessage
        latestReplayTs = parsed?.ts || null
      } catch {
        latestReplayTs = null
      }
    }

    return {
      redisConfigured,
      redisConnected: true,
      replayDepth: depth,
      replayMax,
      latestReplayTs,
      localSubscribers,
    }
  } catch (error) {
    return {
      redisConfigured,
      redisConnected: false,
      replayDepth: 0,
      replayMax,
      latestReplayTs: null,
      localSubscribers,
    }
  }
}

