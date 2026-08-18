import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLoginRedirect,
  currentDeadToken,
  handleDeadSession,
  hasNavigatedToLogin,
  isDeadSessionResponse,
  isDesktopPassivePath,
  isPublicPortalPath,
  resetSessionExpiryStateForTests,
  SESSION_EXPIRED_EVENT,
  shouldShortCircuit,
  type DeadSessionDeps,
} from "./sessionExpiry";

/**
 * Step 1 of the token-expiry order (security audit §8.6): the portal must turn
 * a dead session into "please sign in", not into a 401 stream that gets the
 * customer's office IP banned. These tests cover the four things that matter:
 *
 *   1. ONLY a `401 { error: "unauthorized" }` sent WITH a token is "session
 *      dead" — a permission 403, a bad login, a bad signed URL are not;
 *   2. the handler runs ONCE per dead token however many pollers report it;
 *   3. public pages and desktop passive windows are never redirected;
 *   4. once dead, requests that would carry the dead token (or none) on an
 *      authenticated path are refused locally — that is how the pollers stop.
 *
 * Plus source-level guards on the CALL SITES, because every defect of this
 * shape in this codebase has been a caller: a classifier that is never called
 * from `apiClient`, a gate nobody listens to, a poller that ignores it.
 * ⛔ Source reads are CRLF-normalised (CLAUDE.md, 2026-08-18): this checkout
 * is CRLF on Windows and a literal `\n` slice fails there and only there.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8").replace(/\r\n/g, "\n");

beforeEach(() => resetSessionExpiryStateForTests());

// ── 1. The classifier ───────────────────────────────────────────────────────

test("a 401 { error: unauthorized } sent with a token IS a dead session", () => {
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "unauthorized" }, sentWithToken: true }), true);
  // Some route-level guards spell it differently; the meaning is the same.
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "Unauthorized" }, sentWithToken: true }), true);
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "UNAUTHORIZED" }, sentWithToken: true }), true);
});

test("a permission failure is NOT a dead session — the api answers 403 forbidden for those", () => {
  assert.equal(isDeadSessionResponse({ status: 403, body: { error: "forbidden" }, sentWithToken: true }), false);
  assert.equal(
    isDeadSessionResponse({ status: 403, body: { error: "forbidden", permission: "can_view_admin_tenants" }, sentWithToken: true }),
    false,
  );
});

test("the other 401 bodies the api can send are NOT a dead session", () => {
  // /auth/login on a wrong password — and it is sent with no token anyway.
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "invalid_credentials" }, sentWithToken: false }), false);
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "invalid_credentials" }, sentWithToken: true }), false);
  // A signed download URL whose HMAC did not verify.
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "bad_signature", reason: "expired" }, sentWithToken: true }), false);
  // Machine doors.
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "missing secret" }, sentWithToken: true }), false);
});

test("a 401 on a request that carried NO token says nothing about a session", () => {
  assert.equal(isDeadSessionResponse({ status: 401, body: { error: "unauthorized" }, sentWithToken: false }), false);
});

test("a 401 with no JSON body, or a non-401, is never a dead session", () => {
  assert.equal(isDeadSessionResponse({ status: 401, body: null, sentWithToken: true }), false);
  assert.equal(isDeadSessionResponse({ status: 401, body: "unauthorized", sentWithToken: true }), false);
  assert.equal(isDeadSessionResponse({ status: 401, body: {}, sentWithToken: true }), false);
  assert.equal(isDeadSessionResponse({ status: 200, body: { error: "unauthorized" }, sentWithToken: true }), false);
  assert.equal(isDeadSessionResponse({ status: 500, body: { error: "unauthorized" }, sentWithToken: true }), false);
});

// ── 2 + 3. The handler ──────────────────────────────────────────────────────

function fakeDeps(over: Partial<DeadSessionDeps> = {}) {
  const calls = { cleared: 0, dispatched: [] as string[], navigated: [] as string[] };
  const deps: DeadSessionDeps = {
    pathname: "/dashboard",
    search: "",
    isDesktopPassiveWindow: false,
    clearSession: () => { calls.cleared += 1; },
    dispatch: (name) => { calls.dispatched.push(name); },
    navigate: (url) => { calls.navigated.push(url); },
    ...over,
  };
  return { deps, calls };
}

test("dead session in a full window: session cleared, event fired, redirected to /login?next=<where they were>", () => {
  const { deps, calls } = fakeDeps({ pathname: "/voicemail", search: "?folder=inbox" });
  assert.equal(handleDeadSession("tok-A", deps), "redirected");
  assert.equal(calls.cleared, 1);
  assert.deepEqual(calls.dispatched, [SESSION_EXPIRED_EVENT]);
  assert.deepEqual(calls.navigated, [`/login?next=${encodeURIComponent("/voicemail?folder=inbox")}`]);
  assert.equal(hasNavigatedToLogin(), true);
  assert.equal(currentDeadToken(), "tok-A");
});

test("twenty concurrent 401s from twenty pollers = ONE clear and ONE redirect", () => {
  const { deps, calls } = fakeDeps();
  const outcomes = Array.from({ length: 20 }, () => handleDeadSession("tok-A", deps));
  assert.equal(outcomes[0], "redirected");
  assert.deepEqual(new Set(outcomes.slice(1)), new Set(["already_handled"]));
  assert.equal(calls.cleared, 1);
  assert.equal(calls.navigated.length, 1);
  assert.equal(calls.dispatched.length, 1);
});

test("a public page is NEVER redirected — the token is cleared and that is all", () => {
  for (const pathname of ["/login", "/p/PROBE000", "/pay/invoice/abc", "/pay/invoices/abc", "/privacy", "/onboarding/xyz", "/auth/password/reset", "/track/t1", "/forms/sign/t1"]) {
    resetSessionExpiryStateForTests();
    const { deps, calls } = fakeDeps({ pathname });
    assert.equal(handleDeadSession("tok-A", deps), "cleared", pathname);
    assert.equal(calls.cleared, 1, pathname);
    assert.deepEqual(calls.navigated, [], `${pathname} must not redirect`);
    assert.equal(hasNavigatedToLogin(), false, pathname);
  }
});

test("a desktop passive window (mini-dialer / phone-engine) is NEVER redirected — it waits for a fresh token", () => {
  const { deps, calls } = fakeDeps({ pathname: "/desktop/mini-dialer", isDesktopPassiveWindow: true });
  assert.equal(handleDeadSession("tok-A", deps), "waiting");
  assert.equal(calls.cleared, 1);
  assert.deepEqual(calls.dispatched, [SESSION_EXPIRED_EVENT], "AuthGate must still be told, so it drops the dialer and its pollers");
  assert.deepEqual(calls.navigated, []);
  // Even if the desktop flag were missing, the path alone protects it.
  resetSessionExpiryStateForTests();
  const second = fakeDeps({ pathname: "/desktop/phone-engine", isDesktopPassiveWindow: false });
  assert.equal(handleDeadSession("tok-A", second.deps), "waiting");
  assert.deepEqual(second.calls.navigated, []);
});

test("an empty token is never 'a dead session' — nothing to clear, nothing to redirect", () => {
  const { deps, calls } = fakeDeps();
  assert.equal(handleDeadSession("", deps), "already_handled");
  assert.equal(calls.cleared, 0);
  assert.deepEqual(calls.navigated, []);
});

test("a listener that throws cannot stop the redirect", () => {
  const { deps, calls } = fakeDeps({ dispatch: () => { throw new Error("listener blew up"); } });
  assert.equal(handleDeadSession("tok-A", deps), "redirected");
  assert.equal(calls.navigated.length, 1);
});

test("a DIFFERENT dead token (a new session that also died) is handled afresh", () => {
  const { deps, calls } = fakeDeps();
  handleDeadSession("tok-A", deps);
  assert.equal(handleDeadSession("tok-B", deps), "redirected");
  assert.equal(calls.cleared, 2);
});

test("buildLoginRedirect keeps the query string and falls back to /dashboard", () => {
  assert.equal(buildLoginRedirect("/ivr-studio", "?firstrun=1"), `/login?next=${encodeURIComponent("/ivr-studio?firstrun=1")}`);
  assert.equal(buildLoginRedirect("", ""), `/login?next=${encodeURIComponent("/dashboard")}`);
});

// ── 4. The short-circuit that stops the pollers ─────────────────────────────

test("before any dead session, nothing is short-circuited", () => {
  assert.equal(shouldShortCircuit("tok-A", "/dashboard"), false);
  assert.equal(shouldShortCircuit("", "/dashboard"), false);
});

test("after a dead session, the dead token AND an empty token are refused on authenticated paths", () => {
  handleDeadSession("tok-A", fakeDeps().deps);
  assert.equal(shouldShortCircuit("tok-A", "/dashboard"), true, "the dead token itself (an in-flight poller)");
  assert.equal(shouldShortCircuit("", "/dashboard"), true, "no token — the session was cleared, the poller has not unmounted yet");
  assert.equal(shouldShortCircuit("", "/desktop/mini-dialer"), true, "passive windows too");
});

test("…but NEVER on a public path — a stale-token visitor must still load the pay page", () => {
  handleDeadSession("tok-A", fakeDeps({ pathname: "/p/PROBE000" }).deps);
  assert.equal(shouldShortCircuit("", "/p/PROBE000"), false);
  assert.equal(shouldShortCircuit("", "/login"), false);
  assert.equal(shouldShortCircuit("tok-A", "/pay/invoice/abc"), false);
});

test("a NEW token (someone signed in again) re-arms everything, no reload needed", () => {
  handleDeadSession("tok-A", fakeDeps().deps);
  assert.equal(shouldShortCircuit("tok-B", "/dashboard"), false, "the fresh token goes through");
  assert.equal(currentDeadToken(), null, "the dead token is forgotten");
  assert.equal(hasNavigatedToLogin(), false);
  assert.equal(shouldShortCircuit("", "/dashboard"), false, "and the module is fully re-armed");
});

// ── Path classification ─────────────────────────────────────────────────────

test("public paths are recognised by prefix, exactly", () => {
  for (const p of ["/login", "/login/", "/auth", "/auth/invite/accept", "/p/X", "/pay/invoice/t", "/pay/invoices/t", "/onboarding/t", "/onboarding/t/success", "/track/t", "/forms/sign/t", "/privacy", "/ready", "/version"]) {
    assert.equal(isPublicPortalPath(p), true, p);
  }
  for (const p of ["/dashboard", "/voicemail", "/desktop/mini-dialer", "/pbx", "/payments", "/pending", "/loginx", "/authors", "/", ""]) {
    assert.equal(isPublicPortalPath(p), false, p);
  }
  assert.equal(isDesktopPassivePath("/desktop/mini-dialer"), true);
  assert.equal(isDesktopPassivePath("/desktop/phone-engine"), true);
  assert.equal(isDesktopPassivePath("/dashboard"), false);
});

// ── Source guards on the CALL SITES ─────────────────────────────────────────

test("apiClient funnels EVERY authenticated fetch through the dead-session handler, and refuses to send with a dead/empty token", () => {
  const src = read("../services/apiClient.ts");
  assert.match(src, /import \{[\s\S]*?handleDeadSessionInBrowser[\s\S]*?\} from "\.\.\/lib\/sessionExpiry"/);
  // The core request path: check before sending, note after receiving.
  const apiRequestBody = src.slice(src.indexOf("async function apiRequest<T>("), src.indexOf("export async function apiGet<T>("));
  assert.match(apiRequestBody, /const bearer = token \|\| browserToken\(\);\s*\n\s*if \(shouldShortCircuitInBrowser\(bearer\)\) throw sessionExpiredError\(\);/);
  assert.match(apiRequestBody, /noteUnauthorizedResponse\(res\.status, errPayload, bearer\);/);
  // The token that was CHECKED is the token that is SENT.
  assert.match(apiRequestBody, /authorization: `Bearer \$\{bearer\}`/);
  // Every other authenticated fetch in the file (blob + the multipart uploads) reports too.
  const sites = src.split("noteUnauthorizedResponse(res.status").length - 1;
  assert.ok(sites >= 7, `expected the handler at every non-2xx site in apiClient (apiRequest + apiFetchBlob + 5 uploads), found ${sites}`);
  // And the classifier is the ONLY thing deciding — no bare `status === 401` sign-out anywhere in the client.
  assert.doesNotMatch(src, /status === 401[^\n]*clearAuthSession/);
});

test("AuthGate listens for the session-expired event and drops the shell", () => {
  const src = read("../components/AuthGate.tsx");
  assert.match(src, /SESSION_EXPIRED_EVENT/);
  assert.match(src, /window\.addEventListener\(SESSION_EXPIRED_EVENT, onExpired\)/);
  assert.match(src, /hasNavigatedToLogin\(\)/, "the gate must not race the handler's hard navigation with a second client-side one");
  // The passive-window wait (storage event + 1 s poll) is still there — that is how the mini-dialer comes back after the next sign-in.
  assert.match(src, /window\.addEventListener\("storage", onStorage\)/);
});

test("the telephony socket stops on 1008 Unauthorized and asks /me before reconnecting; never opens a socket without a token", () => {
  const src = read("../hooks/useTelephonySocket.ts");
  assert.match(src, /import \{ probeSessionAlive \} from "\.\.\/services\/apiClient"/);
  assert.match(src, /ev\.code === 1008 && \/unauthori\[sz\]ed\/i\.test/);
  assert.match(src, /if \(isUnauthorizedClose\(ev\)\)[\s\S]*?probeSessionAlive\(\)[\s\S]*?verdict === "dead"[\s\S]*?return;/);
  assert.match(src, /const token = getToken\(\);\s*\n\s*if \(!token\) \{\s*\n\s*setStatus\("idle"\);\s*\n\s*return;/);
  assert.doesNotMatch(src, /token \? `\$\{url\}\?token=[^`]*` : url/, "the old 'connect without a token' fallback must not come back");
  assert.match(src, /addEventListener\("cc-portal-permissions-saved", onTokenMaybeArrived\)/, "a sign-in must be able to bring the feed back without a reload");
});

test("the globally-mounted pollers do nothing while signed out", () => {
  const bridge = read("../components/DesktopNotificationsBridge.tsx");
  const bridgePoll = bridge.slice(bridge.indexOf("const poll = async () => {"), bridge.indexOf("void poll();"));
  assert.match(bridgePoll, /if \(!hasBrowserAuthToken\(\)\) return;/, "DesktopNotificationsBridge polls every 30 s from providers.tsx, on /login too");

  const consent = read("../components/RemoteSupportConsent.tsx");
  const consentTick = consent.slice(consent.indexOf("const tick = async () => {"), consent.indexOf("void tick();"));
  assert.match(consentTick, /if \(!hasBrowserAuthToken\(\)\) return;/, "RemoteSupportConsent polls every 5 s — 60 401s per 5 min is exactly the ban threshold");

  const sip = read("../hooks/useSipPhone.ts");
  assert.match(sip, /if \(hasBrowserAuthToken\(\)\) fetchAccounts\(0\);/, "the extra-accounts fetch fired unauthenticated on /login");
  assert.match(sip, /if \(!hasBrowserAuthToken\(\)\) return;\s*\n[\s\S]{0,400}audioRef/, "the primary SIP init's own signed-out guard must stay");
});

test("the api contract this classifier rests on has not moved: JWT hook = 401 unauthorized, permission gate = 403 forbidden", () => {
  const server = read("../../api/src/server.ts");
  const hook = server.slice(server.indexOf('app.addHook("preHandler", async (req, reply) => {'), server.indexOf('app.get("/me",'));
  assert.match(hook, /await req\.jwtVerify\(\);\s*\n\s*\} catch \{\s*\n\s*return reply\.status\(401\)\.send\(\{ error: "unauthorized" \}\);/,
    "the portal signs people out on `401 { error: \"unauthorized\" }` — if this body changes, lib/sessionExpiry.ts must change with it");
  assert.match(hook, /return reply\.status\(403\)\.send\(\{ error: "forbidden", permission: portalPermission \}\);/,
    "the portal-permission gate must keep answering 403, never 401 — or opening a screen you lack permission for would sign you out");
  const requirePermission = server.slice(server.indexOf("async function requirePermission("), server.indexOf("async function requireAdmin("));
  assert.match(requirePermission, /reply\.status\(403\)\.send\(\{ error: "forbidden" \}\)/);
});
