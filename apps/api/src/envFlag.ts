/**
 * ONE truthiness rule for every explicit opt-in env flag in apps/api.
 *
 * ⛔ Why this exists: `SOLA_CARDKNOX_SIMULATE` is read in FOUR places with TWO
 * different conventions — `solaGateway.ts:66`/`:195` and
 * `solaExternalSchedules.ts:199` compare against the literal `"1"`, while
 * `server.ts:653` and `apps/worker/src/main.ts:402` compare against `"true"`.
 * So `SOLA_CARDKNOX_SIMULATE=1` put the gateway into simulate mode while the
 * boot guard that was supposed to refuse that exact state never fired, because
 * it was only looking for `"true"`. A safety guard that recognises fewer
 * truthy spellings than the thing it guards is not a guard.
 *
 * Anything that decides "is this dangerous mode on?" or "did an operator
 * explicitly opt in?" must go through here, so the two can never disagree
 * again.
 *
 * ⛔ Never gate any of this on `NODE_ENV`. The api container sets NO `NODE_ENV`
 * (proven live 2026-08-18: `docker exec app-api-1 printenv NODE_ENV` → empty,
 * exit 1; telephony prints `production`). Every
 * `process.env.NODE_ENV === "production"` branch in apps/api is permanently
 * false, which is how the login throttle, the error-leak handler and the
 * anonymous tenant-creation gate all sat dead in production for months. See
 * CLAUDE.md → "THE NODE_ENV SWEEP NOBODY DID".
 *
 * Read at CALL time, never at module load, so every gate stays testable.
 */
export function isEnvFlagEnabled(raw: string | undefined | null): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
