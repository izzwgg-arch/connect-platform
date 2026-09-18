import { EventEmitter } from "node:events";
import { env } from "../env.js";

/**
 * Realtime fan-out. Every event is addressed to a person; the SSE route
 * subscribes the connected client to its own personId. In-process bus by
 * default; Redis pub/sub when REDIS_URL is set so several api instances share.
 */
export type RealtimeEvent = { type: string; data: unknown; at: string };

const local = new EventEmitter();
local.setMaxListeners(10_000);

type RedisLike = {
  publish: (ch: string, msg: string) => Promise<unknown>;
  subscribe: (ch: string) => Promise<unknown>;
  on: (ev: string, cb: (...a: any[]) => void) => void;
};
let pub: RedisLike | null = null;
let sub: RedisLike | null = null;
let redisReady = false;

async function ensureRedis() {
  if (redisReady || !env().REDIS_URL) return;
  redisReady = true;
  const mod: any = await import("ioredis");
  const Redis = mod.default?.default ?? mod.default ?? mod.Redis ?? mod;
  pub = new Redis(env().REDIS_URL) as unknown as RedisLike;
  sub = new Redis(env().REDIS_URL) as unknown as RedisLike;
  await sub.subscribe("community:events");
  sub.on("message", (_ch: string, msg: string) => {
    try {
      const { personId, event } = JSON.parse(msg);
      local.emit(`p:${personId}`, event);
    } catch {
      /* ignore malformed */
    }
  });
}

export async function publishTo(personId: string, type: string, data: unknown) {
  const event: RealtimeEvent = { type, data, at: new Date().toISOString() };
  await ensureRedis();
  if (pub) {
    await pub.publish("community:events", JSON.stringify({ personId, event }));
  } else {
    local.emit(`p:${personId}`, event);
  }
}

export async function publishToMany(personIds: string[], type: string, data: unknown) {
  await Promise.all([...new Set(personIds)].map((id) => publishTo(id, type, data)));
}

export function subscribe(personId: string, cb: (e: RealtimeEvent) => void): () => void {
  const key = `p:${personId}`;
  local.on(key, cb);
  return () => local.off(key, cb);
}

/** Total connected SSE listeners on THIS instance (each open /realtime/stream holds one). Admin system health only. */
export function subscriberCount(): number {
  return local.eventNames().reduce((sum, name) => sum + local.listenerCount(name), 0);
}
