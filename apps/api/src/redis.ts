/**
 * Shared Redis connection helpers for the API process.
 *
 * This module was referenced by server.ts (commit 10af1912, "agent: Actions v2
 * foundation") but the file itself was never committed, which made the API
 * unbootable from a clean checkout (`Cannot find module './redis'`). It
 * reproduces the exact pre-refactor production behaviour that used to live
 * inline in server.ts:
 *
 *   const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379",
 *                             { maxRetriesPerRequest: null });
 *   const smsQueue = new Queue("sms-send", { connection: redis });
 *
 * plus a dev-only nicety: without a local Redis, ioredis/BullMQ retry forever
 * and flood the console — in non-production we swallow those connection errors.
 */
import IORedis from "ioredis";

export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  // maxRetriesPerRequest: null is required by BullMQ (it manages blocking
  // commands itself) — identical to the previous inline construction.
  const conn = new IORedis(url, { maxRetriesPerRequest: null });
  if ((process.env.NODE_ENV || "").toLowerCase() !== "production") {
    conn.on("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "ECONNREFUSED" || err?.code === "ENOTFOUND") return;
      // Non-connection errors are still worth one line in dev.
      console.warn("[redis] error:", err?.message || err);
    });
  }
  return conn;
}

/**
 * Pass-through in production. In dev, attach an error handler to a BullMQ
 * queue so a missing local Redis doesn't spam the console with unhandled
 * connection errors while the rest of the API keeps working.
 */
export function quietMissingRedisInDev<T extends { on: (event: "error", cb: (err: Error) => void) => unknown }>(queue: T): T {
  if ((process.env.NODE_ENV || "").toLowerCase() === "production") return queue;
  try {
    queue.on("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "ECONNREFUSED" || err?.code === "ENOTFOUND") return;
      console.warn("[queue] redis error:", err?.message || err);
    });
  } catch {
    /* attaching diagnostics must never break queue creation */
  }
  return queue;
}
