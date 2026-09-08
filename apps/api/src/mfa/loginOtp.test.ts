/**
 * Per-tenant sign-in code (2FA-by-code) + Cloudflare Turnstile — the rules,
 * and the guards that pin them to the login route.
 *
 * v2 (2026-09-08): the person chooses text or email; no "remember this
 * device"; no session expiry — signing out is the only thing that ends it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LOGIN_CODE_EMAIL_TYPE,
  LOGIN_OTP_MAX_ATTEMPTS,
  chooseChannels,
  decideChallengeReuse,
  decideFirstSend,
  decideOtpGate,
  decideOtpVerify,
  generateOtpCode,
  hashOtpCode,
  maskDestination,
  normalizeOtpChannel,
  normalizeTenantOtpChannel,
  offerChannels,
  otpCodeMatches,
  otpSmsBody,
} from "./loginOtp";
import { OTP_PRE_AUTH_PURPOSE, PRE_AUTH_PURPOSE, mintPreAuthToken, verifyPreAuthToken } from "./preAuthToken";
import { isBrowserOnPlatformHost, turnstileGate, turnstileMode } from "../turnstile";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-that-is-long-enough-0123456789";

const src = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

// ─── the gate ─────────────────────────────────────────────────────────────────

test("gate (v2): OFF tenant → nothing; TOTP user → nothing; otherwise a code EVERY sign-in — there is no trusted-device skip any more", () => {
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: false, userHasTotp: false }), { kind: "none" });
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: true, userHasTotp: true }), { kind: "none" });
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: true, userHasTotp: false }), { kind: "challenge" });
  // A stray v1 field must not resurrect the skip.
  assert.deepEqual(decideOtpGate({ tenantOtpRequired: true, userHasTotp: false, trustedDevice: { valid: true } } as any), { kind: "challenge" });
});

// ─── channels ─────────────────────────────────────────────────────────────────

test("channels: tenant setting × phone presence × request; a phoneless user is always emailable", () => {
  assert.deepEqual(chooseChannels("EITHER", true), { channels: ["SMS", "EMAIL"], preferred: "SMS" });
  assert.deepEqual(chooseChannels("EITHER", true, "EMAIL"), { channels: ["SMS", "EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels("EITHER", true, "email"), { channels: ["SMS", "EMAIL"], preferred: "EMAIL" }, "case-insensitive");
  assert.deepEqual(chooseChannels("EITHER", false), { channels: ["EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels("SMS", true), { channels: ["SMS"], preferred: "SMS" });
  assert.deepEqual(chooseChannels("SMS", false), { channels: ["EMAIL"], preferred: "EMAIL" }, "SMS-only tenant, no phone → email rather than lockout");
  assert.deepEqual(chooseChannels("EMAIL", true), { channels: ["EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels("EMAIL", true, "SMS"), { channels: ["EMAIL"], preferred: "EMAIL" }, "a request for a channel the tenant disallows is ignored");
  assert.equal(normalizeTenantOtpChannel("sms"), "SMS");
  assert.equal(normalizeTenantOtpChannel("junk"), "EITHER");
  assert.equal(normalizeOtpChannel(" email "), "EMAIL");
  assert.equal(normalizeOtpChannel("pigeon"), null);
});

test("v2 offer: every offered channel comes with its MASKED registered destination — the chooser never sees a raw phone or email", () => {
  assert.deepEqual(offerChannels("EITHER", "+18455551234", "baila@acme.test"), {
    channels: ["SMS", "EMAIL"],
    destinations: { SMS: "•••-•••-1234", EMAIL: "b••••@acme.test" },
  });
  assert.deepEqual(offerChannels("EITHER", null, "office@acme.test"), { channels: ["EMAIL"], destinations: { EMAIL: "o•••••@acme.test" } });
  assert.deepEqual(offerChannels("SMS", "+18455551234", "baila@acme.test"), { channels: ["SMS"], destinations: { SMS: "•••-•••-1234" } });
  const raw = JSON.stringify(offerChannels("EITHER", "+18455551234", "baila@acme.test"));
  assert.equal(raw.includes("8455551234"), false);
  assert.equal(raw.includes("baila@"), false);
});

test("v2 first send: two channels and no request → CHOOSE (send nothing); a named allowed channel or a single channel → send now", () => {
  assert.deepEqual(decideFirstSend(["SMS", "EMAIL"]), { kind: "choose" });
  assert.deepEqual(decideFirstSend(["SMS", "EMAIL"], "EMAIL"), { kind: "send", channel: "EMAIL" });
  assert.deepEqual(decideFirstSend(["SMS", "EMAIL"], "sms"), { kind: "send", channel: "SMS" });
  assert.deepEqual(decideFirstSend(["SMS", "EMAIL"], "PIGEON"), { kind: "choose" }, "an unknown request is not a choice");
  assert.deepEqual(decideFirstSend(["EMAIL"]), { kind: "send", channel: "EMAIL" }, "one channel → nothing to choose");
  assert.deepEqual(decideFirstSend(["EMAIL"], "SMS"), { kind: "send", channel: "EMAIL" }, "a request for a channel that is not offered falls back to the only one");
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

test("masking + message text: no raw destination, no emoji in the SMS", () => {
  assert.equal(maskDestination("SMS", "+18455551234"), "•••-•••-1234");
  assert.match(maskDestination("EMAIL", "izzy@example.com"), /^i•+@example\.com$/);
  assert.match(otpSmsBody("123456"), /^[\x20-\x7e]+$/, "plain ASCII, or the text splits into UCS-2 segments");
  assert.match(otpSmsBody("123456"), /123456/);
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

test("wiring: /auth/otp/send + /verify + /resend are on the JWT bypass list — and only those three", () => {
  const s = stripComments(src("jwtPublicRouteBypass.ts"));
  assert.match(s, /"\/auth\/otp\/send"/);
  assert.match(s, /"\/auth\/otp\/verify"/);
  assert.match(s, /"\/auth\/otp\/resend"/);
  const otpEntries = (s.match(/"\/auth\/otp\/[a-z-]+"/g) || []);
  assert.deepEqual(otpEntries.sort(), ['"/auth/otp/resend"', '"/auth/otp/send"', '"/auth/otp/verify"'], "nothing else under /auth/otp/ may skip the JWT hook");
});

test("wiring: login runs Turnstile after the throttle and before any DB read; the OTP gate after the TOTP decision; NO trusted-device read", () => {
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
  assert.match(body, /decideOtpGate\(\{ tenantOtpRequired: true, userHasTotp: false \}\)/);
  assert.match(body, /startOtpChallenge\(otpDeps/);
  assert.match(body, /requestedChannel: input\.otpChannel/);
  assert.doesNotMatch(body, /checkTrustedDevice|trustedDeviceToken/, "v2: no remembered-device skip in the login handler");
  assert.doesNotMatch(s, /checkTrustedDevice/, "v2: the helper is gone from server.ts entirely");
});

test("wiring (v2): every session is signed ONE way — no expiresIn, no per-tenant lookup in issueLoginSession; routes registered", () => {
  const s = stripComments(src("server.ts"));
  const fn = s.slice(s.indexOf("async function issueLoginSession("), s.indexOf("const mfaDeps = buildMfaDeps("));
  assert.doesNotMatch(fn, /expiresIn/, "no expiry on any session (Izzy 2026-09-08: 'there is no expiry')");
  assert.doesNotMatch(fn, /loginOtpRequired|OTP_SESSION/, "the 90-day OTP-tenant branch is gone");
  assert.match(fn, /const token = app\.jwt\.sign\(\{ sub: user\.id, tenantId: user\.tenantId, email: user\.email, role: user\.role, name: displayNameForUser\(namedUser\) \}\);/, "the one sign call, exactly as the pre-2FA platform signed");
  assert.equal((fn.match(/app\.jwt\.sign\(/g) || []).length, 1, "exactly one sign call");
  assert.doesNotMatch(s, /OTP_SESSION_EXPIRES_IN/);
  assert.match(s, /await registerLoginOtpRoutes\(app, otpDeps\);/);
});

test("wiring: the login parser accepts turnstileToken + otpChannel, no longer knows trustedDeviceToken, and still refuses a short password", () => {
  const s = stripComments(src("loginRequest.ts"));
  for (const f of ["turnstileToken", "otpChannel"]) assert.match(s, new RegExp(`${f}: z\\.string\\(\\)`));
  assert.doesNotMatch(s, /trustedDeviceToken/);
  assert.match(s, /password: z\.string\(\)\.min\(LOGIN_PASSWORD_MIN_LENGTH\)/);
});

test("⛔ v2 removed the trusted device from the CODE, not just the UI: nothing in the OTP module reads, mints or honours one", () => {
  for (const rel of ["mfa/loginOtp.ts", "mfa/loginOtpRoutes.ts"]) {
    const s = stripComments(src(rel));
    assert.doesNotMatch(s, /trustedLoginDevice|TrustedDevice|rememberDevice|trusted-devices/i, `${rel} must not touch remembered devices`);
    assert.doesNotMatch(s, /expiresIn:|OTP_SESSION/, `${rel} must not put an expiry on a session`);
  }
});

test("⛔ the OTP routes reach accessors that EXIST on the generated Prisma client (the `(db as any)` transposition trap)", async () => {
  const { Prisma } = await import("@prisma/client");
  const s = stripComments(src("mfa/loginOtpRoutes.ts"));
  const accessors = new Set([...s.matchAll(/\(db as any\)\.(\w+)\./g)].map((m) => m[1]));
  for (const a of ["loginOtpChallenge", "emailJob", "tenant"]) assert.ok(accessors.has(a), `expected the routes to use db.${a}`);
  assert.equal(accessors.has("trustedLoginDevice"), false, "v2: the routes never read TrustedLoginDevice");
  for (const a of accessors) {
    const model = a.charAt(0).toUpperCase() + a.slice(1);
    assert.equal((Prisma.ModelName as any)[model], model, `client.${a} must map to a real model — ${model} is missing from the generated client (run prisma generate / check the schema)`);
  }
});

// ─── hardening pass (2026-08-19): the adversarial findings ───────────────────

test("reuse: a live code is re-bound, not re-sent — so hitting /auth/login or /auth/otp/send in a loop cannot spend the SMS balance", () => {
  const now = Date.now();
  const live = { attempts: 0, consumedAt: null as Date | null, expiresAt: new Date(now + 60_000) };
  assert.deepEqual(decideChallengeReuse(live, now), { reuse: true });
  assert.deepEqual(decideChallengeReuse(null, now), { reuse: false }, "nothing to reuse → send one");
  assert.deepEqual(decideChallengeReuse({ ...live, consumedAt: new Date(now) }, now), { reuse: false }, "a spent code is never handed back");
  assert.deepEqual(decideChallengeReuse(live, now + 61_000), { reuse: false }, "expired → send a fresh one");
  assert.deepEqual(
    decideChallengeReuse({ ...live, attempts: LOGIN_OTP_MAX_ATTEMPTS }, now),
    { reuse: false },
    "⛔ a challenge that burned its tries is NOT reused — that would hand someone a dead code with no way forward",
  );
  assert.deepEqual(decideChallengeReuse({ ...live, attempts: LOGIN_OTP_MAX_ATTEMPTS - 1 }, now), { reuse: true }, "one try left is still usable");
});

test("⛔ the login handler FAILS CLOSED when it cannot read the tenant's 2FA setting", () => {
  const s = stripComments(src("server.ts"));
  const start = s.indexOf('app.post("/auth/login"');
  const body = s.slice(start, s.indexOf("async function issueLoginSession(", start));
  // The lookup that decides whether a second factor is required must not swallow errors.
  assert.doesNotMatch(
    body,
    /loginOtpRequired: true, loginOtpChannel: true \} \}\)\.catch\(/,
    "a .catch() on this read would issue a session with NO code asked for",
  );
  assert.match(body, /login_otp_tenant_lookup_failed/);
  assert.match(body, /status\(503\)\.send\(\{ error: "service_unavailable"/);
});

test("v2 send order: the login decides choose-vs-send BEFORE any code exists; issueCode reuses before it creates, creates before it sends", () => {
  const s = stripComments(src("mfa/loginOtpRoutes.ts"));
  const start = s.slice(s.indexOf("export async function startOtpChallenge("), s.indexOf("export async function registerLoginOtpRoutes("));
  const decideAt = start.indexOf("decideFirstSend(");
  const issueAt = start.indexOf("issueCode(deps");
  assert.ok(decideAt > 0 && issueAt > decideAt, "decideFirstSend → issueCode");
  assert.match(start, /reason: "choose_channel" as const/);
  assert.doesNotMatch(start.slice(0, issueAt), /loginOtpChallenge\.create\(|sendCode\(/, "the choose branch touches no row and sends nothing");
  const issue = s.slice(s.indexOf("async function issueCode("), s.indexOf("async function replaceCodeAndSend("));
  const reuseAt = issue.indexOf("decideChallengeReuse(");
  const createAt = issue.indexOf("loginOtpChallenge.create(");
  const sendAt = issue.indexOf("sendCode(deps");
  assert.ok(reuseAt > 0 && createAt > reuseAt && sendAt > createAt, "reuse check → create → send");
  assert.match(issue, /reason: "already_sent"/);
  assert.match(issue, /reason: "send_limit"/);
  // The destination is always the REGISTERED one — derived from the user row, never from the request.
  assert.match(s, /function registeredDestination\(user: OtpUser, channel: OtpChannel\)/);
  assert.doesNotMatch(s, /req\.body\.(to|phone|email|destination)/, "the client never supplies where the code goes");
});
