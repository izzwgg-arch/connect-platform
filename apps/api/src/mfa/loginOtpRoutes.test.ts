/**
 * The per-tenant sign-in code, end to end through the real Fastify routes
 * against a faked database: password → challenge → code → session, "remember
 * this device" → the next login skips the code, and every way a code must NOT
 * let someone in (wrong login, replay, attempts, resend cap, admin switch).
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "@fastify/jwt";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-otp-routes-0123456789abcdef";
delete process.env.LOGIN_THROTTLE_DISABLED;

// ─── fake db ─────────────────────────────────────────────────────────────────

const state: any = { users: [], tenants: [], challenges: [], devices: [], emails: [], sms: [], audits: [], outbox: [] as string[] };
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
          const t = state.tenants.find((x: any) => x.id === u.tenantId);
          return { ...u, tenant: t ? { loginOtpChannel: t.loginOtpChannel } : null };
        },
        update: async ({ where, data }: any) => { const u = state.users.find((x: any) => x.id === where.id); Object.assign(u, data); return u; },
      },
      tenant: {
        findUnique: async ({ where }: any) => state.tenants.find((x: any) => x.id === where.id) ?? null,
        update: async ({ where, data }: any) => { const t = state.tenants.find((x: any) => x.id === where.id); Object.assign(t, data); return t; },
      },
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
      trustedLoginDevice: {
        create: async ({ data }: any) => { const row = { id: nextId("dev"), createdAt: new Date(), lastUsedAt: null, revokedAt: null, ...data }; state.devices.push(row); return row; },
        findUnique: async ({ where }: any) => state.devices.find((x: any) => x.tokenHash === where.tokenHash) ?? null,
        update: async ({ where, data }: any) => { const d = state.devices.find((x: any) => x.id === where.id); Object.assign(d, data); return d; },
        findMany: async ({ where }: any) => state.devices.filter((x: any) => matches(x, where)),
        updateMany: async ({ where, data }: any) => { const rows = state.devices.filter((x: any) => matches(x, where)); rows.forEach((r: any) => Object.assign(r, data)); return { count: rows.length }; },
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
const { registerLoginOtpRoutes, startOtpChallenge, checkTrustedDevice, resetOtpVerifyThrottle } = require("./loginOtpRoutes") as typeof import("./loginOtpRoutes");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decideOtpGate, hashOtpCode } = require("./loginOtp") as typeof import("./loginOtp");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shouldSkipJwtVerification } = require("../jwtPublicRouteBypass") as typeof import("../jwtPublicRouteBypass");

// ─── harness ─────────────────────────────────────────────────────────────────

const TENANT = { id: "t_acme", name: "Acme", loginOtpRequired: true, loginOtpChannel: "EITHER" };
const BAILA = { id: "u_baila", tenantId: TENANT.id, email: "baila@acme.test", phone: "8455551234", role: "USER", status: "ACTIVE", lastLoginAt: null as Date | null };
const NOPHONE = { id: "u_nophone", tenantId: TENANT.id, email: "office@acme.test", phone: null, role: "USER", status: "ACTIVE", lastLoginAt: null as Date | null };
const IZZY = { id: "u_izzy", tenantId: "t_admin", email: "izzy@admin.test", phone: null, role: "SUPER_ADMIN", status: "ACTIVE", lastLoginAt: null as Date | null };

function reset() {
  state.users = [{ ...BAILA }, { ...NOPHONE }, { ...IZZY }];
  state.tenants = [{ ...TENANT }, { id: "t_admin", name: "Admin", loginOtpRequired: false, loginOtpChannel: "EITHER" }];
  state.challenges = []; state.devices = []; state.emails = []; state.sms = []; state.audits = []; state.outbox = [];
  resetOtpVerifyThrottle();
}

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
    issueSession: async (userId: string) => {
      const u = state.users.find((x: any) => x.id === userId);
      return { token: app.jwt.sign({ sub: u.id, tenantId: u.tenantId, email: u.email, role: u.role }), portalPermissionSet: ["can_view_dashboard"] };
    },
    requireSuperAdmin: async (req: any, reply: any) => {
      try { await req.jwtVerify(); } catch { reply.status(401).send({ error: "unauthorized" }); return null; }
      if (req.user.role !== "SUPER_ADMIN") { reply.status(403).send({ error: "forbidden" }); return null; }
      return req.user;
    },
    log: { warn: () => undefined, info: () => undefined },
  };
  await registerLoginOtpRoutes(app, deps as any);
  return { app, deps, sessionFor: (u: any) => app.jwt.sign({ sub: u.id, tenantId: u.tenantId, email: u.email, role: u.role }) };
}

/** What server.ts does after the password matched: gate → challenge. */
async function loginAfterPassword(deps: any, user: any, trustedDeviceToken?: string) {
  const trusted = await checkTrustedDevice(deps, user.id, trustedDeviceToken);
  const gate = decideOtpGate({ tenantOtpRequired: true, userHasTotp: false, trustedDevice: trusted });
  if (gate.kind === "challenge") return { gate, body: await startOtpChallenge(deps, { user, tenantChannelSetting: TENANT.loginOtpChannel }) };
  return { gate, body: null };
}
// The routes hash the code and never keep it; the fake sender is where the plain code shows up.
const codeFromMessages = () => String(state.outbox[state.outbox.length - 1]).match(/\b(\d{6})\b/)![1];

// ─── tests ───────────────────────────────────────────────────────────────────

test("happy path: challenge by SMS (phone on file) → verify → session; the code is NOT stored in the clear", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { gate, body } = await loginAfterPassword(deps, BAILA);
  assert.equal(gate.kind, "challenge");
  assert.equal(body!.otpChallengeRequired, true);
  assert.equal(body!.channel, "SMS");
  assert.deepEqual(body!.channels, ["SMS", "EMAIL"]);
  assert.equal(body!.destination, "•••-•••-1234");
  assert.equal(body!.sent, true);
  assert.equal(body!.error, "otp_required", "a pre-OTP client shows a readable slug, not LOGIN_FAILED");
  assert.equal(state.sms.length, 1);
  assert.equal(state.sms[0].to, "+18455551234");
  const code = codeFromMessages();
  const ch = state.challenges[0];
  assert.equal(ch.codeHash, hashOtpCode(code, ch.id));
  assert.equal(JSON.stringify(ch).includes(code), false, "the challenge row never carries the plain code");
  assert.ok(!("token" in body!), "no session token before the code");

  const res = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code, rememberDevice: false } });
  assert.equal(res.statusCode, 200, res.body);
  const json = res.json();
  assert.ok(json.token, "the ordinary login body");
  assert.deepEqual(json.portalPermissionSet, ["can_view_dashboard"]);
  assert.equal(json.trustedDeviceToken, undefined, "not remembered → no device token");
  assert.equal(state.devices.length, 0);
  assert.equal(state.challenges[0].consumedAt !== null, true);
  assert.equal(state.users.find((u: any) => u.id === BAILA.id).lastLoginAt !== null, true);
});

test("a person with no phone is emailed; the email is LOGIN_CODE on their tenant, never ADMIN_ALERT", async () => {
  reset();
  const { deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, NOPHONE);
  assert.equal(body!.channel, "EMAIL");
  assert.deepEqual(body!.channels, ["EMAIL"]);
  assert.equal(state.sms.length, 0);
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].type, "LOGIN_CODE");
  assert.equal(state.emails[0].tenantId, TENANT.id);
  assert.equal(state.emails[0].toEmail, NOPHONE.email);
  assert.match(state.emails[0].textBody, /\d{6}/);
  assert.equal(state.emails[0].status, "QUEUED");
});

test("remember this device: the token comes back ONCE, only its hash is stored, and the NEXT login skips the code", async () => {
  reset();
  const { app, deps } = await buildApp();
  const first = await loginAfterPassword(deps, BAILA);
  const res = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: first.body!.preAuthToken, code: codeFromMessages(), rememberDevice: true, deviceLabel: "Front desk PC" } });
  assert.equal(res.statusCode, 200, res.body);
  const { trustedDeviceToken, trustedDeviceExpiresAt } = res.json();
  assert.ok(trustedDeviceToken && trustedDeviceToken.length >= 40);
  assert.equal(state.devices.length, 1);
  assert.notEqual(state.devices[0].tokenHash, trustedDeviceToken, "the hash is stored, never the token");
  assert.equal(state.devices[0].userId, BAILA.id);
  assert.equal(state.devices[0].label, "Front desk PC");
  assert.equal(Math.round((new Date(trustedDeviceExpiresAt).getTime() - Date.now()) / 86_400_000), 90);

  const second = await loginAfterPassword(deps, BAILA, trustedDeviceToken);
  assert.equal(second.gate.kind, "trusted", "same device, same person → no code");
  assert.equal(state.sms.length, 1, "no second text");
  assert.ok(state.devices[0].lastUsedAt, "use is recorded");

  // Somebody else presenting the SAME token still gets a code.
  const other = await loginAfterPassword(deps, NOPHONE, trustedDeviceToken);
  assert.equal(other.gate.kind, "challenge");

  // Forget-all revokes it; the next login for Baila asks again.
  const sess = res.json().token;
  const list = await app.inject({ method: "GET", url: "/auth/otp/trusted-devices", headers: { authorization: `Bearer ${sess}` } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().devices.length, 1);
  assert.equal((await app.inject({ method: "GET", url: "/auth/otp/trusted-devices" })).statusCode, 401, "signed-in only — NOT on the bypass list");
  const del = await app.inject({ method: "DELETE", url: "/auth/otp/trusted-devices", headers: { authorization: `Bearer ${sess}` } });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().revoked, 1);
  const third = await loginAfterPassword(deps, BAILA, trustedDeviceToken);
  assert.equal(third.gate.kind, "challenge");
});

test("refusals: wrong code counts down, replay is dead, a stranger's pre-auth token cannot spend Baila's code, garbage token → 401", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  const code = codeFromMessages();
  const wrong = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code: code === "000000" ? "000001" : "000000" } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, "otp_invalid");
  assert.equal(wrong.json().attemptsRemaining, 4);
  assert.equal(state.challenges[0].attempts, 1);

  // A different login (new challenge, own jti) for another user cannot use Baila's code.
  const other = await loginAfterPassword(deps, NOPHONE);
  const cross = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: other.body!.preAuthToken, code } });
  assert.equal(cross.statusCode, 401);

  const ok = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code } });
  assert.equal(ok.statusCode, 200, ok.body);
  const replay = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code } });
  assert.equal(replay.statusCode, 401, "a spent code never opens a second session");
  assert.equal(replay.json().error, "otp_challenge_dead");

  const [h, p, sg] = body!.preAuthToken.split(".");
  const forged = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: `${h}.${p}.${sg.slice(0, -2)}xx`, code } });
  assert.equal(forged.statusCode, 401, "a tampered pre-auth token is a bad signature");
  assert.equal(forged.json().error, "otp_session_invalid");
  const short = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: "not.a.token", code } });
  assert.equal(short.statusCode, 400, "malformed shape is refused at the parser");
  const twoDigits = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code: "12" } });
  assert.equal(twoDigits.statusCode, 401, "a two-digit code is simply wrong (and counted)");
});

test("five wrong codes → the challenge is dead even if the sixth is right; the throttle answers 429 after that", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  const code = codeFromMessages();
  const wrongCode = code === "000000" ? "000001" : "000000";
  let last: any;
  for (let i = 0; i < 5; i++) last = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code: wrongCode }, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(last.statusCode, 401);
  const sixth = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code }, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.ok([401, 429].includes(sixth.statusCode), `got ${sixth.statusCode}`);
  assert.equal(state.challenges[0].consumedAt, null, "never consumed → no session was minted");
  if (sixth.statusCode === 429) assert.ok(sixth.headers["retry-after"], "a throttled answer says how long, and is not a wrong-code answer");
});

test("resend: a fresh code by the other channel, the old code dies, capped at 3 sends", async () => {
  reset();
  const { app, deps } = await buildApp();
  const { body } = await loginAfterPassword(deps, BAILA);
  const oldCode = codeFromMessages();
  const re = await app.inject({ method: "POST", url: "/auth/otp/resend", payload: { preAuthToken: body!.preAuthToken, channel: "EMAIL" } });
  assert.equal(re.statusCode, 200, re.body);
  assert.equal(re.json().channel, "EMAIL");
  assert.equal(state.emails.length, 1);
  const newCode = codeFromMessages();
  assert.notEqual(newCode, oldCode);
  const stale = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { preAuthToken: body!.preAuthToken, code: oldCode } });
  assert.equal(stale.statusCode, 401, "the previous code is dead after a resend");
  const re2 = await app.inject({ method: "POST", url: "/auth/otp/resend", payload: { preAuthToken: body!.preAuthToken } });
  assert.equal(re2.statusCode, 200);
  const re3 = await app.inject({ method: "POST", url: "/auth/otp/resend", payload: { preAuthToken: body!.preAuthToken } });
  assert.equal(re3.statusCode, 429, "three sends per login, then start over with the password");
  assert.equal(re3.json().error, "otp_resend_limit");
});

test("admin switch: SUPER_ADMIN reads/sets per tenant with an audit row; a tenant admin is refused; bad channel 400", async () => {
  reset();
  const { app, sessionFor } = await buildApp();
  const admin = { authorization: `Bearer ${sessionFor(IZZY)}` };
  const g = await app.inject({ method: "GET", url: `/admin/tenants/${TENANT.id}/login-otp`, headers: admin });
  assert.equal(g.statusCode, 200);
  assert.equal(g.json().required, true);
  const put = await app.inject({ method: "PUT", url: `/admin/tenants/${TENANT.id}/login-otp`, headers: admin, payload: { required: false, channel: "sms" } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual({ required: put.json().required, channel: put.json().channel }, { required: false, channel: "SMS" });
  assert.equal(state.tenants[0].loginOtpRequired, false);
  assert.ok(state.audits.some((a: any) => a.action === "TENANT_LOGIN_OTP_UPDATED" && a.tenantId === TENANT.id && a.actorUserId === IZZY.id));
  const bad = await app.inject({ method: "PUT", url: `/admin/tenants/${TENANT.id}/login-otp`, headers: admin, payload: { required: true, channel: "PIGEON" } });
  assert.equal(bad.statusCode, 400);
  const tenantAdmin = { authorization: `Bearer ${sessionFor({ ...BAILA, role: "TENANT_ADMIN" })}` };
  assert.equal((await app.inject({ method: "PUT", url: `/admin/tenants/${TENANT.id}/login-otp`, headers: tenantAdmin, payload: { required: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/admin/tenants/nope/login-otp`, headers: admin })).statusCode, 404);
});
