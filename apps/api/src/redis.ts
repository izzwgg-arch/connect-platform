import IORedis, { type RedisOptions } from "ioredis";
import type { Queue } from "bullmq";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

export function createRedisConnection(options: RedisOptions = {}) {
  const isProduction = process.env.NODE_ENV === "production";
  const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;

  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    // Local Windows dev often runs without Redis. Avoid endless reconnect churn
    // unless the developer explicitly configured REDIS_URL.
    retryStrategy: process.env.REDIS_URL || isProduction
      ? (times) => Math.min(times * 100, 2000)
      : () => null,
    ...options,
  });

  if (!isProduction && !process.env.REDIS_URL) {
    redis.on("error", () => {
      // Missing Redis is expected for lightweight local browsing.
    });
  }

  return redis;
}

export function quietMissingRedisInDev<T extends Queue>(queue: T): T {
  if (process.env.NODE_ENV !== "production" && !process.env.REDIS_URL) {
    queue.on("error", () => {
      // Missing Redis is expected for lightweight local browsing.
    });
  }
  return queue;
}
