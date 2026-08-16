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
 * ⛔ Tenants do NOT store this. `sipWsUrl` is NULL on all four tenants using the 443
 * route (`webrtcRouteViaSbc = true`), so there is no per-tenant DB edit that can move
 * them — the value comes from here. A tenant that DOES set `sipWsUrl` still wins.
 *
 * The default is deliberately the CURRENT production hostname, so deploying this
 * change is a no-op. Moving to `sip.connectcomunications.com` is a config flip:
 *
 *     SIP_PUBLIC_WS_URL=wss://sip.connectcomunications.com/sip
 *
 * ⛔ And the flip is inert on a live session — the apps never refresh a cached
 * `sipWsUrl`, so every affected user must sign out and back in. That is the whole
 * customer-visible cost of Phase B; do not expect the change to take effect on its own.
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
