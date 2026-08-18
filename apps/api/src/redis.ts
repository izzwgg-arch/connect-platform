import IORedis, { type RedisOptions } from "ioredis";
import type { Queue } from "bullmq";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

/**
 * ⛔ These two behaviours — "stop reconnecting" and "swallow every redis
 * error" — used to be chosen by `NODE_ENV !== "production"`, and **the api
 * container sets no NODE_ENV** (proven live 2026-08-18:
 * `docker exec app-api-1 printenv NODE_ENV` → empty, exit 1). So in production
 * they were decided entirely by the second half of the condition,
 * `!process.env.REDIS_URL`. See CLAUDE.md → "THE NODE_ENV SWEEP NOBODY DID".
 *
 * The dependency is removed rather than corrected: `REDIS_URL` is the fact
 * that actually matters, and it IS set in production
 * (`REDIS_URL=redis://connectcomms-redis:6379`, in `.env.platform` and read
 * back live from `app-api-1`), so this is a behaviour no-op there — retries
 * back off and errors surface exactly as they do today. What it removes is the
 * trap where someone "fixes" the dead-gate class by setting
 * `NODE_ENV=development` and silently turns off redis reconnection for the
 * whole platform.
 *
 * A local dev box with no redis still gets the quiet behaviour by simply not
 * setting `REDIS_URL` — but it is now announced once at startup, so
 * "everything is queued and nothing runs" can never again be invisible.
 */
export function shouldTolerateMissingRedis(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !String(env.REDIS_URL || "").trim();
}

let warnedMissingRedisUrl = false;
function warnOnceIfRedisUrlMissing(): void {
  if (warnedMissingRedisUrl || !shouldTolerateMissingRedis()) return;
  warnedMissingRedisUrl = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[redis] REDIS_URL is not set — falling back to ${DEFAULT_REDIS_URL}, disabling reconnect ` +
      `and SUPPRESSING all redis errors. This is a local-development fallback: on a real ` +
      `deployment it means every queued job silently stops running. Set REDIS_URL.`,
  );
}

export function createRedisConnection(options: RedisOptions = {}) {
  const tolerateMissing = shouldTolerateMissingRedis();
  const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  warnOnceIfRedisUrlMissing();

  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    // Local Windows dev often runs without Redis. Avoid endless reconnect churn
    // unless the developer explicitly configured REDIS_URL.
    retryStrategy: tolerateMissing ? () => null : (times) => Math.min(times * 100, 2000),
    ...options,
  });

  if (tolerateMissing) {
    redis.on("error", () => {
      // Missing Redis is expected for lightweight local browsing.
    });
  }

  return redis;
}

export function quietMissingRedisInDev<T extends Queue>(queue: T): T {
  if (shouldTolerateMissingRedis()) {
    queue.on("error", () => {
      // Missing Redis is expected for lightweight local browsing.
    });
  }
  return queue;
}
