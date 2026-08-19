/**
 * The platform-wide request rate limit — the rules that decide WHO gets a
 * bucket and how big it is. Wired in server.ts as a global `onRequest` hook.
 *
 * ⛔⛔ HISTORY, so nobody re-breaks it: from the first commit until 2026-08-18
 * server.ts did `app.register(rateLimit, { max: 200, timeWindow: "1 minute" })`
 * and then declared all 480+ routes synchronously below it. In Fastify 5 the
 * plugin attaches its GLOBAL limiter through an `onRoute` hook — and `onRoute`
 * fires at route-declaration time, synchronously, BEFORE the (async, un-awaited)
 * plugin ever loaded. So the "global" limiter never attached to a single route:
 * 357 req/min peaks produced zero 429s, and no response on the platform ever
 * carried an `x-ratelimit-*` header. The 2026-08-17 audit's §6i ("one bucket for
 * the whole platform") was wrong in the OTHER direction — there was no bucket at
 * all. Same class as the NODE_ENV gates: a safety feature dead since day one.
 *
 * The fix is `app.rateLimit(...)` installed as an `onRequest` hook inside
 * `app.after()`: lifecycle hooks are snapshotted at `preReady`, so a hook added
 * any time before ready binds to every route regardless of declaration order.
 * `globalRateLimit.test.ts` proves that with a real Fastify instance whose
 * routes are declared BEFORE the plugin — the exact shape server.ts has.
 *
 * ⛔ `req.ip` IS THE NGINX HOP. Fastify has no `trustProxy`, so `req.ip` is the
 * docker gateway for every proxied request. Keying on it WOULD have been one
 * bucket for the whole platform. We key on the LAST `X-Forwarded-For` entry —
 * nginx appends the real peer, so earlier entries are attacker-controlled (see
 * loginThrottle.ts, which learned this first).
 *
 * ⛔ Callers with NO `X-Forwarded-For` are EXEMPT, on purpose. Those are the
 * internal docker peers (telephony's CDR ingest and mobile-ring pushes, the
 * worker, the deploy health probe on 127.0.0.1) — nginx binds the api port to
 * loopback, so nothing external can arrive header-less. Throttling those would
 * lose call history and stop phones ringing to protect nothing.
 *
 * ⛔ `/internal/*` is exempt too: nginx already restricts it to loopback + the
 * docker bridges + the PBX, every door checks the shared secret, and the PBX's
 * wake POST sits on the call path.
 *
 * SIZING (measured 2026-08-18 across four days of nginx logs, per real IP per
 * minute on /api/): the highest LEGITIMATE bucket was 167 (Izzy's own
 * workstation), the next 137; only 20 of 17,209 buckets in a full day exceeded
 * 100. The only readings above that were the 2026-08-17 Gesheft voicemail-flood
 * bug at 523/min — which nginx then BANNED, blanking the whole office. A ceiling
 * of 480/min touches no legitimate user and would have 429'd that flood before
 * the ban fired: a 429 on the runaway calls is a far gentler failure than a
 * banned office. `monitor.sh` still bans at >1200 req/5 min behind this.
 */

export const DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE = 480;

/** Paths (api-internal form, no /api prefix) that never count. */
export function isGlobalRateLimitExempt(path: string): boolean {
  const p = String(path || "").split("?")[0];
  return p.startsWith("/internal/") || p.startsWith("/api/internal/");
}

/**
 * The bucket key for a request, or null when the request must not be limited.
 * Pure: takes the header value, not the request, so it is testable without
 * Fastify and reusable by anything else that needs "who is this really".
 */
export function resolveGlobalRateLimitKey(
  forwardedFor: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (!raw) return null; // internal caller — no proxy hop, exempt
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

/**
 * The per-minute ceiling from the environment. `0` disables the limiter (an
 * emergency switch that needs only an api restart, not a rebuild); anything
 * unparseable falls back to the default rather than to "unlimited".
 */
export function resolveGlobalRateLimitMax(raw: string | undefined = process.env.API_GLOBAL_RATE_LIMIT_PER_MIN): number {
  if (raw == null || raw.trim() === "") return DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE;
  return Math.trunc(n);
}

/** Options handed to `app.rateLimit()` — kept here so the test and server.ts share one shape. */
export function buildGlobalRateLimitOptions(max: number = resolveGlobalRateLimitMax()) {
  return {
    max,
    timeWindow: "1 minute",
    keyGenerator: (req: { headers: Record<string, string | string[] | undefined> }) =>
      resolveGlobalRateLimitKey(req.headers["x-forwarded-for"]) ?? "internal",
    allowList: (req: { headers: Record<string, string | string[] | undefined>; url?: string; raw?: { url?: string } }) =>
      resolveGlobalRateLimitKey(req.headers["x-forwarded-for"]) === null
      || isGlobalRateLimitExempt(String(req.url ?? req.raw?.url ?? "")),
    // A limited client should be told plainly, and the portal renders `error`.
    errorResponseBuilder: (_req: unknown, context: { after: string; max: number }) => ({
      statusCode: 429,
      error: "too_many_requests",
      message: `Too many requests from this connection — slow down and try again in ${context.after}.`,
      max: context.max,
    }),
  };
}
