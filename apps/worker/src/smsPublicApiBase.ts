/**
 * The ONE derivation of the public API base the SMS/MMS job hands to VoIP.ms
 * (media URLs) and texts to customers (fallback links).
 *
 * ⛔⛔ WHY THE GUARD EXISTS — the 2026-08-19 MMS regression. Commit `6a0f3a01`
 * added `PUBLIC_API_URL` to this chain; that variable had sat in
 * `.env.platform` since ~April as a BARE ORIGIN (`https://app.…com`, no
 * `/api`) and reaches only the worker container. Every media URL built on it
 * pointed at the portal's 404 page, VoIP.ms rejected `invalid_media` on every
 * MMS, and the fallback texted customers the same dead link. MMS had worked
 * May–July (40 sends); nobody sent media for two days, so it surfaced
 * 2026-08-21 on two tenants at once. Full detail:
 * docs/ai-context/AGENT_HANDOFF_HANNA_FIRST_CALLS_2026-08-21.md §2.
 *
 * ⛔ THE RULE THE GUARD ENCODES: a value with no path is a portal ORIGIN, not
 * an API base — on this platform the api is always served under `/api` of the
 * portal hosts, so a pathless base gets `/api` appended instead of silently
 * minting links that 404. An unparseable value is left alone (the old
 * behaviour) rather than guessed at.
 */

export type SmsPublicBaseEnv = Partial<
  Record<
    | "PUBLIC_API_BASE_URL"
    | "API_PUBLIC_URL"
    | "PUBLIC_API_URL"
    | "PUBLIC_PORTAL_URL"
    | "PORTAL_PUBLIC_URL"
    | "CONNECT_APP_URL"
    | "APP_PUBLIC_URL",
    string | undefined
  >
>;

const first = (...vals: Array<string | undefined>) => {
  for (const v of vals) {
    const t = String(v ?? "").trim();
    if (t) return t;
  }
  return undefined;
};

const stripTrailingSlashes = (s: string) => s.replace(/\/+$/, "");

/** Portal ORIGIN (no /api) — same chain as apps/api's canonicalPortalOrigin. */
export function resolveSmsPortalOrigin(env: SmsPublicBaseEnv): string {
  return stripTrailingSlashes(
    first(env.PUBLIC_PORTAL_URL, env.PORTAL_PUBLIC_URL, env.CONNECT_APP_URL, env.APP_PUBLIC_URL) ??
      "https://app.connectcomunications.com",
  );
}

/**
 * Public API base for signed chat/media URLs. Guarantees a pathful base: an
 * env value that is a bare origin (pathname "" or "/") gets `/api` appended,
 * because a bare origin can only ever mint 404 links here.
 */
export function resolveSmsPublicApiBase(env: SmsPublicBaseEnv): string {
  const portalOrigin = resolveSmsPortalOrigin(env);
  const raw = first(env.PUBLIC_API_BASE_URL, env.API_PUBLIC_URL, env.PUBLIC_API_URL);
  const base = stripTrailingSlashes(raw ?? `${portalOrigin}/api`);
  try {
    const u = new URL(base);
    if (u.pathname === "" || u.pathname === "/") return `${base}/api`;
  } catch {
    // Not a parseable URL — leave it exactly as configured (old behaviour).
  }
  return base;
}
