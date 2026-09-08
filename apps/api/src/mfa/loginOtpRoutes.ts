/**
 * Routes + runner for the sign-in code (2FA by text or email, per user). Rules
 * and the pure decisions live in ./loginOtp.ts — this file is the thin layer
 * that touches the DB, the SMS sender, the email outbox and Fastify. See
 * loginOtp.ts's header for the whole contract.
 *
 *   PUBLIC (JWT bypass list — a pre-auth token is not a session):
 *   POST /auth/otp/send     { preAuthToken, channel }   the text-or-email choice
 *   POST /auth/otp/verify   { preAuthToken, code }
 *   POST /auth/otp/resend   { preAuthToken, channel? }
 *
 *   SIGNED IN (Account → Security):
 *   GET  /auth/otp/status                       enabled? where would codes go?
 *   POST /auth/otp/enable   {}                  turn on (adds a factor — no confirmation)
 *   POST /auth/otp/disable  { password }        turn off — the PASSWORD, not a code
 *
 * ⛔ Only the three PUBLIC routes may be on `jwtPublicRouteBypass.ts`. A test
 * pins it. ⛔ The code always goes to the REGISTERED phone (User.phone) or
 * email (User.email). The client picks a CHANNEL, never a destination.
 * ⛔ v3 removed the per-tenant admin routes (`/admin/tenants/:id/login-otp`).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@connect/db";
import { createLoginThrottle, clientIpFromForwardedFor } from "../loginThrottle";
import { resolveBillingSmsSender, normalizeUsPhone } from "../billing/billingSmsSender";
import { isMfaRequiredForRole } from "./mfaPolicy";
import { OTP_PRE_AUTH_PURPOSE, mintPreAuthToken, verifyPreAuthToken } from "./preAuthToken";
import {
  LOGIN_CODE_EMAIL_TYPE,
  LOGIN_OTP_MAX_ATTEMPTS,
  LOGIN_OTP_MAX_SENDS,
  LOGIN_OTP_TTL_SECONDS,
  chooseChannels,
  decideChallengeReuse,
  decideFirstSend,
  decideOtpVerify,
  generateOtpCode,
  hashOtpCode,
  maskDestination,
  normalizeOtpChannel,
  offerChannels,
  otpEmailHtml,
  otpEmailSubject,
  otpEmailText,
  otpSmsBody,
  type OtpChannel,
} from "./loginOtp";

export const OTP_VERIFY_THROTTLE_CONFIG = {
  accountFailureLimit: 5,
  accountWindowMs: 10 * 60 * 1000,
  sourceFailureLimit: 25,
  sourceWindowMs: 10 * 60 * 1000,
  sourceDistinctAccountLimit: 6,
  blockMs: 15 * 60 * 1000,
} as const;
const verifyThrottle = createLoginThrottle(OTP_VERIFY_THROTTLE_CONFIG);
/** Test hook. */
export function resetOtpVerifyThrottle(): void { verifyThrottle.reset(); }

export type OtpRouteDeps = {
  /** server.ts's `audit()` shape — tenantId is required there. */
  audit: (params: { tenantId: string; action: string; entityType: string; entityId: string; actorUserId?: string; targetUserId?: string | null; metadata?: Record<string, unknown> | null }) => Promise<unknown>;
  issueSession: (userId: string) => Promise<{ token: string; portalPermissionSet?: string[] }>;
  log?: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void };
  /** Injected for tests; production uses the real senders. */
  sendSms?: (input: { tenantId: string; to: string; body: string }) => Promise<unknown>;
  queueEmail?: (input: { tenantId: string; toEmail: string; subject: string; htmlBody: string; textBody: string }) => Promise<unknown>;
  now?: () => number;
};

const nowOf = (deps: OtpRouteDeps) => (deps.now ? deps.now() : Date.now());

type OtpUser = { id: string; tenantId: string; email: string; phone?: string | null };

// ── sending ──────────────────────────────────────────────────────────────────

async function sendCode(deps: OtpRouteDeps, input: { tenantId: string; channel: OtpChannel; to: string; code: string }): Promise<void> {
  if (input.channel === "SMS") {
    if (deps.sendSms) { await deps.sendSms({ tenantId: input.tenantId, to: input.to, body: otpSmsBody(input.code) }); return; }
    const sender = await resolveBillingSmsSender();
    if (!sender.ok) throw new Error(`otp_sms_unavailable:${sender.error}`);
    await sender.send({ tenantId: input.tenantId, to: input.to, body: otpSmsBody(input.code) });
    return;
  }
  const email = { tenantId: input.tenantId, toEmail: input.to, subject: otpEmailSubject(input.code), htmlBody: otpEmailHtml(input.code), textBody: otpEmailText(input.code) };
  if (deps.queueEmail) { await deps.queueEmail(email); return; }
  await (db as any).emailJob.create({
    data: {
      tenantId: email.tenantId,
      type: LOGIN_CODE_EMAIL_TYPE, // ⛔ a customer email — never ADMIN_ALERT (the send door drops that type)
      toEmail: email.toEmail,
      subject: email.subject,
      htmlBody: email.htmlBody,
      textBody: email.textBody,
      status: "QUEUED",
      attempts: 0,
      nextRunAt: new Date(),
    },
  });
}

/** The registered destination for a channel — the ONLY place a code can go. */
function registeredDestination(user: OtpUser, channel: OtpChannel): string {
  if (channel === "SMS") return String(normalizeUsPhone(user.phone || ""));
  return user.email;
}

type IssueResult = { channel: OtpChannel; destination: string; sent: boolean; reason?: "already_sent" | "send_limit" };

/**
 * Create-or-reuse the person's live challenge, bind it to THIS login's pre-auth
 * token, and send the code on `channel` unless one is already out there.
 *
 *   no live challenge                     → create, send (sendCount 1)
 *   live challenge, same channel          → re-bind, send nothing ("already_sent")
 *   live challenge, other channel, sends left → re-bind, NEW code, send on the
 *                                           new channel (the old code dies)
 *   live challenge, other channel, cap hit → re-bind, send nothing ("send_limit"
 *                                           — the code already sent still works)
 *
 * Sending failure is reported honestly (`sent:false`) rather than swallowed —
 * a customer told "we sent a code" who never receives one is locked out with
 * no explanation.
 */
async function issueCode(deps: OtpRouteDeps, input: { user: OtpUser; channel: OtpChannel; preAuthJti: string; action: string }): Promise<IssueResult> {
  const now = nowOf(deps);
  const { user, channel } = input;
  const to = registeredDestination(user, channel);

  // ⛔ One live code per person — see decideChallengeReuse(). A second sign-in
  // (or a double-clicked "Text me") while a code is still good re-binds the
  // existing challenge to THIS login instead of creating another.
  const existing = await (db as any).loginOtpChallenge
    .findFirst({ where: { userId: user.id, consumedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, attempts: true, consumedAt: true, expiresAt: true, channel: true, destinationMasked: true, sendCount: true } })
    .catch(() => null);
  if (decideChallengeReuse(existing, now).reuse) {
    if (String(existing.channel) === channel) {
      await (db as any).loginOtpChallenge.update({ where: { id: existing.id }, data: { preAuthJti: input.preAuthJti } });
      void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "LOGIN_OTP_REUSED", entityType: "User", entityId: user.id, metadata: { channel } });
      return { channel, destination: String(existing.destinationMasked), sent: false, reason: "already_sent" };
    }
    if (Number(existing.sendCount ?? 1) >= LOGIN_OTP_MAX_SENDS) {
      await (db as any).loginOtpChallenge.update({ where: { id: existing.id }, data: { preAuthJti: input.preAuthJti } });
      void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "LOGIN_OTP_SEND_LIMIT", entityType: "User", entityId: user.id, metadata: { requested: channel, channel: existing.channel } });
      return { channel: existing.channel as OtpChannel, destination: String(existing.destinationMasked), sent: false, reason: "send_limit" };
    }
    // Other channel, sends left: the old code dies, a fresh one goes out.
    const sent = await replaceCodeAndSend(deps, { row: existing, user, channel, to, preAuthJti: input.preAuthJti });
    void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: input.action, entityType: "User", entityId: user.id, metadata: { channel, sent, switched: true } });
    return { channel, destination: maskDestination(channel, to), sent };
  }

  const row = await (db as any).loginOtpChallenge.create({
    data: {
      userId: user.id,
      tenantId: user.tenantId,
      preAuthJti: input.preAuthJti,
      channel,
      destinationMasked: maskDestination(channel, to),
      codeHash: "pending",
      expiresAt: new Date(now + LOGIN_OTP_TTL_SECONDS * 1000),
    },
  });
  const code = generateOtpCode();
  await (db as any).loginOtpChallenge.update({ where: { id: row.id }, data: { codeHash: hashOtpCode(code, row.id) } });
  let sent = true;
  try {
    await sendCode(deps, { tenantId: user.tenantId, channel, to, code });
  } catch (err: any) {
    sent = false;
    deps.log?.warn({ userId: user.id, channel, err: err?.message }, "login_otp_send_failed");
  }
  void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: input.action, entityType: "User", entityId: user.id, metadata: { channel, sent } });
  return { channel, destination: maskDestination(channel, to), sent };
}

/** A fresh code on an existing challenge: the previous code dies, sendCount goes up, attempts reset. */
async function replaceCodeAndSend(deps: OtpRouteDeps, input: { row: { id: string }; user: OtpUser; channel: OtpChannel; to: string; preAuthJti?: string }): Promise<boolean> {
  const now = nowOf(deps);
  const code = generateOtpCode();
  await (db as any).loginOtpChallenge.update({
    where: { id: input.row.id },
    data: {
      codeHash: hashOtpCode(code, input.row.id),
      channel: input.channel,
      destinationMasked: maskDestination(input.channel, input.to),
      sendCount: { increment: 1 },
      attempts: 0,
      expiresAt: new Date(now + LOGIN_OTP_TTL_SECONDS * 1000),
      ...(input.preAuthJti ? { preAuthJti: input.preAuthJti } : {}),
    },
  });
  try {
    await sendCode(deps, { tenantId: input.user.tenantId, channel: input.channel, to: input.to, code });
    return true;
  } catch (err: any) {
    deps.log?.warn({ userId: input.user.id, channel: input.channel, err: err?.message }, "login_otp_resend_failed");
    return false;
  }
}

// ── the login-side entry point ───────────────────────────────────────────────

export type StartOtpInput = {
  user: OtpUser;
  requestedChannel?: unknown;
};

/**
 * Called by /auth/login when the gate says "challenge". Mints the OTP pre-auth
 * token and either
 *   - offers the choice (both channels possible, none requested): NOTHING is
 *     sent; the body carries `channels` + masked `destinations` and
 *     `reason: "choose_channel"`; the portal then calls /auth/otp/send; or
 *   - sends straight away (one channel possible, or the client named one).
 * Either way the answer has NO session token.
 */
export async function startOtpChallenge(deps: OtpRouteDeps, input: StartOtpInput) {
  const now = nowOf(deps);
  const phone = normalizeUsPhone(input.user.phone || "");
  const offer = offerChannels(phone, input.user.email);
  const pre = mintPreAuthToken(input.user.id, now, OTP_PRE_AUTH_PURPOSE);
  const base = {
    otpChallengeRequired: true as const,
    preAuthToken: pre.token,
    expiresInSeconds: pre.expiresInSeconds,
    channels: offer.channels,
    destinations: offer.destinations,
    // For clients written before this existed (the mobile app throws
    // `json.error || "LOGIN_FAILED"` when there is no token): a readable slug.
    error: "otp_required" as const,
  };

  const first = decideFirstSend(offer.channels, input.requestedChannel);
  if (first.kind === "choose") {
    void deps.audit({ tenantId: input.user.tenantId, actorUserId: input.user.id, action: "LOGIN_OTP_CHOICE_OFFERED", entityType: "User", entityId: input.user.id, metadata: { channels: offer.channels } });
    return { ...base, sent: false as const, reason: "choose_channel" as const };
  }
  const result = await issueCode(deps, { user: input.user, channel: first.channel, preAuthJti: pre.jti, action: "LOGIN_OTP_SENT" });
  return { ...base, channel: result.channel, destination: result.destination, sent: result.sent, ...(result.reason ? { reason: result.reason } : {}) };
}

// ── routes ───────────────────────────────────────────────────────────────────

type OtpUserRow = OtpUser & { role: string; passwordHash: string; loginOtpEnabledAt: Date | null; totpEnabled: boolean };

export async function registerLoginOtpRoutes(app: FastifyInstance, deps: OtpRouteDeps): Promise<void> {
  const sourceIp = (req: any) => clientIpFromForwardedFor(req.headers?.["x-forwarded-for"]);

  const loadOtpUser = async (userId: string): Promise<OtpUserRow | null> => {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true, email: true, phone: true, role: true, passwordHash: true, loginOtpEnabledAt: true, mfa: { select: { enabledAt: true } } } as any }) as any;
    if (!user) return null;
    return { id: user.id, tenantId: user.tenantId, email: user.email, phone: user.phone, role: String(user.role), passwordHash: String(user.passwordHash || ""), loginOtpEnabledAt: user.loginOtpEnabledAt ?? null, totpEnabled: Boolean(user.mfa?.enabledAt) };
  };

  const statusOf = (u: OtpUserRow) => {
    const phone = normalizeUsPhone(u.phone || "");
    const offer = offerChannels(phone, u.email);
    const enabled = Boolean(u.loginOtpEnabledAt);
    const required = isMfaRequiredForRole(u.role);
    return {
      enabled,
      enabledAt: u.loginOtpEnabledAt ? u.loginOtpEnabledAt.toISOString() : null,
      channels: offer.channels,
      destinations: offer.destinations,
      phoneOnFile: !!phone,
      /** Legacy authenticator app still on for this account (no UI to enrol any more). */
      totpEnabled: u.totpEnabled,
      required,
      enrollmentRequired: required && !enabled && !u.totpEnabled,
    };
  };

  // ── Account → Security ─────────────────────────────────────────────────────
  app.get("/auth/otp/status", async (req: any, reply: any) => {
    const u = req.user; if (!u?.sub) return reply.status(401).send({ error: "unauthorized" });
    const user = await loadOtpUser(u.sub);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    return statusOf(user);
  });

  app.post("/auth/otp/enable", async (req: any, reply: any) => {
    const u = req.user; if (!u?.sub) return reply.status(401).send({ error: "unauthorized" });
    const user = await loadOtpUser(u.sub);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    if (!user.loginOtpEnabledAt) {
      await db.user.update({ where: { id: user.id }, data: { loginOtpEnabledAt: new Date(nowOf(deps)) } as any });
      void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, targetUserId: user.id, action: "LOGIN_OTP_ENABLED", entityType: "User", entityId: user.id, metadata: { channels: offerChannels(normalizeUsPhone(user.phone || ""), user.email).channels } });
    }
    const fresh = await loadOtpUser(user.id);
    return { ok: true, ...statusOf(fresh ?? user) };
  });

  // Turning it off asks for the PASSWORD, not a code, so a person who lost
  // their phone is not locked out of turning it off. Wrong passwords ride the
  // same throttle as wrong codes: 429 with Retry-After, never 401.
  app.post("/auth/otp/disable", async (req: any, reply: any) => {
    const u = req.user; if (!u?.sub) return reply.status(401).send({ error: "unauthorized" });
    const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Enter your password to turn two-step verification off." });
    const user = await loadOtpUser(u.sub);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const now = nowOf(deps);
    const t = verifyThrottle.evaluate(user.id, sourceIp(req), now);
    if (t.action !== "allow") {
      reply.header("Retry-After", String(t.retryAfterSeconds ?? 600));
      return reply.status(429).send({ error: "RATE_LIMITED" });
    }
    if (!user.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      verifyThrottle.recordFailure(user.id, sourceIp(req), now);
      return reply.status(401).send({ error: "invalid_password", message: "That password is not right." });
    }
    verifyThrottle.recordSuccess(user.id);
    if (user.loginOtpEnabledAt) {
      await db.user.update({ where: { id: user.id }, data: { loginOtpEnabledAt: null } as any });
      void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, targetUserId: user.id, action: "LOGIN_OTP_DISABLED", entityType: "User", entityId: user.id, metadata: { by: "self", verifiedWith: "password" } });
    }
    const fresh = await loadOtpUser(user.id);
    return { ok: true, ...statusOf(fresh ?? { ...user, loginOtpEnabledAt: null }) };
  });

  // ── the sign-in steps (PUBLIC: pre-auth token, no session) ─────────────────
  app.post("/auth/otp/send", async (req: any, reply: any) => {
    const parsed = z.object({ preAuthToken: z.string().min(20), channel: z.string().max(10) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const now = nowOf(deps);
    const pre = verifyPreAuthToken(parsed.data.preAuthToken, now, OTP_PRE_AUTH_PURPOSE);
    if (!pre.ok) return reply.status(401).send({ error: "otp_session_invalid", reason: pre.reason });
    const channel = normalizeOtpChannel(parsed.data.channel);
    if (!channel) return reply.status(400).send({ error: "invalid_request" });
    const user = await loadOtpUser(pre.claims.sub);
    if (!user) return reply.status(401).send({ error: "otp_session_invalid", reason: "user_gone" });
    const phone = normalizeUsPhone(user.phone || "");
    const offer = offerChannels(phone, user.email);
    if (!offer.channels.includes(channel)) return reply.status(400).send({ error: "otp_channel_unavailable", channels: offer.channels });
    const result = await issueCode(deps, { user, channel, preAuthJti: pre.claims.jti, action: "LOGIN_OTP_SENT" });
    return { ok: true, channel: result.channel, channels: offer.channels, destinations: offer.destinations, destination: result.destination, sent: result.sent, ...(result.reason ? { reason: result.reason } : {}), expiresInSeconds: LOGIN_OTP_TTL_SECONDS };
  });

  app.post("/auth/otp/verify", async (req: any, reply: any) => {
    const parsed = z.object({
      preAuthToken: z.string().min(20),
      code: z.union([z.string(), z.number()]).transform((v) => String(v)),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const now = nowOf(deps);
    const pre = verifyPreAuthToken(parsed.data.preAuthToken, now, OTP_PRE_AUTH_PURPOSE);
    if (!pre.ok) return reply.status(401).send({ error: "otp_session_invalid", reason: pre.reason });
    const userId = pre.claims.sub;

    // Throttle BEFORE touching the challenge — 429, never 401, so "slow down"
    // and "wrong code" read differently.
    const t = verifyThrottle.evaluate(userId, sourceIp(req), now);
    if (t.action !== "allow") {
      reply.header("Retry-After", String(t.retryAfterSeconds ?? 600));
      return reply.status(429).send({ error: "RATE_LIMITED" });
    }

    const row = await (db as any).loginOtpChallenge.findFirst({
      where: { userId, preAuthJti: pre.claims.jti },
      orderBy: { createdAt: "desc" },
    });
    const decision = decideOtpVerify(row, { userId, preAuthJti: pre.claims.jti, code: parsed.data.code }, now);
    if (!decision.ok) {
      if (decision.reason === "wrong_code" && row) {
        await (db as any).loginOtpChallenge.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } }).catch(() => undefined);
        verifyThrottle.recordFailure(userId, sourceIp(req), now);
        const left = Math.max(0, LOGIN_OTP_MAX_ATTEMPTS - (row.attempts + 1));
        return reply.status(401).send({ error: "otp_invalid", attemptsRemaining: left });
      }
      // expired / consumed / too many / wrong login: the challenge is dead — start over.
      return reply.status(401).send({ error: "otp_challenge_dead", reason: decision.reason });
    }

    // Spend it atomically: two racing verifies cannot both win.
    const spent = await (db as any).loginOtpChallenge.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date(now) } });
    if (!spent?.count) return reply.status(401).send({ error: "otp_challenge_dead", reason: "consumed" });
    verifyThrottle.recordSuccess(userId);

    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true } });
    if (!user) return reply.status(401).send({ error: "otp_session_invalid", reason: "user_gone" });
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(now), status: "ACTIVE" as any } as any }).catch(() => undefined);

    void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "LOGIN_OTP_VERIFIED", entityType: "User", entityId: user.id, metadata: { channel: row.channel } });
    // The session is the ordinary one — it lasts until sign-out, nothing else.
    const session = await deps.issueSession(user.id);
    return { ...session, otpMethod: row.channel };
  });

  app.post("/auth/otp/resend", async (req: any, reply: any) => {
    const parsed = z.object({ preAuthToken: z.string().min(20), channel: z.string().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const now = nowOf(deps);
    const pre = verifyPreAuthToken(parsed.data.preAuthToken, now, OTP_PRE_AUTH_PURPOSE);
    if (!pre.ok) return reply.status(401).send({ error: "otp_session_invalid", reason: pre.reason });
    const row = await (db as any).loginOtpChallenge.findFirst({ where: { userId: pre.claims.sub, preAuthJti: pre.claims.jti }, orderBy: { createdAt: "desc" } });
    if (!row || row.consumedAt) return reply.status(401).send({ error: "otp_challenge_dead", reason: row ? "consumed" : "no_challenge" });
    if (row.sendCount >= LOGIN_OTP_MAX_SENDS) {
      reply.header("Retry-After", "600");
      return reply.status(429).send({ error: "otp_resend_limit" });
    }
    const user = await loadOtpUser(pre.claims.sub);
    if (!user) return reply.status(401).send({ error: "otp_session_invalid", reason: "user_gone" });
    const phone = normalizeUsPhone(user.phone || "");
    const choice = chooseChannels(!!phone, parsed.data.channel);
    const to = registeredDestination(user, choice.preferred);
    const sent = await replaceCodeAndSend(deps, { row, user, channel: choice.preferred, to });
    void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "LOGIN_OTP_RESENT", entityType: "User", entityId: user.id, metadata: { channel: choice.preferred, sent } });
    const offer = offerChannels(phone, user.email);
    return { ok: true, channel: choice.preferred, channels: choice.channels, destinations: offer.destinations, destination: maskDestination(choice.preferred, to), sent, expiresInSeconds: LOGIN_OTP_TTL_SECONDS };
  });
}
