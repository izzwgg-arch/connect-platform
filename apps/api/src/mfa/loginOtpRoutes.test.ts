/**
 * The sign-in code, end to end through the real Fastify routes against a faked
 * database — v3 (2026-09-08): PER USER, turned on/off on Account → Security
 * (enable = one click; disable = the password); at sign-in the person CHOOSES
 * text or email → code → session; the code is asked on EVERY sign-in, the
 * session carries no expiry; and every way a code must NOT let someone in
 * (wrong login, replay, attempts, send cap).
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-otp-routes-0123456789abcdef";
delete process.env.LOGIN_THROTTLE_DISABLED;
delete process.env.MFA_REQUIRED_ROLES;

// ─── fake db ─────────────────────────────────────────────────────────────────

const state: any = { users: [], challenges: [], emails: [], sms: [], audits: [], outbox: [] as string[] };
let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;
const matches = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("gt" in v) return row[k] > v.gt;
      if ("in" in v) return v.in.includes(row[k]);
      return true;
    }
    return row[k] === v;
  });

mock.module("@connect/db", {
  namedExports: {
    db: {
      user: {
        findUnique: async ({ where }: any) => {
          const u = state.users.find((x: any) => x.id === where.id) ?? null;
          if (!u) return null;
          return { ...u, mfa: u.totpEnabledAt ? { enabledAt: u.totpEnabledAt } : null };
        },
        update: async ({ where, data }: any) => { const u = state.users.find((x: any) => x.id === where.id); Object.assign(u, data); return u; },
      },
      // v3: deliberately NO tenant accessor and NO trustedLoginDevice accessor.
      // If any route still reached for either, the call would throw.
      loginOtpChallenge: {
        create: async ({ data }: any) => { const row = { id: nextId("ch"), createdAt: new Date(), attempts: 0, sendCount: 1, consumedAt: null, ...data }; state.challenges.push(row); return row; },
        update: async ({ where, data }: any) => {
          const row = state.challenges.find((x: any) => x.id === where.id);
          for (const [k, v] of Object.entries<any>(data)) row[k] = v && typeof v === "object" && "increment" in v ? (row[k] ?? 0) + v.increment : v;
          return row;
        },
        updateMany: async ({ where, data }: any) => {
          const rows = state.challenges.filter((x: any) => x.id === where.id && (!("consumedAt" in where) || x.consumedAt === where.consumedAt));
          rows.forEach((r: any) => Object.assign(r, data));
          return { count: rows.length };
        },
        findFirst: async ({ where }: any) => {
          const rows = state.challenges.filter((x: any) => matches(x, where)).sort((a: any, b: any) => b.createdAt - a.createdAt);
          return rows[0] ? { ...rows[0] } : null; // a snapshot, as Prisma returns — never the live row
        },
      },
      emailJob: { create: async ({ data }: any) => { state.emails.push(data); state.outbox.push(String(data.textBody)); return { id: nextId("em"), ...data }; } },
    },
  },
});

mock.module("../billing/billingSmsSender", {
  namedExports: {
    normalizeUsPhone: (v: any) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : null; },
    resolveBillingSmsSender: async () => ({ ok: true, send: async (m: any) => { state.sms.push(m); state.outbox.push(String(m.body)); } }),
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const routesMod = require("./loginOtpRoutes") as typeof import("./loginOtpRoutes");
const { registerLoginOtpRoutes, startOtpChallenge, resetOtpVerifyThrottle } = routesMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decideOtpGate, hashOtpCode, LOGIN_OTP_MAX_ATTEMPTS, LOGIN_OTP_MAX_SENDS } = require("./loginOtp") as typeof import("./loginOtp");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shouldSkipJwtVerification } = require("../jwtPublicRouteBypass") as typeof import("../jwtPublicRouteBypass");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mintPreAuthToken } = require("./preAuthToken") as typeof import("./preAuthToken");

// ─── harness ─────────────────────────────────────────────────────────────────

const PASSWORD = "correct horse battery";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const BAILA = { id: "u_baila", tenantId: "t_acme", email: "baila@acme.test", phone: "8455551234", role: "USER", status: "ACTIVE", passwordHash: HASH, loginOtpEnabledAt: new Date("2026-09-08T10:00:00Z") as Date | null, totpEnabledAt: null as Date | null, lastLoginAt: null as Date | null };
const NOPHONE = { id: "u_nophone", tenantId: "t_acme", email: "office@acme.test", phone: null, role: "USER", status: "ACTIVE", passwordHash: HASH, loginOtpEnabledAt: new Date("2026-09-08T10:00:00Z") as Date | null, totpEnabledAt: null as Date | null, lastLoginAt: null as Date | null };
const IZZY = { id: "u_izzy", tenantId: "t_admin", email: "izzy@admin.test", phone: "8457231213", role: "SUPER_ADMIN", status: "ACTIVE", passwordHash: HASH, loginOtpEnabledAt: null as Date | null, totpEnabledAt: null as Date | null, lastLoginAt: null as Date | null };

function reset() {
  state.users = [{ ...BAILA }, { ...NOPHONE }, { ...IZZY }];
  state.challenges = []; state.emails = []; state.sms = []; state.audits = []; state.outbox = [];
  resetOtpVerifyThrottle();
}
const userRow = (id: string) => state.users.find((x: any) => x.id === id);

async function buildApp() {
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.addHook("preHandler", async (req: any, reply: any) => {
    const path = req.url.split("?")[0];
    if (shouldSkipJwtVerification(path)) return;
    try { await req.jwtVerify(); } catch { return reply.status(401).send({ error: "unauthorized" }); }
    if ((req.user as any)?.mfa_pending === true) return reply.status(401).send({ error: "unauthorized" });
  });
  const deps = {
    audit: async (p: any) => { state.audits.push(p); },
    // The session is signed exactly like every other session — no expiresIn.
    issueSession: async (userId: string) => {
      const u = userRow(userId);
      return { token: app.jwt.sign({ sub: u.id, tenantId: u.tenantId, email: u.email, role: u.role }), portalPermissionSet: ["can_view_dashboard"] };
    },
    log: { warn: () => undefined, info: () => undefined },
  };
  await registerLoginOtpRoutes(app, deps as any);
  return { app, deps, sessionFor: (u: any) => app.jwt.sign({ sub: u.id, tenantId: u.tenantId, email: u.email, role: u.role }) };
}

/** What server.ts does after the password matched: gate on the USER's own switch → challenge. */
async function loginAfterPassword(deps: any, user: any, requestedChannel?: string) {
  const live = userRow(user.id);
  const gate = decideOtpGate({ userOtpEnabled: Boolean(live.loginOtpEnabledAt), userHasTotp: Boolean(live.totpEnabledAt) });
  if (gate.kind === "challenge") return { gate, body: await startOtpChallenge(deps, { user: live, requestedChannel }) };
  return { gate, body: null };
}
const send = (app: any, preAuthToken: string, channel: string) => app.inject({ method: "POST", url: "/auth/otp/send", payload: { preAuthToken, channel } });
const verify = (app: any, preAuthToken: string, code: string, headers?: any) => app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken, code }, headers });
// The routes hash the code and never keep it; the fake sender is where the plain code shows up.
const codeFromMessages = () => String(state.outbox[state.outbox.length - 1]).match(/\b(\d{6})\b/)![1];

// ─── tests ───────────────────────────────────────────────────────────────────

test("v3 Security page: status → enable (one click, own row only) → status; nothing else on the platform switches it", async () => {
  reset();
  const { app, deps, sessionFor } = await buildApp();
  const auth = { authorization: `Bearer ${sessionFor(IZZY)}` };
  const s0 = await app.inject({ method: "GET", url: "/auth/otp/status", headers: auth });
  assert.equal(s0.statusCode, 200, s0.body);
  assert.deepEqual(s0.json(), { enabled: false, enabledAt: null, channels: ["SMS", "EMAIL"], destinations: { SMS: "•••-•••-1213", EMAIL: "i•••@admin.test" }, phoneOnFile: true, totpEnabled: false, required: true, enrollmentRequired: true });
  assert.equal((await app.inject({ method: "GET", url: "/auth/otp/status" })).statusCode, 401, "signed-in only — NOT on the bypass list");
  assert.equal((await app.inject({ method: "POST", url: "/auth/otp/enable" })).statusCode, 401);

  const on = await app.inject({ method: "POST", url: "/auth/otp/enable", headers: auth, payload: {} });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().enabled, true);
  assert.equal(on.json().enrollmentRequired, false, "the sign-in code satisfies the role requirement");
  assert.ok(userRow(IZZY.id).loginOtpEnabledAt instanceof Date);
  assert.ok(state.audits.some((a: any) => a.action === "LOGIN_OTP_ENABLED" && a.actorUserId === IZZY.id && a.targetUserId === IZZY.id));
  const again = await app.inject({ method: "POST", url: "/auth/otp/enable", headers: auth, payload: {} });
  assert.equal(again.statusCode, 200);
  assert.equal(state.audits.filter((a: any) => a.action === "LOGIN_OTP_ENABLED").length, 1, "idempotent — a second click audits nothing new");
  // A tenant-level switch does not exist: the other users' rows are untouched.
  assert.equal(userRow(BAILA.id).loginOtpEnabledAt?.toISOString(), "2026-09-08T10:00:00.000Z");
  // And now the login challenges Izzy.
  const { gate } = await loginAfterPassword(deps, IZZY);
  assert.equal(gate.kind, "challenge");
});

test("v3 disable: needs the PASSWORD — wrong one is 401 and counted, five wrong → 429, right one turns it off and the next sign-in is plain", async () => {
  reset();
  const { app, deps, sessionFor } = await buildApp();
  const auth = { authorization: `Bearer ${sessionFor(BAILA)}`, "x-forwarded-for": "203.0.113.20" };
  assert.equal((await app.inject({ method: "POST", url: "/auth/otp/disable", headers: auth, payload: {} })).statusCode, 400, "no password → 400");
  const wrong = await app.inject({ method: "POST", url: "/auth/otp/disable", headers: auth, payload: { password: "nope nope nope" } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, "invalid_password");
  assert.ok(userRow(BAILA.id).loginOtpEnabledAt, "still on");
  for (let i = 0; i < 4; i++) await app.inject({ method: "POST", url: "/auth/otp/disable", headers: auth, payload: { password: "nope nope nope" } });
  const throttled = await app.inject({ method: "POST", url: "/auth/otp/disable", headers: auth, payload: { password: PASSWORD } });
  assert.equal(throttled.statusCode, 429, "five wrong passwords → even the right one waits");
  assert.ok(throttled.headers["retry-after"]);
  assert.ok(userRow(BAILA.id).loginOtpEnabledAt, "still on");
  resetOtpVerifyThrottle();
  const off = await app.inject({ method: "POST", url: "/auth/otp/disable", headers: auth, payload: { password: PASSWORD } });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().enabled, false);
  assert.equal(userRow(BAILA.id).loginOtpEnabledAt, null);
  assert.ok(state.audits.some((a: any) => a.action === "LOGIN_OTP_DISABLED" && a.metadata.verifiedWith === "password"));
  const { gate } = await loginAfterPassword(deps, BAILA);
  assert.equal(gate.kind, "none", "off → the pre-2FA login");
});

test("happy path: the login OFFERS text or email (sends nothing) → the person picks text → code by SMS → verify → session; the code is NOT stored in the clear", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { gate, body } = await loginAfterPassword(deps, BAILA);
  assert.equal(gate.kind, "challenge");
  assert.equal(body!.otpChallengeRequired, true);
  assert.equal(body!.sent, false);
  assert.equal((body as any).reason, "choose_channel");
  assert.equal((body as any).channel, undefined, "no channel until they choose");
  assert.deepEqual(body!.channels, ["SMS", "EMAIL"]);
  assert.deepEqual(body!.destinations, { SMS: "•••-•••-1234", EMAIL: "b••••@acme.test" }, "both REGISTERED destinations, masked");
  assert.equal(body!.error, "otp_required", "a pre-OTP client shows a readable slug, not LOGIN_FAILED");
  assert.equal(state.sms.length + state.emails.length, 0, "⛔ nothing goes out before the choice");
  assert.equal(state.challenges.length, 0, "no challenge row before the choice");
  assert.ok(!("token" in body!), "no session token before the code");

  const s = await send(app, body!.preAuthToken, "SMS");
  assert.equal(s.statusCode, 200, s.body);
  assert.deepEqual({ ok: s.json().ok, channel: s.json().channel, destination: s.json().destination, sent: s.json().sent }, { ok: true, channel: "SMS", destination: "•••-•••-1234", sent: true });
  assert.equal(state.sms.length, 1);
  assert.equal(state.sms[0].to, "+18455551234", "the REGISTERED phone, not anything the client said");
  assert.equal(state.sms[0].tenantId, BAILA.tenantId);
  const code = codeFromMessages();
  const ch = state.challenges[0];
  assert.equal(ch.codeHash, hashOtpCode(code, ch.id));
  assert.equal(JSON.stringify(ch).includes(code), false, "the challenge row never carries the plain code");

  const res = await verify(app, body!.preAuthToken, code);
  assert.equal(res.statusCode, 200, res.body);
  const json = res.json();
  assert.ok(json.token, "the ordinary login body");
  assert.deepEqual(json.portalPermissionSet, ["can_view_dashboard"]);
  assert.equal(json.otpMethod, "SMS");
  assert.equal("trustedDeviceToken" in json, false, "no device token, ever");
  assert.equal(app.jwt.decode(json.token).exp, undefined, "the session has NO expiry — sign-out is what ends it");
  assert.equal(state.challenges[0].consumedAt !== null, true);
  assert.equal(userRow(BAILA.id).lastLoginAt !== null, true);
  assert.ok(state.audits.some((a: any) => a.action === "LOGIN_OTP_CHOICE_OFFERED"));
  assert.ok(state.audits.some((a: any) => a.action === "LOGIN_OTP_SENT" && a.metadata.channel === "SMS"));
  assert.ok(state.audits.some((a: any) => a.action === "LOGIN_OTP_VERIFIED"));
});

test("picking EMAIL sends to the registered email as LOGIN_CODE on their tenant, never ADMIN_ALERT", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  const s = await send(app, body!.preAuthToken, "email");
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().channel, "EMAIL");
  assert.equal(s.json().destination, "b••••@acme.test");
  assert.equal(state.sms.length, 0);
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].type, "LOGIN_CODE");
  assert.equal(state.emails[0].tenantId, BAILA.tenantId);
  assert.equal(state.emails[0].toEmail, BAILA.email);
  assert.match(state.emails[0].textBody, /\d{6}/);
  assert.equal(state.emails[0].status, "QUEUED");
  const ok = await verify(app, body!.preAuthToken, codeFromMessages());
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().otpMethod, "EMAIL");
});

test("one channel possible (no phone on file) → no choice screen: the login emails straight away; the Security page says email only", async () => {
  reset();
  const { app, deps, sessionFor } = await buildApp();
  const st = await app.inject({ method: "GET", url: "/auth/otp/status", headers: { authorization: `Bearer ${sessionFor(NOPHONE)}` } });
  assert.deepEqual({ channels: st.json().channels, phoneOnFile: st.json().phoneOnFile, destinations: st.json().destinations }, { channels: ["EMAIL"], phoneOnFile: false, destinations: { EMAIL: "o•••••@acme.test" } });
  const { body } = await loginAfterPassword(deps, NOPHONE);
  assert.equal((body as any).channel, "EMAIL");
  assert.deepEqual(body!.channels, ["EMAIL"]);
  assert.equal(body!.sent, true);
  assert.equal(state.sms.length, 0);
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].toEmail, NOPHONE.email);
  const ok = await verify(app, body!.preAuthToken, codeFromMessages());
  assert.equal(ok.statusCode, 200, ok.body);
});

test("a client that already knows the answer passes otpChannel to the login and skips the extra round trip", async () => {
  reset();
  const { deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA, "EMAIL");
  assert.equal((body as any).channel, "EMAIL");
  assert.equal(body!.sent, true);
  assert.equal(state.emails.length, 1);
  assert.equal(state.sms.length, 0);
});

test("send refusals: a channel not offered → 400 with the offered list; garbage → 400; a TOTP pre-auth token → 401; the client can never name a destination", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, NOPHONE);
  const notOffered = await send(app, body!.preAuthToken, "SMS");
  assert.equal(notOffered.statusCode, 400);
  assert.equal(notOffered.json().error, "otp_channel_unavailable");
  assert.deepEqual(notOffered.json().channels, ["EMAIL"]);
  assert.equal((await send(app, body!.preAuthToken, "PIGEON")).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/auth/otp/send", payload: { preAuthToken: body!.preAuthToken } })).statusCode, 400);
  const totpToken = mintPreAuthToken(BAILA.id).token; // default purpose = TOTP
  const wrongPurpose = await send(app, totpToken, "SMS");
  assert.equal(wrongPurpose.statusCode, 401);
  assert.equal(wrongPurpose.json().reason, "wrong_purpose");
  // Extra fields naming a destination are ignored: the send still goes to the REGISTERED email.
  const { body: b2 } = await loginAfterPassword(deps, BAILA);
  const sneaky = await app.inject({ method: "POST", url: "/auth/otp/send", payload: { preAuthToken: b2!.preAuthToken, channel: "EMAIL", to: "attacker@evil.test", email: "attacker@evil.test", destination: "attacker@evil.test" } });
  assert.equal(sneaky.statusCode, 200, sneaky.body);
  assert.equal(state.emails[state.emails.length - 1].toEmail, BAILA.email);
});

test("⛔ 'once per login, gone at sign-out': after a verified sign-in the NEXT sign-in is challenged again — there is no way to skip the code", async () => {
  reset();
  const { app, deps, sessionFor } = await buildApp();
  const first = await loginAfterPassword(deps, BAILA);
  await send(app, first.body!.preAuthToken, "SMS");
  const ok = await verify(app, first.body!.preAuthToken, codeFromMessages());
  assert.equal(ok.statusCode, 200, ok.body);
  // "Sign out" is the portal dropping its token. Signing in again:
  const second = await loginAfterPassword(deps, BAILA);
  assert.equal(second.gate.kind, "challenge", "no remembered device, no skip");
  assert.equal(second.body!.sent, false);
  assert.equal((second.body as any).reason, "choose_channel");
  assert.equal((routesMod as any).checkTrustedDevice, undefined, "the v1 helper no longer exists");
  const signed = { authorization: `Bearer ${sessionFor(BAILA)}` };
  assert.equal((await app.inject({ method: "GET", url: "/auth/otp/trusted-devices", headers: signed })).statusCode, 404, "the v1 trusted-devices routes are gone");
  assert.equal((await app.inject({ method: "GET", url: "/admin/tenants/t_acme/login-otp", headers: signed })).statusCode, 404, "the v1/v2 per-tenant admin routes are gone");
  assert.equal((await app.inject({ method: "PUT", url: "/admin/tenants/t_acme/login-otp", headers: signed, payload: { required: true } })).statusCode, 404);
});

test("refusals: wrong code counts down, replay is dead, a stranger's pre-auth token cannot spend Baila's code, garbage token → 401", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  await send(app, body!.preAuthToken, "SMS");
  const code = codeFromMessages();
  const wrong = await verify(app, body!.preAuthToken, code === "000000" ? "000001" : "000000");
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, "otp_invalid");
  assert.equal(wrong.json().attemptsRemaining, 4);
  assert.equal(state.challenges[0].attempts, 1);

  // A different login (new challenge, own jti) for another user cannot use Baila's code.
  const other = await loginAfterPassword(deps, NOPHONE);
  const cross = await verify(app, other.body!.preAuthToken, code);
  assert.equal(cross.statusCode, 401);

  const ok = await verify(app, body!.preAuthToken, code);
  assert.equal(ok.statusCode, 200, ok.body);
  const replay = await verify(app, body!.preAuthToken, code);
  assert.equal(replay.statusCode, 401, "a spent code never opens a second session");
  assert.equal(replay.json().error, "otp_challenge_dead");

  const [h, p, sg] = body!.preAuthToken.split(".");
  const forged = await verify(app, `${h}.${p}.${sg.slice(0, -2)}xx`, code);
  assert.equal(forged.statusCode, 401, "a tampered pre-auth token is a bad signature");
  assert.equal(forged.json().error, "otp_session_invalid");
  const short = await verify(app, "not.a.token", code);
  assert.equal(short.statusCode, 400, "malformed shape is refused at the parser");
  const twoDigits = await verify(app, body!.preAuthToken, "12");
  assert.equal(twoDigits.statusCode, 401, "a two-digit code is simply wrong (and counted)");
  const verifyBeforeChoice = await verify(app, (await loginAfterPassword(deps, BAILA)).body!.preAuthToken, code);
  assert.equal(verifyBeforeChoice.statusCode, 401, "a login that never chose has no challenge to spend");
  assert.equal(verifyBeforeChoice.json().reason, "no_challenge");
});

test("five wrong codes → the challenge is dead even if the sixth is right; the throttle answers 429 after that", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  await send(app, body!.preAuthToken, "SMS");
  const code = codeFromMessages();
  const wrongCode = code === "000000" ? "000001" : "000000";
  let last: any;
  for (let i = 0; i < 5; i++) last = await verify(app, body!.preAuthToken, wrongCode, { "x-forwarded-for": "203.0.113.9" });
  assert.equal(last.statusCode, 401);
  const sixth = await verify(app, body!.preAuthToken, code, { "x-forwarded-for": "203.0.113.9" });
  assert.ok([401, 429].includes(sixth.statusCode), `got ${sixth.statusCode}`);
  assert.equal(state.challenges[0].consumedAt, null, "never consumed → no session was minted");
  if (sixth.statusCode === 429) assert.ok(sixth.headers["retry-after"], "a throttled answer says how long, and is not a wrong-code answer");
});

test("resend: a fresh code by the other channel, the old code dies, capped at 3 sends", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  await send(app, body!.preAuthToken, "SMS");
  const oldCode = codeFromMessages();
  const re = await app.inject({ method: "POST", url: "/auth/otp/resend", payload: { preAuthToken: body!.preAuthToken, channel: "EMAIL" } });
  assert.equal(re.statusCode, 200, re.body);
  assert.equal(re.json().channel, "EMAIL");
  assert.deepEqual(re.json().destinations, { SMS: "•••-•••-1234", EMAIL: "b••••@acme.test" });
  assert.equal(state.emails.length, 1);
  const newCode = codeFromMessages();
  assert.notEqual(newCode, oldCode);
  const stale = await verify(app, body!.preAuthToken, oldCode);
  assert.equal(stale.statusCode, 401, "the previous code is dead after a resend");
  const re2 = await app.inject({ method: "POST", url: "/auth/otp/resend", payload: { preAuthToken: body!.preAuthToken } });
  assert.equal(re2.statusCode, 200);
  const re3 = await app.inject({ method: "POST", url: "/auth/otp/resend", payload: { preAuthToken: body!.preAuthToken } });
  assert.equal(re3.statusCode, 429, "three sends per login, then start over with the password");
  assert.equal(re3.json().error, "otp_resend_limit");
});

test("⛔ signing in again (or double-clicking 'Text me') while a code is still live sends NOTHING and the code already on their phone still works", async () => {
  reset();
  const { app, deps } = await buildApp();
  const first = await loginAfterPassword(deps, BAILA);
  await send(app, first.body!.preAuthToken, "SMS");
  assert.equal(state.sms.length, 1);
  const code = codeFromMessages();

  // A double click on the same button: same channel, same challenge, no text.
  const dup = await send(app, first.body!.preAuthToken, "SMS");
  assert.equal(dup.statusCode, 200);
  assert.deepEqual({ sent: dup.json().sent, reason: dup.json().reason, destination: dup.json().destination }, { sent: false, reason: "already_sent", destination: "•••-•••-1234" });
  assert.equal(state.sms.length, 1);

  // Ten more logins with the correct password — the shape an attacker (or a
  // customer hammering Sign in) produces — each followed by "Text me".
  const bodies = [];
  for (let i = 0; i < 10; i++) {
    const b = (await loginAfterPassword(deps, BAILA)).body!;
    const s = await send(app, b.preAuthToken, "SMS");
    assert.equal(s.json().sent, false);
    assert.equal(s.json().reason, "already_sent");
    assert.equal(s.json().destination, "•••-•••-1234", "the masked destination is still shown");
    bodies.push(b);
  }
  assert.equal(state.sms.length, 1, "still ONE text after eleven sign-ins");
  assert.equal(state.challenges.length, 1, "and ONE challenge row, re-bound each time");

  // The ORIGINAL code still works — but only for the newest login, and the
  // older pre-auth tokens are dead (the challenge was re-bound).
  const stale = await verify(app, first.body!.preAuthToken, code);
  assert.equal(stale.statusCode, 401, "an older login cannot spend the code");
  const ok = await verify(app, bodies[bodies.length - 1].preAuthToken, code);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);

  // Once spent, the next sign-in is a genuinely new challenge and does send.
  const next = await loginAfterPassword(deps, BAILA);
  await send(app, next.body!.preAuthToken, "SMS");
  assert.equal(state.sms.length, 2);
  assert.equal(state.challenges.length, 2);
});

test("switching channel on a live code: the old code dies and a fresh one goes out the other way; the send cap (3) still holds and then the last code sent still works", async () => {
  reset();
  const { app, deps } = await buildApp();
  const a = await loginAfterPassword(deps, BAILA);
  await send(app, a.body!.preAuthToken, "SMS");                         // send 1
  const smsCode = codeFromMessages();
  const b = await loginAfterPassword(deps, BAILA);
  const sw = await send(app, b.body!.preAuthToken, "EMAIL");            // send 2 — switched
  assert.equal(sw.statusCode, 200, sw.body);
  assert.deepEqual({ channel: sw.json().channel, sent: sw.json().sent, destination: sw.json().destination }, { channel: "EMAIL", sent: true, destination: "b••••@acme.test" });
  assert.equal(state.emails.length, 1);
  assert.equal(state.challenges.length, 1, "same challenge, new channel");
  assert.equal(state.challenges[0].sendCount, 2);
  const emailCode = codeFromMessages();
  assert.notEqual(emailCode, smsCode);
  assert.equal((await verify(app, b.body!.preAuthToken, smsCode)).statusCode, 401, "the SMS code died when the email went out");
  assert.equal(state.challenges[0].attempts, 1, "…and that wrong guess counted against the fresh code (attempts were reset to 0 on the switch)");

  const c = await loginAfterPassword(deps, BAILA);
  const back = await send(app, c.body!.preAuthToken, "SMS");            // send 3 — the cap
  assert.equal(back.json().sent, true);
  assert.equal(state.challenges[0].sendCount, LOGIN_OTP_MAX_SENDS);
  const lastCode = codeFromMessages();

  const d = await loginAfterPassword(deps, BAILA);
  const capped = await send(app, d.body!.preAuthToken, "EMAIL");        // would be send 4
  assert.equal(capped.statusCode, 200);
  assert.deepEqual({ sent: capped.json().sent, reason: capped.json().reason, channel: capped.json().channel, destination: capped.json().destination }, { sent: false, reason: "send_limit", channel: "SMS", destination: "•••-•••-1234" }, "no fourth send; the person is told the LAST code (by text) still works");
  assert.equal(state.sms.length, 2);
  assert.equal(state.emails.length, 1);
  const ok = await verify(app, d.body!.preAuthToken, lastCode);
  assert.equal(ok.statusCode, 200, ok.body);
});

test("a challenge that burned its five tries is replaced, not reused — the person is never handed a dead code", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  await send(app, body!.preAuthToken, "SMS");
  const wrong = codeFromMessages() === "000000" ? "000001" : "000000";
  for (let i = 0; i < LOGIN_OTP_MAX_ATTEMPTS; i++) {
    await verify(app, body!.preAuthToken, wrong, { "x-forwarded-for": "198.51.100.7" });
  }
  assert.equal(state.challenges[0].attempts, LOGIN_OTP_MAX_ATTEMPTS);
  const next = await loginAfterPassword(deps, BAILA);
  const s = await send(app, next.body!.preAuthToken, "SMS");
  assert.equal(s.json().sent, true, "a fresh code really is sent");
  assert.equal(state.challenges.length, 2);
  assert.equal(state.sms.length, 2);
});
