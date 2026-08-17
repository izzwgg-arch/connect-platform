/**
 * The public SIP-over-WebSocket endpoint handed to clients.
 *
 * ⛔ WHY THIS FILE EXISTS (Phase B of the Cloudflare edge migration, 2026-08-16)
 *
 * `wss://app.connectcomunications.com/sip` was hardcoded in **THREE** places in
 * server.ts — and the plan written earlier that day said two, because the third is a
 * readiness probe that does not look like a URL definition:
 *
 *   1. `resolveWebrtcConfig`  — `fallbackSipWsUrl`, the value clients actually register with
 *   2. the SBC readiness probe — `fetch("https://app.…/sip")`, which asserts the proxy is alive
 *   3. `route.publicSipWsUrl`  — what diagnostics report back
 *
 * ⛔ ALL THREE MUST MOVE TOGETHER. Move only the first and the probe keeps testing a
 * hostname nobody registers against (so a broken new route reads healthy), while
 * diagnostics report a URL that is no longer in use — which is exactly how a future
 * session loses a day chasing a disagreement between the app and the dashboard.
 *
 * ⛔⛔ WHAT THIS VALUE MEANS CHANGED ON 2026-08-17 — READ THIS BEFORE EDITING IT.
 *
 * Izzy's decision that day: **existing customers stay exactly as they are; only accounts
 * created from then onward use the Loopcom SIP hostname.** This is ONE GLOBAL VALUE, so
 * it cannot express that on its own. It was made to express it by **pinning every tenant
 * that depended on the global to the hostname it already resolved to**:
 *
 *     UPDATE "Tenant" SET "sipWsUrl" = 'wss://sip.connectcomunications.com/sip'
 *       WHERE "webrtcRouteViaSbc" AND "sipWsUrl" IS NULL;   -- exactly 5 rows, 2026-08-17
 *
 * (B Visible, Displaydex, Gesheft, inii mini, Loopcom Demo — behaviour-preserving,
 * because that string was the live value of this env var at the moment they were pinned.)
 *
 * ⛔ SO THE ORDER IS SAFETY-CRITICAL AND MUST NEVER BE REVERSED: **pin first, flip
 * second.** Flip the global while a live tenant still has `sipWsUrl = NULL` and that
 * tenant is handed the new hostname on its users' next sign-in — the exact thing the
 * owner ruled out.
 *
 * ⛔ Therefore this value is now the **NEW-TENANT** hostname, not the platform hostname.
 * It reaches only tenants with `webrtcRouteViaSbc = true` AND `sipWsUrl IS NULL` —
 * which, since `8495d379` made `webrtcRouteViaSbc` default to `true`, means brand-new
 * tenants and nobody else. Before touching it, re-run the check:
 *
 *     SELECT name FROM "Tenant"
 *      WHERE "pbxRemovedAt" IS NULL AND "webrtcRouteViaSbc" AND "sipWsUrl" IS NULL;
 *
 * Any EXISTING customer in that list would be moved by a change here. It should list
 * only accounts you are content to move.
 *
 * ⛔ An explicit `tenant.sipWsUrl` wins outright — even when `webrtcRouteViaSbc` is
 * false (`resolveWebrtcConfig`, server.ts). That precedence is what makes the pin work,
 * and `sipRouteDefault.test.ts` exists to keep it true.
 *
 * The default below is still the pre-split hostname purely so an unset env is harmless;
 * production has always set the variable.
 *
 * ⛔ And every flip is inert on a live session — the apps never refresh a cached
 * `sipWsUrl`, so nobody moves until they sign out and back in. That cuts both ways: it
 * is why a flip breaks nothing immediately, and why it also achieves nothing immediately.
 * ⛔ It is also why NO old SIP hostname may EVER be retired on a schedule: clients hold
 * theirs cached indefinitely. All four hostnames stay live, at zero cost.
 */

/** The hostname SIP rode before the split. Kept as the default so a deploy changes nothing. */
export const LEGACY_SIP_WS_URL = "wss://app.connectcomunications.com/sip";

/** Read at call time, never at module load, so it is testable and settable per-process. */
export function sipPublicWsUrl(): string {
  const raw = (process.env.SIP_PUBLIC_WS_URL || "").trim();
  return raw || LEGACY_SIP_WS_URL;
}

/**
 * The same endpoint as an https:// URL, for the readiness probe that checks the proxy
 * is answering. Derived from the one value above so the probe can never drift to a
 * different host than the one clients are told to use.
 */
export function sipPublicProbeUrl(): string {
  return sipPublicWsUrl().replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

/** The path portion, for reporting. */
export function sipPublicPath(): string {
  try {
    return new URL(sipPublicWsUrl().replace(/^wss:/i, "https:").replace(/^ws:/i, "http:")).pathname;
  } catch {
    return "/sip";
  }
}
