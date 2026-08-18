/**
 * Dead-session handling for the portal / desktop app — step 1 of the
 * token-expiry order in `docs/ai-context/AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §8.6.
 *
 * WHY THIS EXISTS. Session tokens do not expire today. The moment the api
 * starts refusing old tokens (step 3), a parked portal window would become a
 * 401 stream: mini-dialer 30 s, notifications bridge 30 s, panel 60 s, chat
 * 7 s, SIP init backing off, telephony WS reconnecting on every 1008. nginx's
 * `monitor.sh` bans an IP at >30 × 401 in 5 minutes — so "your session
 * expired" would present to the customer as the 2026-08-17 blank-app incident:
 * the whole office 403 on everything, and reopening cannot help because the
 * ban refuses the page's own JavaScript. This module turns a dead token into
 * "please sign in" instead.
 *
 * WHAT IT DOES, in order, exactly once per dead token:
 *   1. classify — only a 401 whose body is `{ error: "unauthorized" }` (any
 *      case) AND that was SENT with a bearer token counts as "session dead";
 *   2. clear the stored session (`clearAuthSession`);
 *   3. dispatch `SESSION_EXPIRED_EVENT` on `window` so `AuthGate` can drop the
 *      shell (desktop passive windows go back to "waiting for a token");
 *   4. in a full window on an authenticated path, navigate to
 *      `/login?next=<path+search>`.
 * After that, `shouldShortCircuit()` makes `apiClient` refuse to send any
 * further request that would carry the dead token (or no token at all) on an
 * authenticated path — locally, without a network round-trip — until a NEW
 * token appears. That is what makes every background poller stop on the first
 * 401 without editing each one: they still tick, but nothing reaches nginx.
 *
 * ⛔ HOW "SESSION DEAD" IS TOLD APART FROM A PERMISSION FAILURE. Read from the
 * api, not guessed: the JWT preHandler (`apps/api/src/server.ts` ~6081) answers
 * `401 { error: "unauthorized" }` for a missing / malformed / wrong-secret /
 * expired token, and every route-level `!req.user?.sub` guard sends the same
 * body. Permission failures — `requirePermission`, `requireAdmin`,
 * `requireRoleOrPortalPermission`, the portal-permission gate — all answer
 * `403 { error: "forbidden" }`. The other 401 bodies the api can send are
 * `invalid_credentials` (`/auth/login`, sent with NO token), `bad_signature`
 * (signed download URLs) and `missing secret` (machine doors) — none of them
 * says anything about the session, and none is treated as one. So a person who
 * opens a screen they lack permission for is NOT signed out.
 *
 * ⛔ PUBLIC PAGES ARE NEVER REDIRECTED. `/login`, `/p/*`, `/pay/*`, `/auth/*`,
 * `/onboarding/*`, `/track/*`, `/forms/*`, `/privacy` are unauthenticated;
 * a 401 there (say `/me` from the globally-mounted providers while a signed-in
 * person views a pay link with a stale token) clears the token and does
 * nothing else — and the short-circuit does not apply on those paths, so the
 * page's own public calls keep flowing.
 *
 * ⛔ DESKTOP PASSIVE WINDOWS (`/desktop/mini-dialer`, `/desktop/phone-engine`)
 * are never sent to `/login` — a hidden window parked on the login page is
 * exactly the wedge `AuthGate`'s passive-window rule exists to avoid. They get
 * the event, `AuthGate` drops their content and waits for the main window's
 * next sign-in to write a fresh token (the `storage` event crosses windows).
 *
 * The module state is keyed on the dead token itself, so twenty concurrent 401s
 * from twenty pollers produce ONE clear and ONE navigation, and a fresh token
 * (a new sign-in) re-arms everything with no reload needed in passive windows.
 */

import { clearAuthSession } from "../services/session";

/** Fired on `window` once per dead session. `AuthGate` listens. */
export const SESSION_EXPIRED_EVENT = "cc-session-expired";

/** Body error code the api's JWT hook sends. Compared case-insensitively. */
export const DEAD_SESSION_ERROR_CODE = "unauthorized";

/**
 * Path prefixes served WITHOUT a session. Anything not listed here (and not a
 * desktop passive window) is an authenticated portal screen. `/desktop/` is
 * deliberately NOT here — those are authenticated, they just must not redirect.
 * `/privacy` is static nginx, listed for completeness. `/` redirects to
 * `/dashboard` server-side and never runs client code.
 */
export const PUBLIC_PATH_PREFIXES: readonly string[] = [
  "/login",
  "/auth/",
  "/p/",
  "/pay/",
  "/onboarding/",
  "/track/",
  "/forms/",
  "/privacy",
  "/ready",
  "/version",
];

export const DESKTOP_PASSIVE_PATH_PREFIX = "/desktop/";

export function isPublicPortalPath(pathname: string | null | undefined): boolean {
  const p = String(pathname || "").trim();
  if (!p) return false;
  return PUBLIC_PATH_PREFIXES.some((prefix) => {
    const bare = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return p === bare || p.startsWith(`${bare}/`);
  });
}

export function isDesktopPassivePath(pathname: string | null | undefined): boolean {
  const p = String(pathname || "").trim();
  return p.startsWith(DESKTOP_PASSIVE_PATH_PREFIX);
}

/**
 * The classifier. `sentWithToken` is whether the request carried a bearer
 * token — a 401 on a request that never had one says nothing about a session
 * (that is the login page, a public page, or an already-signed-out window).
 */
export function isDeadSessionResponse(input: {
  status: number;
  body: unknown;
  sentWithToken: boolean;
}): boolean {
  if (input.status !== 401) return false;
  if (!input.sentWithToken) return false;
  const body = input.body;
  if (!body || typeof body !== "object") return false;
  const code = (body as { error?: unknown }).error;
  if (typeof code !== "string") return false;
  return code.trim().toLowerCase() === DEAD_SESSION_ERROR_CODE;
}

/** Build the login URL that brings the person back to where they were. */
export function buildLoginRedirect(pathname: string, search: string): string {
  const path = pathname && pathname.startsWith("/") ? pathname : "/dashboard";
  const next = encodeURIComponent(`${path}${search || ""}`);
  return `/login?next=${next}`;
}

// ── Module state — one dead token at a time ─────────────────────────────────

let deadToken: string | null = null;
let navigated = false;

/** Test hook. Production never calls it. */
export function resetSessionExpiryStateForTests(): void {
  deadToken = null;
  navigated = false;
}

/** For diagnostics / tests: the token currently known to be dead, if any. */
export function currentDeadToken(): string | null {
  return deadToken;
}

export type DeadSessionOutcome =
  /** First sighting of this dead token in a full window on an authenticated path: session cleared, event fired, navigating to /login. */
  | "redirected"
  /** First sighting in a desktop passive window: session cleared, event fired, no navigation — AuthGate waits for a fresh token. */
  | "waiting"
  /** First sighting on a public path: session cleared, event fired, no navigation. */
  | "cleared"
  /** This dead token was already handled — nothing done. */
  | "already_handled";

export type DeadSessionDeps = {
  pathname: string;
  search: string;
  isDesktopPassiveWindow: boolean;
  clearSession: () => void;
  dispatch: (eventName: string) => void;
  navigate: (url: string) => void;
};

/**
 * Handle a confirmed dead-session 401. Idempotent per token: the first caller
 * does the work, every later caller for the same token is a no-op — so a burst
 * of concurrent 401s from the pollers cannot produce a burst of redirects.
 */
export function handleDeadSession(token: string, deps: DeadSessionDeps): DeadSessionOutcome {
  if (!token) return "already_handled";
  if (deadToken === token) return "already_handled";
  deadToken = token;
  navigated = false;

  try {
    deps.clearSession();
  } catch {
    /* storage blocked — there was nothing durable to clear */
  }
  try {
    deps.dispatch(SESSION_EXPIRED_EVENT);
  } catch {
    /* a listener threw — the redirect below must still happen */
  }

  if (isPublicPortalPath(deps.pathname)) return "cleared";
  if (deps.isDesktopPassiveWindow || isDesktopPassivePath(deps.pathname)) return "waiting";

  navigated = true;
  deps.navigate(buildLoginRedirect(deps.pathname, deps.search));
  return "redirected";
}

/**
 * Whether `apiClient` should refuse to send this request at all. True while a
 * dead session is being torn down and the caller would send the dead token or
 * no token, on an authenticated path. A NEW token (someone signed in again)
 * re-arms the module and lets the request through.
 *
 * ⛔ Never true on a public path: a signed-in person viewing a pay link with a
 * stale token must still be able to load the pay link.
 */
export function shouldShortCircuit(token: string, pathname: string | null | undefined): boolean {
  if (deadToken === null) return false;
  if (token && token !== deadToken) {
    // Fresh sign-in — the dead token is history.
    deadToken = null;
    navigated = false;
    return false;
  }
  if (isPublicPortalPath(pathname)) return false;
  return true;
}

/** True once this module has itself started a navigation to /login. */
export function hasNavigatedToLogin(): boolean {
  return navigated;
}

// ── Browser wiring (thin; the logic above is what the tests exercise) ────────

export function isDesktopPassiveWindow(): boolean {
  if (typeof window === "undefined") return false;
  const desktop = (window as unknown as { connectDesktop?: { isDesktop?: boolean; windowKind?: string } }).connectDesktop;
  return Boolean(desktop?.isDesktop && desktop.windowKind && desktop.windowKind !== "full");
}

/** The production entry point `apiClient` calls. */
export function handleDeadSessionInBrowser(token: string): DeadSessionOutcome {
  if (typeof window === "undefined") return "already_handled";
  return handleDeadSession(token, {
    pathname: window.location.pathname,
    search: window.location.search,
    isDesktopPassiveWindow: isDesktopPassiveWindow(),
    clearSession: clearAuthSession,
    dispatch: (name) => window.dispatchEvent(new Event(name)),
    // A hard navigation on purpose: it tears down every timer, socket and
    // provider in this window at once, so nothing can keep talking to the api
    // with the dead token while React unwinds. `replace` keeps the dead page
    // out of history so Back does not land on a shell that immediately bounces.
    navigate: (url) => window.location.replace(url),
  });
}

/** The production short-circuit check `apiClient` calls before every request. */
export function shouldShortCircuitInBrowser(token: string): boolean {
  if (typeof window === "undefined") return false;
  return shouldShortCircuit(token, window.location.pathname);
}
