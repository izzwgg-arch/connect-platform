/**
 * Sign-in code (2FA by text or email, per user) + Cloudflare Turnstile — the
 * rules, and the guards that pin them to the login route.
 *
 * v3 (2026-09-08): per USER (`User.loginOtpEnabledAt`), turned on on Account →
 * Security; the person chooses text or email; no "remember this device"; no
 * session expiry — signing out is the only thing that ends it; no per-tenant
 * switch.
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

test("gate (v3): per user — OFF → nothing; TOTP user → nothing; ON → a code EVERY sign-in, no trusted-device skip", () => {
  assert.deepEqual(decideOtpGate({ userOtpEnabled: false, userHasTotp: false }), { kind: "none" });
  assert.deepEqual(decideOtpGate({ userOtpEnabled: true, userHasTotp: true }), { kind: "none" });
  assert.deepEqual(decideOtpGate({ userOtpEnabled: true, userHasTotp: false }), { kind: "challenge" });
  // Stray v1/v2 fields must not resurrect a skip or a tenant switch.
  assert.deepEqual(decideOtpGate({ userOtpEnabled: true, userHasTotp: false, trustedDevice: { valid: true } } as any), { kind: "challenge" });
  assert.deepEqual(decideOtpGate({ userOtpEnabled: false, userHasTotp: false, tenantOtpRequired: true } as any), { kind: "none" }, "a tenant flag alone switches nobody on");
});

// ─── channels ─────────────────────────────────────────────────────────────────

test("channels (v3): phone on file → text + email; no phone → email only; a request picks within what is offered", () => {
  assert.deepEqual(chooseChannels(true), { channels: ["SMS", "EMAIL"], preferred: "SMS" });
  assert.deepEqual(chooseChannels(true, "EMAIL"), { channels: ["SMS", "EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels(true, "email"), { channels: ["SMS", "EMAIL"], preferred: "EMAIL" }, "case-insensitive");
  assert.deepEqual(chooseChannels(false), { channels: ["EMAIL"], preferred: "EMAIL" });
  assert.deepEqual(chooseChannels(false, "SMS"), { channels: ["EMAIL"], preferred: "EMAIL" }, "no phone → email, whatever was asked");
  assert.equal(normalizeOtpChannel(" email "), "EMAIL");
  assert.equal(normalizeOtpChannel("pigeon"), null);
});

test("offer: every offered channel comes with its MASKED registered destination — the chooser never sees a raw phone or email", () => {
  assert.deepEqual(offerChannels("+18455551234", "baila@acme.test"), {
    channels: ["SMS", "EMAIL"],
    destinations: { SMS: "•••-•••-1234", EMAIL: "b••••@acme.test" },
  });
  assert.deepEqual(offerChannels(null, "office@acme.test"), { channels: ["EMAIL"], destinations: { EMAIL: "o•••••@acme.test" } });
  const raw = JSON.stringify(offerChannels("+18455551234", "baila@acme.test"));
  assert.equal(raw.includes("8455551234"), false);
  assert.equal(raw.includes("baila@"), false);
});

test("first send: two channels and no request → CHOOSE (send nothing); a named allowed channel or a single channel → send now", () => {
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

test("wiring: /auth/otp/send + /verify + /resend are on the JWT bypass list — and only those three (status/enable/disable are session-gated)", () => {
  const s = stripComments(src("jwtPublicRouteBypass.ts"));
  const otpEntries = (s.match(/"\/auth\/otp\/[a-z-]+"/g) || []);
  assert.deepEqual(otpEntries.sort(), ['"/auth/otp/resend"', '"/auth/otp/send"', '"/auth/otp/verify"'], "nothing else under /auth/otp/ may skip the JWT hook");
});

test("wiring (v3): login reads the USER's own switch — no tenant lookup, no trusted device; Turnstile after the throttle and before any DB read; OTP gate after the TOTP decision", () => {
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
  assert.match(body, /decideOtpGate\(\{ userOtpEnabled: Boolean\(\(user as any\)\.loginOtpEnabledAt\), userHasTotp: false \}\)/);
  assert.match(body, /startOtpChallenge\(otpDeps/);
  assert.match(body, /requestedChannel: input\.otpChannel/);
  assert.doesNotMatch(body, /loginOtpRequired|loginOtpChannel|tenantChannelSetting/, "v3: the tenant switch is gone from the login handler");
  assert.doesNotMatch(body, /checkTrustedDevice|trustedDeviceToken/, "no remembered-device skip in the login handler");
  // The sign-in code satisfies a required role: the grace nudge must not fire for someone who has it on.
  assert.match(body, /if \(mfaOutcome\.kind !== "challenge" && mfaOutcome\.kind !== "none" && \(user as any\)\.loginOtpEnabledAt\) mfaOutcome = \{ kind: "none" \};/);
});

test("wiring: every session is signed ONE way — no expiresIn, no per-tenant lookup in issueLoginSession; routes registered", () => {
  const s = stripComments(src("server.ts"));
  const fn = s.slice(s.indexOf("async function issueLoginSession("), s.indexOf("const mfaDeps = buildMfaDeps("));
  assert.doesNotMatch(fn, /expiresIn/, "no expiry on any session (Izzy 2026-09-08: 'there is no expiry')");
  assert.doesNotMatch(fn, /loginOtpRequired|OTP_SESSION/, "the 90-day OTP-tenant branch is gone");
  assert.match(fn, /const token = app\.jwt\.sign\(\{ sub: user\.id, tenantId: user\.tenantId, email: user\.email, role: user\.role, name: displayNameForUser\(namedUser\) \}\);/, "the one sign call, exactly as the pre-2FA platform signed");
  assert.equal((fn.match(/app\.jwt\.sign\(/g) || []).length, 1, "exactly one sign call");
  assert.doesNotMatch(s, /OTP_SESSION_EXPIRES_IN/);
  assert.match(s, /await registerLoginOtpRoutes\(app, otpDeps\);/);
  assert.doesNotMatch(s, /loginOtpRequired: \(t as any\)\.loginOtpRequired/, "v3: the admin tenant list no longer carries the dead switch");
});

test("wiring: the login parser accepts turnstileToken + otpChannel, no longer knows trustedDeviceToken, and still refuses a short password", () => {
  const s = stripComments(src("loginRequest.ts"));
  for (const f of ["turnstileToken", "otpChannel"]) assert.match(s, new RegExp(`${f}: z\\.string\\(\\)`));
  assert.doesNotMatch(s, /trustedDeviceToken/);
  assert.match(s, /password: z\.string\(\)\.min\(LOGIN_PASSWORD_MIN_LENGTH\)/);
});

test("⛔ v3: no trusted device, no session expiry, no tenant switch anywhere in the OTP module; the admin routes are gone", () => {
  for (const rel of ["mfa/loginOtp.ts", "mfa/loginOtpRoutes.ts"]) {
    const s = stripComments(src(rel));
    assert.doesNotMatch(s, /trustedLoginDevice|TrustedDevice|rememberDevice|trusted-devices/i, `${rel} must not touch remembered devices`);
    assert.doesNotMatch(s, /expiresIn:|OTP_SESSION/, `${rel} must not put an expiry on a session`);
    assert.doesNotMatch(s, /loginOtpRequired|loginOtpChannel|TenantOtpChannelSetting/, `${rel} must not read the dead tenant switch`);
  }
  const routes = stripComments(src("mfa/loginOtpRoutes.ts"));
  const paths = [...routes.matchAll(/app\.(get|post|put|delete)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
  assert.deepEqual(paths, ["GET /auth/otp/status", "POST /auth/otp/disable", "POST /auth/otp/enable", "POST /auth/otp/resend", "POST /auth/otp/send", "POST /auth/otp/verify"]);
  // Turning it off is gated by the PASSWORD (bcrypt), throttled, and the audit names it.
  const disable = routes.slice(routes.indexOf('app.post("/auth/otp/disable"'), routes.indexOf('app.post("/auth/otp/send"'));
  assert.match(disable, /bcrypt\.compare\(parsed\.data\.password, user\.passwordHash\)/);
  assert.match(disable, /verifyThrottle\.evaluate\(/);
  assert.match(disable, /LOGIN_OTP_DISABLED/);
  // Turning it on touches nothing but the user's own row.
  const enable = routes.slice(routes.indexOf('app.post("/auth/otp/enable"'), routes.indexOf('app.post("/auth/otp/disable"'));
  assert.match(enable, /loginOtpEnabledAt: new Date\(/);
  assert.doesNotMatch(enable, /tenant\.update|requireSuperAdmin/);
});

test("⛔ the OTP routes reach accessors that EXIST on the generated Prisma client (the `(db as any)` transposition trap)", async () => {
  const { Prisma } = await import("@prisma/client");
  const s = stripComments(src("mfa/loginOtpRoutes.ts"));
  const accessors = new Set([...s.matchAll(/\(db as any\)\.(\w+)\./g)].map((m) => m[1]));
  for (const a of ["loginOtpChallenge", "emailJob"]) assert.ok(accessors.has(a), `expected the routes to use db.${a}`);
  assert.equal(accessors.has("trustedLoginDevice"), false, "the routes never read TrustedLoginDevice");
  assert.equal(accessors.has("tenant"), false, "v3: the routes never touch Tenant");
  for (const a of accessors) {
    const model = a.charAt(0).toUpperCase() + a.slice(1);
    assert.equal((Prisma.ModelName as any)[model], model, `client.${a} must map to a real model — ${model} is missing from the generated client (run prisma generate / check the schema)`);
  }
  // And the per-user column exists in the schema the client is generated from.
  const schema = readFileSync(path.join(__dirname, "..", "..", "..", "..", "packages", "db", "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /\n\s*loginOtpEnabledAt\s+DateTime\?/, "User.loginOtpEnabledAt must exist");
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

test("send order: the login decides choose-vs-send BEFORE any code exists; issueCode reuses before it creates, creates before it sends", () => {
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
