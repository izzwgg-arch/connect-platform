/**
 * Routes + runner for the per-tenant sign-in code. Rules and the pure decisions
 * live in ./loginOtp.ts — this file is the thin layer that touches the DB, the
 * SMS sender, the email outbox and Fastify. See loginOtp.ts's header for the
 * whole contract.
 *
 *   POST /auth/otp/verify   { preAuthToken, code, rememberDevice?, deviceLabel? }
 *   POST /auth/otp/resend   { preAuthToken, channel? }
 *   GET  /auth/otp/trusted-devices          (signed in)
 *   DELETE /auth/otp/trusted-devices        (signed in — forget them all)
 *   GET  /admin/tenants/:id/login-otp       (SUPER_ADMIN)
 *   PUT  /admin/tenants/:id/login-otp       (SUPER_ADMIN) { required, channel }
 *
 * ⛔ The two /auth/otp/* POSTs must be on the JWT bypass list — a pre-auth token
 * is not a session, so the global hook would 401 them before they ran (the
 * exact trap the `/internal/agent/*` doors fell into twice). A test pins it.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { createLoginThrottle, clientIpFromForwardedFor } from "../loginThrottle";
import { resolveBillingSmsSender, normalizeUsPhone } from "../billing/billingSmsSender";
import { OTP_PRE_AUTH_PURPOSE, mintPreAuthToken, verifyPreAuthToken } from "./preAuthToken";
import {
  LOGIN_CODE_EMAIL_TYPE,
  LOGIN_OTP_MAX_ATTEMPTS,
  LOGIN_OTP_MAX_SENDS,
  LOGIN_OTP_TTL_SECONDS,
  chooseChannels,
  decideChallengeReuse,
  decideOtpVerify,
  decideTrustedDevice,
  generateOtpCode,
  hashOtpCode,
  hashTrustedDeviceToken,
  maskDestination,
  mintTrustedDeviceToken,
  normalizeTenantOtpChannel,
  otpEmailHtml,
  otpEmailSubject,
  otpEmailText,
  otpSmsBody,
  trustedDeviceExpiry,
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
  requireSuperAdmin: (req: any, reply: any) => Promise<any | undefined>;
  log?: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void };
  /** Injected for tests; production uses the real senders. */
  sendSms?: (input: { tenantId: string; to: string; body: string }) => Promise<unknown>;
  queueEmail?: (input: { tenantId: string; toEmail: string; subject: string; htmlBody: string; textBody: string }) => Promise<unknown>;
  now?: () => number;
};

const nowOf = (deps: OtpRouteDeps) => (deps.now ? deps.now() : Date.now());

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

// ── the login-side entry point ───────────────────────────────────────────────

export type StartOtpInput = {
  user: { id: string; tenantId: string; email: string; phone?: string | null };
  tenantChannelSetting: unknown;
  requestedChannel?: unknown;
};

/**
 * Called by /auth/login when the gate says "challenge". Mints the OTP pre-auth
 * token, writes the challenge, sends the code, and returns the response body.
 * Sending failure is reported honestly (`sent:false`) rather than swallowed —
 * a customer told "we sent a code" who never receives one is locked out with
 * no explanation. The pre-auth token is still returned so /auth/otp/resend on
 * the other channel can rescue it.
 */
export async function startOtpChallenge(deps: OtpRouteDeps, input: StartOtpInput) {
  const now = nowOf(deps);
  const phone = normalizeUsPhone(input.user.phone || "");
  const choice = chooseChannels(normalizeTenantOtpChannel(input.tenantChannelSetting), !!phone, input.requestedChannel);
  const pre = mintPreAuthToken(input.user.id, now, OTP_PRE_AUTH_PURPOSE);
  const code = generateOtpCode();
  const to = choice.preferred === "SMS" ? String(phone) : input.user.email;

  // ⛔ One live code per person — see decideChallengeReuse(). A second sign-in
  // while a code is still good re-binds the existing challenge to THIS login
  // and sends nothing, so hitting /auth/login in a loop cannot spend the SMS
  // balance and a customer never holds two codes of which only one works.
  const existing = await (db as any).loginOtpChallenge
    .findFirst({ where: { userId: input.user.id, consumedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, attempts: true, consumedAt: true, expiresAt: true, channel: true, destinationMasked: true } })
    .catch(() => null);
  if (decideChallengeReuse(existing, now).reuse) {
    await (db as any).loginOtpChallenge.update({ where: { id: existing.id }, data: { preAuthJti: pre.jti } });
    void deps.audit({ tenantId: input.user.tenantId, actorUserId: input.user.id, action: "LOGIN_OTP_REUSED", entityType: "User", entityId: input.user.id, metadata: { channel: existing.channel } });
    return {
      otpChallengeRequired: true as const,
      preAuthToken: pre.token,
      expiresInSeconds: pre.expiresInSeconds,
      channel: String(existing.channel),
      channels: choice.channels,
      destination: String(existing.destinationMasked),
      sent: false,
      reason: "already_sent" as const,
      error: "otp_required" as const,
    };
  }

  const row = await (db as any).loginOtpChallenge.create({
    data: {
      userId: input.user.id,
      tenantId: input.user.tenantId,
      preAuthJti: pre.jti,
      channel: choice.preferred,
      destinationMasked: maskDestination(choice.preferred, to),
      codeHash: "pending",
      expiresAt: new Date(now + LOGIN_OTP_TTL_SECONDS * 1000),
    },
  });
  await (db as any).loginOtpChallenge.update({ where: { id: row.id }, data: { codeHash: hashOtpCode(code, row.id) } });
  let sent = true;
  try {
    await sendCode(deps, { tenantId: input.user.tenantId, channel: choice.preferred, to, code });
  } catch (err: any) {
    sent = false;
    deps.log?.warn({ userId: input.user.id, channel: choice.preferred, err: err?.message }, "login_otp_send_failed");
  }
  void deps.audit({ tenantId: input.user.tenantId, actorUserId: input.user.id, action: "LOGIN_OTP_SENT", entityType: "User", entityId: input.user.id, metadata: { channel: choice.preferred, sent } });
  return {
    otpChallengeRequired: true as const,
    preAuthToken: pre.token,
    expiresInSeconds: pre.expiresInSeconds,
    channel: choice.preferred,
    channels: choice.channels,
    destination: maskDestination(choice.preferred, to),
    sent,
    // For clients written before this existed (the mobile app throws
    // `json.error || "LOGIN_FAILED"` when there is no token): a readable slug.
    error: "otp_required" as const,
  };
}

/** Called by /auth/login when a remembered-device token was presented. */
export async function checkTrustedDevice(deps: OtpRouteDeps, userId: string, rawToken: unknown): Promise<{ valid: boolean; reason?: string }> {
  const token = String(rawToken ?? "").trim();
  if (!token) return { valid: false, reason: "absent" };
  const row = await (db as any).trustedLoginDevice.findUnique({ where: { tokenHash: hashTrustedDeviceToken(token) }, select: { id: true, userId: true, expiresAt: true, revokedAt: true } });
  const decision = decideTrustedDevice(row, userId, nowOf(deps));
  if (decision.valid && row) {
    await (db as any).trustedLoginDevice.update({ where: { id: row.id }, data: { lastUsedAt: new Date(nowOf(deps)) } }).catch(() => undefined);
  }
  return decision;
}

// ── routes ───────────────────────────────────────────────────────────────────

export async function registerLoginOtpRoutes(app: FastifyInstance, deps: OtpRouteDeps): Promise<void> {
  const sourceIp = (req: any) => clientIpFromForwardedFor(req.headers?.["x-forwarded-for"]);

  app.post("/auth/otp/verify", async (req: any, reply: any) => {
    const parsed = z.object({
      preAuthToken: z.string().min(20),
      code: z.union([z.string(), z.number()]).transform((v) => String(v)),
      rememberDevice: z.boolean().optional(),
      deviceLabel: z.string().max(120).optional(),
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

    let trusted: { trustedDeviceToken: string; trustedDeviceExpiresAt: string } | null = null;
    if (parsed.data.rememberDevice) {
      const minted = mintTrustedDeviceToken();
      const expiresAt = trustedDeviceExpiry(now);
      await (db as any).trustedLoginDevice.create({
        data: { userId: user.id, tenantId: user.tenantId, tokenHash: minted.tokenHash, label: parsed.data.deviceLabel || String(req.headers?.["user-agent"] || "").slice(0, 120) || null, expiresAt },
      });
      trusted = { trustedDeviceToken: minted.token, trustedDeviceExpiresAt: expiresAt.toISOString() };
    }
    void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "LOGIN_OTP_VERIFIED", entityType: "User", entityId: user.id, metadata: { remembered: !!trusted } });
    const session = await deps.issueSession(user.id);
    return { ...session, otpMethod: row.channel, ...(trusted ?? {}) };
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
    const user = await db.user.findUnique({ where: { id: pre.claims.sub }, select: { id: true, tenantId: true, email: true, phone: true, tenant: { select: { loginOtpChannel: true } } } as any }) as any;
    if (!user) return reply.status(401).send({ error: "otp_session_invalid", reason: "user_gone" });
    const phone = normalizeUsPhone(user.phone || "");
    const choice = chooseChannels(normalizeTenantOtpChannel(user.tenant?.loginOtpChannel), !!phone, parsed.data.channel);
    const to = choice.preferred === "SMS" ? String(phone) : user.email;
    const code = generateOtpCode();
    await (db as any).loginOtpChallenge.update({
      where: { id: row.id },
      data: { codeHash: hashOtpCode(code, row.id), channel: choice.preferred, destinationMasked: maskDestination(choice.preferred, to), sendCount: { increment: 1 }, attempts: 0, expiresAt: new Date(now + LOGIN_OTP_TTL_SECONDS * 1000) },
    });
    let sent = true;
    try { await sendCode(deps, { tenantId: user.tenantId, channel: choice.preferred, to, code }); }
    catch (err: any) { sent = false; deps.log?.warn({ userId: user.id, channel: choice.preferred, err: err?.message }, "login_otp_resend_failed"); }
    void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "LOGIN_OTP_RESENT", entityType: "User", entityId: user.id, metadata: { channel: choice.preferred, sent } });
    return { ok: true, channel: choice.preferred, channels: choice.channels, destination: maskDestination(choice.preferred, to), sent, expiresInSeconds: LOGIN_OTP_TTL_SECONDS };
  });

  app.get("/auth/otp/trusted-devices", async (req: any, reply: any) => {
    const u = req.user; if (!u?.sub) return reply.status(401).send({ error: "unauthorized" });
    const rows = await (db as any).trustedLoginDevice.findMany({ where: { userId: u.sub, revokedAt: null, expiresAt: { gt: new Date(nowOf(deps)) } }, orderBy: { createdAt: "desc" }, select: { id: true, label: true, createdAt: true, expiresAt: true, lastUsedAt: true } });
    return { devices: rows };
  });

  app.delete("/auth/otp/trusted-devices", async (req: any, reply: any) => {
    const u = req.user; if (!u?.sub) return reply.status(401).send({ error: "unauthorized" });
    const r = await (db as any).trustedLoginDevice.updateMany({ where: { userId: u.sub, revokedAt: null }, data: { revokedAt: new Date(nowOf(deps)) } });
    void deps.audit({ tenantId: u.tenantId, actorUserId: u.sub, action: "LOGIN_OTP_TRUSTED_DEVICES_REVOKED", entityType: "User", entityId: u.sub, metadata: { count: r?.count ?? 0 } });
    return { ok: true, revoked: r?.count ?? 0 };
  });

  // ── the per-tenant switch (SUPER_ADMIN) ────────────────────────────────────
  app.get("/admin/tenants/:id/login-otp", async (req: any, reply: any) => {
    const admin = await deps.requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = req.params as { id: string };
    const t = await (db as any).tenant.findUnique({ where: { id }, select: { id: true, name: true, loginOtpRequired: true, loginOtpChannel: true } });
    if (!t) return reply.status(404).send({ error: "tenant_not_found" });
    return { tenantId: t.id, name: t.name, required: !!t.loginOtpRequired, channel: normalizeTenantOtpChannel(t.loginOtpChannel) };
  });

  app.put("/admin/tenants/:id/login-otp", async (req: any, reply: any) => {
    const admin = await deps.requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = req.params as { id: string };
    const parsed = z.object({ required: z.boolean(), channel: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(["EMAIL", "SMS", "EITHER"])).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const existing = await (db as any).tenant.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: "tenant_not_found" });
    const updated = await (db as any).tenant.update({
      where: { id },
      data: { loginOtpRequired: parsed.data.required, ...(parsed.data.channel ? { loginOtpChannel: parsed.data.channel } : {}) },
      select: { id: true, loginOtpRequired: true, loginOtpChannel: true },
    });
    await deps.audit({ tenantId: id, actorUserId: admin.sub, action: "TENANT_LOGIN_OTP_UPDATED", entityType: "Tenant", entityId: id, metadata: { required: updated.loginOtpRequired, channel: updated.loginOtpChannel } });
    return { tenantId: id, required: !!updated.loginOtpRequired, channel: normalizeTenantOtpChannel(updated.loginOtpChannel) };
  });
}
