/**
 * Per-tenant sign-in code (2FA-by-code) + Cloudflare Turnstile — the rules,
 * and the guards that pin them to the login route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LOGIN_CODE_EMAIL_TYPE,
  LOGIN_OTP_MAX_ATTEMPTS,
  OTP_SESSION_EXPIRES_IN,
  chooseChannels,
  decideOtpGate,
  decideOtpVerify,
  decideTrustedDevice,
  generateOtpCode,
  hashOtpCode,
  hashTrustedDeviceToken,
  maskDestination,
  mintTrustedDeviceToken,
  normalizeTenantOtpChannel,
  otpCodeMatches,
  otpSmsBody,
  trustedDeviceExpiry,
} from "./loginOtp";
import { OTP_PRE_AUTH_PURPOSE, PRE_AUTH_PURPOSE, mintPreAuthToken, verifyPreAuthToken } from "./preAuthToken";
import { isBrowserOnPlatformHost, turnstileGate, turnstileMode } from "../turnstile";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-that-is-long-enough-0123456789";

const src = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

// ─── the gate ─────────────────────────────────────────────────────────────────

test("gate: OFF tenant → nothing; TOTP user → nothing; trusted device → skip; else challenge", () => {
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: false, userHasTotp: false, trustedDevice: null }), { kind: "none" });
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: true, userHasTotp: true, trustedDevice: null }), { kind: "none" });
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: true, userHasTotp: false, trustedDevice: { valid: true } }), { kind: "trusted" });
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: true, userHasTotp: false, trustedDevice: { valid: false } }), { kind: "challenge" });
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: true, userHasTotp: false, trustedDevice: null }), { kind: "challenge" });
});

// ─── channels ─────────────────────────────────────────────────────────────────

test("channels: tenant setting × phone presence × request; a phoneless user is always emailable", () => {
  assert.deepEqual(chooseChannels("EITHER", true), { channels: ["SMS", "EMAIL"], preferred: "SMS" });
  assert.deepEqual(chooseChannels("EITHER", true, "EMAIL"), { channels: ["SMS", "EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels("EITHER", false), { channels: ["EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels("SMS", true), { channels: ["SMS"], preferred: "SMS" });
  assert.deepEqual(chooseChannels("SMS", false), { channels: ["EMAIL"], preferred: "EMAIL" }, "SMS-only tenant, no phone → email rather than lockout");
  assert.deepEqual(chooseChannels("EMAIL", true), { channels: ["EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels("EMAIL", true, "SMS"), { channels: ["EMAIL"], preferred: "EMAIL" }, "a request for a channel the tenant disallows is ignored");
  assert.equal(normalizeTenantOtpChannel("sms"), "SMS");
  assert.equal(normalizeTenantOtpChannel("junk"), "EITHER");
});

// ─── code + hash ──────────────────────────────────────────────────────────────

test("code: six digits, leading zeros kept, hash salted per challenge, constant-time compare", () => {
  for (let i = 0; i < 50; i++) assert.match(generateOtpCode(), /^\d{6}$/);
  const h1 = hashOtpCode("012345", "ch_a");
  const h2 = hashOtpCode("012345", "ch_b");
  assert.notEqual(h1, h2, "same code, different challenge → different hash");
  assert.equal(otpCodeMatches("012345", "ch_a", h1), true);
  assert.equal(otpCodeMatches("012 345", "ch_a", h1), true, "spaces are tolerated");
  assert.equal(otpCodeMatches("12345", "ch_a", h1), false, "five digits never matches");
  assert.equal(otpCodeMatches("012346", "ch_a", h1), false);
  assert.equal(otpCodeMatches("abcdef", "ch_a", h1), false);
});

test("verify decision: wrong login / consumed / expired / attempts / wrong code / ok", () => {
  const now = Date.now();
  const row = { id: "ch1", userId: "u1", preAuthJti: "j1", codeHash: hashOtpCode("111222", "ch1"), attempts: 0, expiresAt: new Date(now + 60_000), consumedAt: null };
  assert.deepEqual(decideOtpVerify(null, { userId: "u1", preAuthJti: "j1", code: "111222" }, now), { ok: false, reason: "no_challenge" });
  assert.deepEqual(decideOtpVerify(row, { userId: "u2", preAuthJti: "j1", code: "111222" }, now), { ok: false, reason: "wrong_login" });
  assert.deepEqual(decideOtpVerify(row, { userId: "u1", preAuthJti: "OTHER", code: "111222" }, now), { ok: false, reason: "wrong_login" }, "a code is bound to the login that requested it");
  assert.deepEqual(decideOtpVerify({ ...row, consumedAt: new Date(now) }, { userId: "u1", preAuthJti: "j1", code: "111222" }, now), { ok: false, reason: "consumed" });
  assert.deepEqual(decideOtpVerify(row, { userId: "u1", preAuthJti: "j1", code: "111222" }, now + 61_000), { ok: false, reason: "expired" });
  assert.deepEqual(decideOtpVerify({ ...row, attempts: LOGIN_OTP_MAX_ATTEMPTS }, { userId: "u1", preAuthJti: "j1", code: "111222" }, now), { ok: false, reason: "too_many_attempts" });
  assert.deepEqual(decideOtpVerify(row, { userId: "u1", preAuthJti: "j1", code: "999999" }, now), { ok: false, reason: "wrong_code" });
  assert.deepEqual(decideOtpVerify(row, { userId: "u1", preAuthJti: "j1", code: "111222" }, now), { ok: true });
});

// ─── remembered devices ───────────────────────────────────────────────────────

test("trusted device: random token, hash stored, 90-day expiry, bound to one user, revocable", () => {
  const a = mintTrustedDeviceToken(); const b = mintTrustedDeviceToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, hashTrustedDeviceToken(a.token));
  assert.ok(a.token.length >= 40);
  const now = Date.now();
  const exp = trustedDeviceExpiry(now);
  assert.equal(Math.round((exp.getTime() - now) / 86_400_000), 90);
  const row = { userId: "u1", expiresAt: exp, revokedAt: null };
  assert.equal(decideTrustedDevice(row, "u1", now).valid, true);
  assert.equal(decideTrustedDevice(row, "u2", now).valid, false, "never skips the code for someone else");
  assert.equal(decideTrustedDevice({ ...row, revokedAt: new Date(now) }, "u1", now).valid, false);
  assert.equal(decideTrustedDevice(row, "u1", exp.getTime() + 1).valid, false);
  assert.equal(decideTrustedDevice(null, "u1", now).valid, false);
});

test("masking + message text: no raw destination, no emoji in the SMS, sessions are 90 days", () => {
  assert.equal(maskDestination("SMS", "+18455551234"), "•••-•••-1234");
  assert.match(maskDestination("EMAIL", "izzy@example.com"), /^i•+@example\.com$/);
  assert.match(otpSmsBody("123456"), /^[\x20-\x7e]+$/, "plain ASCII, or the text splits into UCS-2 segments");
  assert.match(otpSmsBody("123456"), /123456/);
  assert.equal(OTP_SESSION_EXPIRES_IN, "90d");
  assert.notEqual(LOGIN_CODE_EMAIL_TYPE, "ADMIN_ALERT", "a customer email must never ride the muted type");
});

// ─── pre-auth token purposes are disjoint ─────────────────────────────────────

test("pre-auth: an OTP token is not a TOTP token and vice versa; default purpose unchanged", () => {
  const now = Date.now();
  const totp = mintPreAuthToken("u1", now);
  const otp = mintPreAuthToken("u1", now, OTP_PRE_AUTH_PURPOSE);
  assert.equal(verifyPreAuthToken(totp.token, now).ok, true, "default verify = default purpose (TOTP) — unchanged contract");
  assert.equal(verifyPreAuthToken(otp.token, now, OTP_PRE_AUTH_PURPOSE).ok, true);
  assert.deepEqual(verifyPreAuthToken(otp.token, now), { ok: false, reason: "wrong_purpose" });
  assert.deepEqual(verifyPreAuthToken(totp.token, now, OTP_PRE_AUTH_PURPOSE), { ok: false, reason: "wrong_purpose" });
  assert.ok(otp.jti && otp.jti.length > 8, "the jti is returned so the challenge can be bound to it");
  assert.notEqual(PRE_AUTH_PURPOSE, OTP_PRE_AUTH_PURPOSE);
});

// ─── Turnstile ────────────────────────────────────────────────────────────────

test("turnstile mode: off without a secret; observe by default; enforce only on TURNSTILE_ENFORCE=1", () => {
  assert.equal(turnstileMode({} as any), "off");
  assert.equal(turnstileMode({ TURNSTILE_SECRET_KEY: "s" } as any), "observe");
  assert.equal(turnstileMode({ TURNSTILE_SECRET_KEY: "s", TURNSTILE_ENFORCE: "1" } as any), "enforce");
  assert.equal(turnstileMode({ TURNSTILE_SECRET_KEY: "s", TURNSTILE_ENFORCE: "true" } as any), "observe", "only the literal 1 enforces");
});

test("turnstile: only a browser on OUR host is challenged; the mobile app (no Origin) never is", () => {
  assert.equal(isBrowserOnPlatformHost({ origin: "https://app.loopcom.net" }), true);
  assert.equal(isBrowserOnPlatformHost({ referer: "https://app.connectcomunications.com/login" }), true);
  assert.equal(isBrowserOnPlatformHost({}), false);
  assert.equal(isBrowserOnPlatformHost({ origin: "https://evil.example" }), false);
  assert.equal(isBrowserOnPlatformHost({ origin: "not a url" }), false);
});

test("turnstile gate: observe logs, enforce refuses; unavailable is a 503 not a 400", async () => {
  const hdr = { origin: "https://app.loopcom.net" };
  const okV = async () => ({ ok: true as const });
  const missing = async () => ({ ok: false as const, reason: "missing" as const });
  const invalid = async () => ({ ok: false as const, reason: "invalid" as const });
  const down = async () => ({ ok: false as const, reason: "unavailable" as const });
  assert.deepEqual(await turnstileGate({ headers: hdr, token: "", remoteIp: "1.2.3.4", mode: "off", verify: missing }), { action: "allow", note: "off" });
  assert.deepEqual(await turnstileGate({ headers: {}, token: "", remoteIp: "1.2.3.4", mode: "enforce", verify: missing }), { action: "allow", note: "not_browser" });
  assert.deepEqual(await turnstileGate({ headers: hdr, token: "t", remoteIp: "1.2.3.4", mode: "enforce", verify: okV }), { action: "allow", note: "verified" });
  assert.deepEqual(await turnstileGate({ headers: hdr, token: "", remoteIp: "1.2.3.4", mode: "observe", verify: missing }), { action: "allow", note: "observed_missing" });
  assert.deepEqual(await turnstileGate({ headers: hdr, token: "x", remoteIp: "1.2.3.4", mode: "observe", verify: invalid }), { action: "allow", note: "observed_invalid" });
  assert.deepEqual(await turnstileGate({ headers: hdr, token: "", remoteIp: "1.2.3.4", mode: "enforce", verify: missing }), { action: "refuse", status: 400, error: "human_check_required" });
  assert.deepEqual(await turnstileGate({ headers: hdr, token: "x", remoteIp: "1.2.3.4", mode: "enforce", verify: invalid }), { action: "refuse", status: 400, error: "human_check_failed" });
  assert.deepEqual(await turnstileGate({ headers: hdr, token: "x", remoteIp: "1.2.3.4", mode: "enforce", verify: down }), { action: "refuse", status: 503, error: "human_check_unavailable" });
});

// ─── wiring guards (source) ───────────────────────────────────────────────────

test("wiring: /auth/otp/verify + /auth/otp/resend are on the JWT bypass list — and only those two", () => {
  const s = stripComments(src("jwtPublicRouteBypass.ts"));
  assert.match(s, /"\/auth\/otp\/verify"/);
  assert.match(s, /"\/auth\/otp\/resend"/);
  const otpEntries = (s.match(/"\/auth\/otp\/[a-z-]+"/g) || []);
  assert.deepEqual(otpEntries.sort(), ['"/auth/otp/resend"', '"/auth/otp/verify"'], "the trusted-devices routes are session-gated and must NOT be bypassed");
});

test("wiring: login runs Turnstile after the throttle and before any DB read; the OTP gate after the TOTP decision", () => {
  const s = stripComments(src("server.ts"));
  const start = s.indexOf('app.post("/auth/login"');
  const body = s.slice(start, s.indexOf("async function issueLoginSession(", start));
  const throttleAt = body.indexOf("evaluateLoginAttempt(");
  const turnstileAt = body.indexOf("turnstileGate(");
  const lookupAt = body.indexOf("db.user.findUnique({ where: { email: emailKey } })");
  const totpAt = body.indexOf("decideLoginMfa(");
  const otpAt = body.indexOf("decideOtpGate(");
  const sessionAt = body.indexOf("issueLoginSession(user.id)");
  assert.ok(throttleAt > 0 && turnstileAt > throttleAt && lookupAt > turnstileAt, "throttle → turnstile → user lookup");
  assert.ok(totpAt > lookupAt && otpAt > totpAt && sessionAt > otpAt, "TOTP decision → OTP gate → session");
  assert.match(body, /startOtpChallenge\(otpDeps/);
  assert.match(body, /checkTrustedDevice\(otpDeps, user\.id, input\.trustedDeviceToken\)/);
});

test("wiring: sessions for an OTP tenant carry expiresIn 90d; everyone else is unchanged; routes registered", () => {
  const s = stripComments(src("server.ts"));
  const fn = s.slice(s.indexOf("async function issueLoginSession("), s.indexOf("const mfaDeps = buildMfaDeps("));
  assert.match(fn, /loginOtpRequired/);
  assert.match(fn, /expiresIn: OTP_SESSION_EXPIRES_IN/);
  assert.match(fn, /: app\.jwt\.sign\(\{ sub: user\.id, tenantId: user\.tenantId, email: user\.email, role: user\.role, name: displayNameForUser\(namedUser\) \}\);/, "the no-OTP branch signs exactly as before (no expiresIn)");
  assert.match(s, /await registerLoginOtpRoutes\(app, otpDeps\);/);
});

test("wiring: the login parser accepts the three optional fields and still refuses a short password", () => {
  const s = stripComments(src("loginRequest.ts"));
  for (const f of ["trustedDeviceToken", "turnstileToken", "otpChannel"]) assert.match(s, new RegExp(`${f}: z\\.string\\(\\)`));
  assert.match(s, /password: z\.string\(\)\.min\(LOGIN_PASSWORD_MIN_LENGTH\)/);
});

test("⛔ the OTP routes reach accessors that EXIST on the generated Prisma client (the `(db as any)` transposition trap)", async () => {
  const { Prisma } = await import("@prisma/client");
  const s = stripComments(src("mfa/loginOtpRoutes.ts"));
  const accessors = new Set([...s.matchAll(/\(db as any\)\.(\w+)\./g)].map((m) => m[1]));
  for (const a of ["loginOtpChallenge", "trustedLoginDevice", "emailJob", "tenant"]) assert.ok(accessors.has(a), `expected the routes to use db.${a}`);
  for (const a of accessors) {
    const model = a.charAt(0).toUpperCase() + a.slice(1);
    assert.equal((Prisma.ModelName as any)[model], model, `client.${a} must map to a real model — ${model} is missing from the generated client (run prisma generate / check the schema)`);
  }
});
