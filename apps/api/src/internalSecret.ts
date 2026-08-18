/**
 * The one lock on every `/internal/*` door.
 *
 * ⛔ THIS IS FAIL-CLOSED ON PURPOSE, AND THAT IS THE WHOLE POINT.
 *
 * Until 2026-08-18 every one of these doors did the opposite: an unset
 * `CDR_INGEST_SECRET` meant "allow" ("dev mode"), and the secret was EMPTY in
 * api, telephony and worker — so `/internal/cdr-ingest`,
 * `/internal/telephony/pbx-tenant-map`, `/internal/mobile-ring-notify` and the
 * rest had no lock at all, while nginx proxied the whole `/api/` prefix with no
 * path exclusion. `GET /api/internal/telephony/pbx-tenant-map` returned the
 * entire tenant directory to anyone on the internet. See
 * `docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §1.
 *
 * ⛔ DO NOT gate any of this on `NODE_ENV`. The api container sets no
 * `NODE_ENV` (proven live: `docker exec app-api-1` → empty), which is exactly
 * how the login throttle and the error-leak handler sat dead in production for
 * months. A missing secret must close the door, not open it.
 *
 * ⛔ DO NOT re-introduce a second copy of this comparison. The reason the
 * fail-open behaviour survived so long is that it existed in eight
 * near-identical inline blocks; one implementation is the fix.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type InternalSecretReason = "ok" | "not_configured" | "missing" | "mismatch";

export type InternalSecretVerdict =
  | { ok: true; reason: "ok" }
  | { ok: false; reason: Exclude<InternalSecretReason, "ok">; status: 401 | 403 | 503; error: string };

/**
 * Compare a caller-supplied `x-cdr-secret` against the configured value.
 *
 * - secret not configured → **503 `secret_not_configured`** (closed, and says
 *   why: this is an operator problem, not a caller problem).
 * - header absent        → 401 `missing secret`
 * - header wrong         → 403 `forbidden`
 *
 * The comparison is constant-time AND length-independent: both sides are
 * SHA-256'd to a fixed 32-byte digest first.
 *
 * DO NOT go back to the old `padEnd(64, ..).slice(0, 64)` form the inline
 * blocks used - it silently compared only the FIRST 64 CHARACTERS, so two
 * different secrets agreeing on their first 64 chars were accepted as equal.
 * A unit test caught that while this helper was being extracted.
 */
export function checkInternalSecret(
  configured: string | undefined | null,
  incoming: string | undefined | null,
): InternalSecretVerdict {
  const secret = String(configured ?? "").trim();
  if (!secret) {
    return { ok: false, reason: "not_configured", status: 503, error: "secret_not_configured" };
  }
  const given = String(incoming ?? "").trim();
  if (!given) {
    return { ok: false, reason: "missing", status: 401, error: "missing secret" };
  }
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch", status: 403, error: "forbidden" };
  }
  return { ok: true, reason: "ok" };
}
