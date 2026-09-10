/**
 * Sign in with Google (2026-09-10) — the rules, the three routes through a real
 * Fastify against a faked database + a faked Google, and the source guards on
 * the callers that a unit test of the module cannot see.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import jwt from "@fastify/jwt";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-google-login-0123456789abcdef";

import {
  GOOGLE_LOGIN_CALLBACK_PATH,
  GOOGLE_LOGIN_HANDOFF_TTL_SECONDS,
  GOOGLE_LOGIN_STATE_TTL_SECONDS,
  HandoffRegistry,
  buildGoogleAuthUrl,
  decideGoogleLogin,
  mintGoogleLoginHandoff,
  mintGoogleLoginState,
  readGoogleIdToken,
  safeNextPath,
  verifyGoogleLoginHandoff,
  verifyGoogleLoginState,
} from "./googleLogin";
import { registerGoogleLoginRoutes, type CompletedLogin, type GoogleLoginUserRow } from "./googleLoginRoutes";
import { shouldSkipJwtVerification } from "./jwtPublicRouteBypass";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const CLIENT_ID = "1004420523742-test.apps.googleusercontent.com";
const NOW = Date.parse("2026-09-10T15:00:00Z");

function fakeIdToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}
const goodClaims = (email: string, extra: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: Math.floor(NOW / 1000) + 3600,
  email,
  email_verified: true,
  sub: "google-sub-1",
  name: "Baila Test",
  ...extra,
});

// ── safeNextPath ─────────────────────────────────────────────────────────────

test("safeNextPath: in-app paths pass, everything else falls back", () => {
  assert.equal(safeNextPath("/crm/email"), "/crm/email");
  assert.equal(safeNextPath("/calls?x=1"), "/calls?x=1");
  for (const bad of ["", null, undefined, "https://evil.example", "//evil.example", "/\\evil", "/login", "/auth/x", "/a\r\nb", "x".repeat(600)]) {
    assert.equal(safeNextPath(bad), "/dashboard", `${String(bad).slice(0, 20)} must fall back`);
  }
});

// ── state ────────────────────────────────────────────────────────────────────

test("state: round-trips origin + next, expires at 10 minutes, refuses tampering and the wrong purpose", () => {
  const token = mintGoogleLoginState({ origin: "https://app.loopcom.net", next: "/calls" }, NOW);
  const ok = verifyGoogleLoginState(token, NOW + 1000);
  assert.ok(ok.ok);
  assert.equal(ok.claims.origin, "https://app.loopcom.net");
  assert.equal(ok.claims.next, "/calls");
  assert.equal(verifyGoogleLoginState(token, NOW + (GOOGLE_LOGIN_STATE_TTL_SECONDS + 1) * 1000).ok, false);
  const [h, p, s] = token.split(".");
  assert.equal(verifyGoogleLoginState(`${h}.${p}x.${s}`, NOW).ok, false);
  assert.equal(verifyGoogleLoginState(`${h}.${p}.${s.slice(0, -2)}aa`, NOW).ok, false);
  // A handoff code is not a state, whatever its signature says.
  const handoff = mintGoogleLoginHandoff("u1", NOW).code;
  const wrong = verifyGoogleLoginState(handoff, NOW);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "wrong_purpose");
  // A hostile next stored in a state is still sanitised on the way out.
  const evil = mintGoogleLoginState({ origin: "https://app.loopcom.net", next: "https://evil.example" }, NOW);
  const r = verifyGoogleLoginState(evil, NOW);
  assert.ok(r.ok && r.claims.next === "/dashboard");
});

// ── handoff ──────────────────────────────────────────────────────────────────

test("handoff: 60-second life, single use via the registry, never accepted as a state", () => {
  const { code, jti } = mintGoogleLoginHandoff("u_baila", NOW);
  const ok = verifyGoogleLoginHandoff(code, NOW + 5000);
  assert.ok(ok.ok && ok.claims.sub === "u_baila" && ok.claims.jti === jti);
  assert.equal(verifyGoogleLoginHandoff(code, NOW + (GOOGLE_LOGIN_HANDOFF_TTL_SECONDS + 1) * 1000).ok, false);
  const reg = new HandoffRegistry();
  assert.equal(reg.claim(jti, NOW + 60_000, NOW), true);
  assert.equal(reg.claim(jti, NOW + 60_000, NOW + 1), false, "second claim is a replay");
  const state = mintGoogleLoginState({ origin: "https://app.loopcom.net", next: "/" }, NOW);
  assert.equal(verifyGoogleLoginHandoff(state, NOW).ok, false);
});

test("handoff registry: sweeps expired entries so memory stays bounded", () => {
  const reg = new HandoffRegistry();
  for (let i = 0; i < 300; i++) reg.claim(`old${i}`, NOW + 1000, NOW);
  assert.equal(reg.size, 300);
  reg.claim("fresh", NOW + 100_000, NOW + 5000); // sweep runs at ≥256 entries
  assert.equal(reg.size, 1);
});

// ── the Google side ──────────────────────────────────────────────────────────

test("buildGoogleAuthUrl: sign-in scopes only, account chooser, no offline access", () => {
  const u = new URL(buildGoogleAuthUrl({ clientId: CLIENT_ID, redirectUri: "https://app.loopcom.net/api/auth/google/callback", state: "s" }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), "openid email profile");
  assert.equal(u.searchParams.get("prompt"), "select_account");
  assert.equal(u.searchParams.get("access_type"), "online");
  assert.equal(u.searchParams.get("include_granted_scopes"), "false");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.loopcom.net/api/auth/google/callback");
  assert.doesNotMatch(u.searchParams.get("scope")!, /gmail|drive/);
});

test("readGoogleIdToken: accepts a verified Google identity, refuses every other shape", () => {
  const ok = readGoogleIdToken(fakeIdToken(goodClaims("Baila@Acme.Test")), { clientId: CLIENT_ID, nowMs: NOW });
  assert.ok(ok.ok);
  assert.equal(ok.identity.email, "baila@acme.test");
  assert.equal(ok.identity.googleSub, "google-sub-1");
  const refuse = (claims: Record<string, unknown>, reason: string) => {
    const r = readGoogleIdToken(fakeIdToken(claims), { clientId: CLIENT_ID, nowMs: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, reason);
  };
  refuse(goodClaims("b@acme.test", { email_verified: false }), "email_unverified");
  refuse(goodClaims("b@acme.test", { email_verified: "true" }), "email_unverified");
  refuse(goodClaims("b@acme.test", { aud: "someone-else" }), "wrong_audience");
  refuse(goodClaims("b@acme.test", { iss: "https://evil.example" }), "wrong_issuer");
  refuse(goodClaims("b@acme.test", { exp: Math.floor(NOW / 1000) - 1 }), "expired");
  refuse(goodClaims("", {}), "email_missing");
  assert.equal(readGoogleIdToken("not.a.jwt.at.all", { clientId: CLIENT_ID, nowMs: NOW }).ok, false);
  assert.equal(readGoogleIdToken(undefined, { clientId: CLIENT_ID, nowMs: NOW }).ok, false);
});

// ── the policy ───────────────────────────────────────────────────────────────

test("decideGoogleLogin: no row → not registered; DISABLED → disabled; INVITED and ACTIVE → ok", () => {
  assert.deepEqual(decideGoogleLogin(null), { kind: "not_registered" });
  assert.deepEqual(decideGoogleLogin(undefined), { kind: "not_registered" });
  assert.deepEqual(decideGoogleLogin({ status: "DISABLED" }), { kind: "disabled" });
  assert.deepEqual(decideGoogleLogin({ status: "INVITED" }), { kind: "ok" });
  assert.deepEqual(decideGoogleLogin({ status: "ACTIVE" }), { kind: "ok" });
});

// ── routes ───────────────────────────────────────────────────────────────────

type Harness = {
  app: ReturnType<typeof Fastify>;
  users: GoogleLoginUserRow[];
  google: { tokenStatus: number; idToken: string | null; calls: URLSearchParams[] };
  completions: Array<{ user: GoogleLoginUserRow; input: unknown }>;
  audits: Array<{ action: string; entityId: string }>;
  created: number;
  now: number;
  registry: HandoffRegistry;
};

async function buildHarness(opts: { configured?: boolean; complete?: (u: GoogleLoginUserRow) => CompletedLogin } = {}): Promise<Harness> {
  const h: Harness = {
    app: Fastify(),
    users: [
      { id: "u_baila", tenantId: "t_acme", email: "baila@acme.test", role: "USER", status: "ACTIVE", phone: null, loginOtpEnabledAt: null },
      { id: "u_new", tenantId: "t_acme", email: "office@acme.test", role: "USER", status: "INVITED", phone: null, loginOtpEnabledAt: null },
      { id: "u_gone", tenantId: "t_acme", email: "gone@acme.test", role: "USER", status: "DISABLED", phone: null, loginOtpEnabledAt: null },
      { id: "u_mixed", tenantId: "t_acme", email: "Mixed@Acme.Test", role: "USER", status: "ACTIVE", phone: null, loginOtpEnabledAt: null },
    ],
    google: { tokenStatus: 200, idToken: null, calls: [] },
    completions: [],
    audits: [],
    created: 0,
    now: NOW,
    registry: new HandoffRegistry(),
  };
  await h.app.register(jwt, { secret: process.env.JWT_SECRET! });
  h.app.addHook("preHandler", async (req: any, reply: any) => {
    const p = req.url.split("?")[0];
    if (shouldSkipJwtVerification(p)) return;
    try { await req.jwtVerify(); } catch { return reply.status(401).send({ error: "unauthorized" }); }
  });
  const db = {
    user: {
      findUnique: async ({ where }: any) => {
        if (where.id) return h.users.find((u) => u.id === where.id) ?? null;
        return h.users.find((u) => u.email === where.email) ?? null;
      },
      findFirst: async ({ where }: any) => {
        const eq = where?.email?.equals;
        return h.users.find((u) => u.email.toLowerCase() === String(eq).toLowerCase()) ?? null;
      },
      // ⛔ The one rule: nothing on this path may create a user. A create here is a test failure.
      create: async () => { h.created += 1; throw new Error("user.create must never be called by Google login"); },
      upsert: async () => { h.created += 1; throw new Error("user.upsert must never be called by Google login"); },
    },
  };
  await registerGoogleLoginRoutes(h.app, {
    db: db as any,
    log: { warn: () => {}, info: () => {} },
    audit: async (p) => { h.audits.push({ action: p.action, entityId: p.entityId }); },
    completeLogin: async (user, input) => {
      h.completions.push({ user, input });
      return opts.complete ? opts.complete(user) : { status: 200, outcome: "session", body: { token: `session-for-${user.id}` } };
    },
    portalOriginForRequest: (req) => `https://${String(req.headers?.host ?? "app.loopcom.net")}`,
    googleClient: () => (opts.configured === false ? null : { clientId: CLIENT_ID, clientSecret: "shh" }),
    fetchImpl: (async (_url: any, init: any) => {
      h.google.calls.push(new URLSearchParams(String(init?.body)));
      const body = h.google.tokenStatus === 200 ? { id_token: h.google.idToken, access_token: "at", token_type: "Bearer" } : { error: "invalid_grant" };
      return { ok: h.google.tokenStatus === 200, status: h.google.tokenStatus, json: async () => body } as any;
    }) as any,
    now: () => h.now,
    registry: h.registry,
  });
  return h;
}

const q = (location: string) => new URL(location).searchParams;

test("GET /auth/google/start: 302 to Google with the caller's own hostname as the callback, state that verifies", async () => {
  const h = await buildHarness();
  for (const host of ["app.loopcom.net", "app.connectcomunications.com"]) {
    const res = await h.app.inject({ method: "GET", url: "/auth/google/start?next=%2Fcalls", headers: { host } });
    assert.equal(res.statusCode, 302);
    const u = new URL(res.headers.location as string);
    assert.equal(u.hostname, "accounts.google.com");
    assert.equal(u.searchParams.get("redirect_uri"), `https://${host}${GOOGLE_LOGIN_CALLBACK_PATH}`);
    assert.equal(u.searchParams.get("scope"), "openid email profile");
    const st = verifyGoogleLoginState(u.searchParams.get("state"), h.now);
    assert.ok(st.ok && st.claims.next === "/calls" && st.claims.origin === `https://${host}`);
  }
  await h.app.close();
});

test("GET /auth/google/start: not configured → back to /login with google_error=not_configured, never a 5xx", async () => {
  const h = await buildHarness({ configured: false });
  const res = await h.app.inject({ method: "GET", url: "/auth/google/start", headers: { host: "app.loopcom.net" } });
  assert.equal(res.statusCode, 302);
  assert.equal(q(res.headers.location as string).get("google_error"), "not_configured");
  await h.app.close();
});

async function callback(h: Harness, params: Record<string, string>, host = "app.loopcom.net") {
  const url = "/auth/google/callback?" + new URLSearchParams(params).toString();
  return h.app.inject({ method: "GET", url, headers: { host } });
}
const state = (h: Harness, next = "/calls", origin = "https://app.loopcom.net") => mintGoogleLoginState({ origin, next }, h.now);

test("callback: a registered, verified address → handoff code on /login; nothing is created", async () => {
  const h = await buildHarness();
  h.google.idToken = fakeIdToken(goodClaims("baila@acme.test"));
  const res = await callback(h, { code: "authcode", state: state(h) });
  assert.equal(res.statusCode, 302);
  const loc = new URL(res.headers.location as string);
  assert.equal(loc.origin + loc.pathname, "https://app.loopcom.net/login");
  assert.equal(loc.searchParams.get("next"), "/calls");
  const handoff = verifyGoogleLoginHandoff(loc.searchParams.get("g"), h.now);
  assert.ok(handoff.ok && handoff.claims.sub === "u_baila");
  assert.equal(h.created, 0);
  assert.equal(h.google.calls[0].get("redirect_uri"), "https://app.loopcom.net/api/auth/google/callback");
  assert.equal(h.google.calls[0].get("grant_type"), "authorization_code");
  assert.ok(h.audits.some((a) => a.action === "USER_GOOGLE_LOGIN_VERIFIED" && a.entityId === "u_baila"));
  await h.app.close();
});

test("callback: an INVITED person (email just added to an extension) gets a handoff; a mixed-case row still matches", async () => {
  const h = await buildHarness();
  for (const [email, id] of [["office@acme.test", "u_new"], ["mixed@acme.test", "u_mixed"]] as const) {
    h.google.idToken = fakeIdToken(goodClaims(email));
    const res = await callback(h, { code: "c", state: state(h) });
    const handoff = verifyGoogleLoginHandoff(q(res.headers.location as string).get("g"), h.now);
    assert.ok(handoff.ok && handoff.claims.sub === id, `${email} → ${id}`);
  }
  await h.app.close();
});

test("callback: an address that is NOT on Loopcom is told so — no handoff, no user created, no 401", async () => {
  const h = await buildHarness();
  h.google.idToken = fakeIdToken(goodClaims("stranger@gmail.test"));
  const res = await callback(h, { code: "c", state: state(h) });
  assert.equal(res.statusCode, 302);
  const p = q(res.headers.location as string);
  assert.equal(p.get("google_error"), "not_registered");
  assert.equal(p.get("g"), null);
  assert.equal(h.created, 0);
  assert.equal(h.audits.length, 0);
  await h.app.close();
});

test("callback: DISABLED → disabled; unverified Google email → email_unverified; each without a handoff", async () => {
  const h = await buildHarness();
  h.google.idToken = fakeIdToken(goodClaims("gone@acme.test"));
  let res = await callback(h, { code: "c", state: state(h) });
  assert.equal(q(res.headers.location as string).get("google_error"), "disabled");
  h.google.idToken = fakeIdToken(goodClaims("baila@acme.test", { email_verified: false }));
  res = await callback(h, { code: "c", state: state(h) });
  assert.equal(q(res.headers.location as string).get("google_error"), "email_unverified");
  assert.equal(q(res.headers.location as string).get("g"), null);
  await h.app.close();
});

test("callback: forged/expired state, Cancel on Google, and a failed token exchange all bounce with a reason and never call Google with a bad state", async () => {
  const h = await buildHarness();
  h.google.idToken = fakeIdToken(goodClaims("baila@acme.test"));
  let res = await callback(h, { code: "c", state: "forged.state.value" });
  assert.equal(q(res.headers.location as string).get("google_error"), "expired");
  assert.equal(h.google.calls.length, 0, "no token exchange on a bad state");
  res = await callback(h, { code: "c", state: mintGoogleLoginState({ origin: "https://app.loopcom.net", next: "/" }, h.now - (GOOGLE_LOGIN_STATE_TTL_SECONDS + 5) * 1000) });
  assert.equal(q(res.headers.location as string).get("google_error"), "expired");
  res = await callback(h, { error: "access_denied", state: state(h) });
  assert.equal(q(res.headers.location as string).get("google_error"), "cancelled");
  assert.equal(h.google.calls.length, 0);
  h.google.tokenStatus = 400;
  res = await callback(h, { code: "bad", state: state(h) });
  assert.equal(q(res.headers.location as string).get("google_error"), "google_failed");
  await h.app.close();
});

test("callback: the ID token's audience must be OUR client — a token minted for another app is refused", async () => {
  const h = await buildHarness();
  h.google.idToken = fakeIdToken(goodClaims("baila@acme.test", { aud: "another-app" }));
  const res = await callback(h, { code: "c", state: state(h) });
  assert.equal(q(res.headers.location as string).get("google_error"), "google_failed");
  assert.equal(q(res.headers.location as string).get("g"), null);
  await h.app.close();
});

test("POST /auth/google/complete: trades the handoff for the ordinary login body through the shared chain, once", async () => {
  const h = await buildHarness();
  const { code } = mintGoogleLoginHandoff("u_baila", h.now);
  const res = await h.app.inject({ method: "POST", url: "/auth/google/complete", payload: { code, otpChannel: "SMS" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { token: "session-for-u_baila" });
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].user.id, "u_baila");
  assert.deepEqual(h.completions[0].input, { otpChannel: "SMS", via: "google" });
  assert.ok(h.audits.some((a) => a.action === "USER_GOOGLE_LOGIN"));
  // Replay from browser history: refused, and the chain is not run again.
  const again = await h.app.inject({ method: "POST", url: "/auth/google/complete", payload: { code } });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error, "google_login_used");
  assert.equal(h.completions.length, 1);
  await h.app.close();
});

test("POST /auth/google/complete: the chain's own answer is passed through — an OTP challenge or a 403 arrives unchanged", async () => {
  const h = await buildHarness({ complete: () => ({ status: 200, outcome: "otp_challenge", body: { otpChallengeRequired: true, preAuthToken: "p", error: "otp_required" } }) });
  const res = await h.app.inject({ method: "POST", url: "/auth/google/complete", payload: { code: mintGoogleLoginHandoff("u_baila", h.now).code } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().otpChallengeRequired, true);
  assert.ok(!h.audits.some((a) => a.action === "USER_GOOGLE_LOGIN"), "not a completed sign-in yet");
  const h2 = await buildHarness({ complete: () => ({ status: 403, outcome: "disabled", body: { error: "account_disabled" } }) });
  const res2 = await h2.app.inject({ method: "POST", url: "/auth/google/complete", payload: { code: mintGoogleLoginHandoff("u_baila", h2.now).code } });
  assert.equal(res2.statusCode, 403);
  await h.app.close();
  await h2.app.close();
});

test("POST /auth/google/complete: forged, expired, wrong-purpose, or for a user disabled since → 400, NEVER 401", async () => {
  const h = await buildHarness();
  const cases = [
    { code: "junk" },
    { code: mintGoogleLoginHandoff("u_baila", h.now - (GOOGLE_LOGIN_HANDOFF_TTL_SECONDS + 5) * 1000).code },
    { code: mintGoogleLoginState({ origin: "https://app.loopcom.net", next: "/" }, h.now) },
    { code: mintGoogleLoginHandoff("u_gone", h.now).code },
    { code: mintGoogleLoginHandoff("u_nobody", h.now).code },
    {},
  ];
  for (const payload of cases) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google/complete", payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 40));
    assert.notEqual(res.statusCode, 401);
  }
  assert.equal(h.completions.length, 0);
  await h.app.close();
});

test("bypass: all three Google routes skip the JWT hook (with and without the /api prefix); a lookalike does not", () => {
  for (const p of ["/auth/google/start", "/auth/google/callback", "/auth/google/complete"]) {
    assert.equal(shouldSkipJwtVerification(p), true, p);
    assert.equal(shouldSkipJwtVerification(`/api${p}`), true, `/api${p}`);
  }
  assert.equal(shouldSkipJwtVerification("/auth/google/startx"), false);
  assert.equal(shouldSkipJwtVerification("/auth/google"), false);
});

// ── source guards ────────────────────────────────────────────────────────────
// The defects this feature is most likely to regress into are CALLER-side —
// a route registered without the bypass, a login door that mints its own
// session, or a scope quietly pushed back into the Gmail connect — none of which
// a unit test of the module can see.

const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
const stripLineComments = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("guard: server.ts registers the Google routes with the SAME post-credential chain /auth/login uses", () => {
  const src = stripLineComments(read("./server.ts"));
  assert.match(src, /registerGoogleLoginRoutes\(app, \{[\s\S]*?completeLogin: completeLoginAfterPrimaryFactor/);
  // /auth/login itself now runs the shared function — the password door must not keep its own copy.
  const login = src.slice(src.indexOf('app.post("/auth/login"'), src.indexOf("async function completeLoginAfterPrimaryFactor"));
  assert.match(login, /await completeLoginAfterPrimaryFactor\(user, \{ otpChannel: input\.otpChannel, via: "password" \}\)/);
  assert.doesNotMatch(login, /issueLoginSession\(/, "the password door must not mint its own session outside the shared chain");
  assert.doesNotMatch(login, /decideOtpGate\(/, "the sign-in-code gate lives in the shared chain only");
});

test("guard: the Google routes never mint a session or create a user themselves", () => {
  const src = stripLineComments(read("./googleLoginRoutes.ts"));
  assert.doesNotMatch(src, /jwt\.sign|issueLoginSession|user\.(create|upsert)\(/);
  assert.match(src, /deps\.completeLogin\(user/);
});

test("guard: the Gmail connect asks for gmail.send only — no restricted scope can come back", () => {
  const email = stripLineComments(read("./crm/emailRoutes.ts"));
  const start = email.slice(email.indexOf('app.post("/crm/email/oauth/start"'), email.indexOf('app.get("/crm/email/oauth/callback"'));
  assert.doesNotMatch(start, /gmail\.readonly|gmail\.modify|drive\./);
  assert.match(start, /const enableReplyTracking = false;/);
  assert.match(start, /"https:\/\/www\.googleapis\.com\/auth\/gmail\.send"/);
});

test("guard: Drive import refuses BEFORE any env/crypto check, and the status carries the reason", () => {
  const drive = stripLineComments(read("./crm/driveRoutes.ts"));
  const start = drive.slice(drive.indexOf('app.post("/crm/drive/oauth/start"'), drive.indexOf('app.get("/crm/drive/oauth/callback"'));
  const refuseAt = start.indexOf("DRIVE_IMPORT_AVAILABLE");
  const cryptoAt = start.indexOf("cryptoReady");
  assert.ok(refuseAt > 0 && cryptoAt > 0 && refuseAt < cryptoAt, "the refusal must come first");
  assert.match(drive, /export const DRIVE_IMPORT_AVAILABLE = false;/);
  assert.match(drive, /driveImportAvailable: DRIVE_IMPORT_AVAILABLE/);
});

test("guard: the portal no longer asks the api for reply tracking on connect", () => {
  const portalDir = path.join(__dirname, "../../portal/app/(platform)/crm");
  const emailPage = readFileSync(path.join(portalDir, "email/page.tsx"), "utf8").replace(/\r\n/g, "\n");
  const settingsPage = readFileSync(path.join(portalDir, "email/settings/page.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(stripLineComments(emailPage), /enableReplyTracking:\s*true/);
  assert.doesNotMatch(stripLineComments(settingsPage), /enableReplyTracking:\s*Boolean\(enableReplyTracking\)/);
});
