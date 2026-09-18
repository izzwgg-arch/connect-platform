import { createClient } from 'redis'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

export const redis = createClient({
  url: redisUrl,
})

redis.on('error', (err) => console.error('Redis Client Error', err))
redis.on('connect', () => console.log('Redis Client Connected'))

if (!redis.isOpen) {
  redis.connect().catch(console.error)
}

// Helper functions
export async function setCache(key: string, value: any, ttl: number = 3600): Promise<void> {
  await redis.setEx(key, ttl, JSON.stringify(value))
}

export async function getCache<T>(key: string): Promise<T | null> {
  const value = await redis.get(key)
  return value ? JSON.parse(value) : null
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(key)
}

export async function deleteCachePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern)
  if (keys.length > 0) {
    await redis.del(keys)
  }
}
