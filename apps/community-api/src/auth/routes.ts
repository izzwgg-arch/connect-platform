import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { env, testHooksEnabled } from "../env.js";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../lib/errors.js";
import { sha256, sixDigits, slugify, shortSuffix, token } from "../lib/ids.js";
import { normalizePhone } from "../lib/phone.js";
import { sendMail, sendSms } from "../lib/mail.js";
import { audit } from "../lib/audit.js";
import { track } from "../lib/analytics.js";
import { notify } from "../lib/notify.js";
import { buildSearchText } from "../lib/search.js";
import { hashPassword, passwordProblem, verifyPassword } from "./password.js";
import { clientIp, issueSession, labelFromUserAgent, revokeAllSessions, revokeSession, rotateSession } from "./tokens.js";
import { requireActor } from "./actor.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";
import { verifyLoopcomToken, type LoopcomVerifier } from "./loopcomSso.js";
import { verifyOAuthIdToken, type OAuthVerifier } from "./oauth.js";
import { registerPasskeyRoutes } from "./passkeys.js";

export type AuthDeps = {
  loopcomVerifier?: LoopcomVerifier;
  oauthVerifier?: OAuthVerifier;
};

const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const RESET_TTL_MS = 30 * 60_000;

const nameSchema = z.string().trim().min(1).max(60);
const emailSchema = z.string().trim().toLowerCase().email().max(200);

function tight(max: number, window = "1 minute") {
  return { config: { rateLimit: { max, timeWindow: window } } };
}

export async function uniqueUsername(db: Db, first: string, last: string): Promise<string> {
  const base = slugify(`${first}-${last}`) || "member";
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}-${shortSuffix()}`;
    const exists = await db.person.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${base}-${token(6)}`;
}

async function issueCode(db: Db, personId: string | null, purpose: "EMAIL_VERIFY" | "PHONE_VERIFY" | "PASSWORD_RESET" | "LOGIN_OTP" | "EMAIL_CHANGE", target: string) {
  // One live code per target+purpose — a resend replaces the old one.
  await db.verificationCode.updateMany({ where: { target, purpose, usedAt: null }, data: { usedAt: new Date() } });
  const code = sixDigits();
  const row = await db.verificationCode.create({
    data: { personId, purpose, target, codeHash: sha256(`${target}:${code}`), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  return { code, id: row.id };
}

async function consumeCode(db: Db, purpose: "EMAIL_VERIFY" | "PHONE_VERIFY" | "PASSWORD_RESET" | "LOGIN_OTP" | "EMAIL_CHANGE", target: string, code: string) {
  const row = await db.verificationCode.findFirst({ where: { target, purpose, usedAt: null }, orderBy: { createdAt: "desc" } });
  if (!row || row.expiresAt < new Date()) throw badRequest("code_expired", "That code expired. Request a new one.");
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw badRequest("code_locked", "Too many wrong tries. Request a new code.");
  if (row.codeHash !== sha256(`${target}:${String(code).trim()}`)) {
    await db.verificationCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    throw badRequest("code_wrong", "That code isn't right. Check it and try again.");
  }
  await db.verificationCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return row;
}

export function publicPerson(p: { id: string; username: string; email: string | null; phoneE164: string | null; emailVerifiedAt: Date | null; phoneVerifiedAt: Date | null; status: string; loopcomTenantId: string | null; mfaEnabledAt: Date | null; onboardingDoneAt: Date | null; createdAt: Date }) {
  return {
    id: p.id,
    username: p.username,
    email: p.email,
    phone: p.phoneE164,
    emailVerified: !!p.emailVerifiedAt,
    phoneVerified: !!p.phoneVerifiedAt,
    verified: !!p.emailVerifiedAt || !!p.phoneVerifiedAt,
    status: p.status,
    loopcomLinked: !!p.loopcomTenantId,
    mfaEnabled: !!p.mfaEnabledAt,
    onboardingDone: !!p.onboardingDoneAt,
    createdAt: p.createdAt,
  };
}

export function registerAuthRoutes(app: FastifyInstance, db: Db, deps: AuthDeps = {}) {
  const loopcom = deps.loopcomVerifier ?? verifyLoopcomToken;
  const oauth = deps.oauthVerifier ?? verifyOAuthIdToken;

  async function sendVerification(personId: string, purpose: "EMAIL_VERIFY" | "PHONE_VERIFY", target: string) {
    const { code } = await issueCode(db, personId, purpose, target);
    if (purpose === "EMAIL_VERIFY") {
      await sendMail(db, {
        to: target,
        subject: `${code} is your Loopcom Community code`,
        text: `Your verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't create a Loopcom Community account, ignore this email.`,
      });
    } else {
      await sendSms(db, target, `Loopcom Community code: ${code}. Expires in 10 minutes.`);
    }
  }

  async function detectNewDevice(personId: string, req: FastifyRequest) {
    const label = labelFromUserAgent(String(req.headers["user-agent"] || ""));
    const ip = clientIp(req);
    const prior = await db.session.count({ where: { personId, deviceLabel: label, createdAt: { lt: new Date(Date.now() - 60_000) } } });
    if (prior === 0) {
      const count = await db.session.count({ where: { personId } });
      if (count > 1) {
        await notify(db, {
          personId,
          kind: "security.alert",
          title: `New sign-in from ${label ?? "a new device"}`,
          body: `${ip ? `IP ${ip}. ` : ""}If this wasn't you, sign out of all devices and change your password.`,
          href: "/settings/security",
        });
      }
    }
  }

  async function sessionResponse(personId: string, req: FastifyRequest, client = "web") {
    const issued = await issueSession(app, db, personId, { userAgent: String(req.headers["user-agent"] || ""), ip: clientIp(req), client });
    const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
    return { ...issued, person: publicPerson(person) };
  }

  // ── register ────────────────────────────────────────────────────────────
  app.post("/auth/register", tight(10, "10 minutes"), async (req, reply) => {
    const body = z
      .object({
        firstName: nameSchema,
        lastName: nameSchema,
        email: emailSchema.optional(),
        phone: z.string().trim().max(30).optional(),
        password: z.string().min(1).max(200),
        client: z.string().max(30).optional(),
      })
      .parse(req.body);
    const phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.phone && !phone) throw badRequest("phone_invalid", "That phone number doesn't look right. Use the full number with area code.");
    if (!body.email && !phone) throw badRequest("contact_required", "Add an email or a mobile number so we can verify it's you.");
    const problem = passwordProblem(body.password, [body.firstName, body.lastName, body.email?.split("@")[0] ?? ""]);
    if (problem) throw badRequest("password_weak", problem);

    if (body.email) {
      const dupe = await db.person.findUnique({ where: { email: body.email }, select: { id: true, loopcomUserId: true } });
      if (dupe) {
        throw conflict(
          dupe.loopcomUserId ? "email_is_loopcom_account" : "email_taken",
          dupe.loopcomUserId
            ? "That email already belongs to a Loopcom account — sign in with Loopcom instead of creating a second identity."
            : "There's already a Loopcom ID with that email. Sign in, or reset your password.",
        );
      }
    }
    if (phone) {
      const dupe = await db.person.findUnique({ where: { phoneE164: phone }, select: { id: true } });
      if (dupe) throw conflict("phone_taken", "That mobile number is already on a Loopcom ID. Sign in, or reset your password.");
    }
    const username = await uniqueUsername(db, body.firstName, body.lastName);
    const person = await db.person.create({
      data: {
        username,
        email: body.email ?? null,
        phoneE164: phone,
        passwordHash: await hashPassword(body.password),
        profile: {
          create: {
            firstName: body.firstName,
            lastName: body.lastName,
            searchText: buildSearchText([body.firstName, body.lastName]),
          },
        },
      },
    });
    if (body.email) await sendVerification(person.id, "EMAIL_VERIFY", body.email);
    else if (phone) await sendVerification(person.id, "PHONE_VERIFY", phone);
    await audit(db, { actorId: person.id, action: "person.register", targetType: "Person", targetId: person.id, ip: clientIp(req) });
    await track(db, { personId: person.id, event: "signup", client: body.client ?? "web" });
    reply.status(201);
    return sessionResponse(person.id, req, body.client ?? "web");
  });

  // ── verification codes ──────────────────────────────────────────────────
  app.post("/auth/verify/send", tight(5, "10 minutes"), async (req) => {
    const actor = requireActor(req);
    const body = z.object({ purpose: z.enum(["email", "phone"]), target: z.string().trim().max(200).optional() }).parse(req.body);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId } });
    if (body.purpose === "email") {
      const target = body.target ? emailSchema.parse(body.target) : person.email;
      if (!target) throw badRequest("email_missing", "Add an email address first.");
      if (target !== person.email) {
        const dupe = await db.person.findUnique({ where: { email: target } });
        if (dupe) throw conflict("email_taken", "That email is already on another Loopcom ID.");
        await sendVerification(person.id, "EMAIL_VERIFY", target);
        return { sent: true, target, pendingChange: true };
      }
      await sendVerification(person.id, "EMAIL_VERIFY", target);
      return { sent: true, target };
    }
    const target = body.target ? normalizePhone(body.target) : person.phoneE164;
    if (!target) throw badRequest("phone_invalid", "Add a valid mobile number first.");
    if (target !== person.phoneE164) {
      const dupe = await db.person.findUnique({ where: { phoneE164: target } });
      if (dupe) throw conflict("phone_taken", "That number is already on another Loopcom ID.");
    }
    await sendVerification(person.id, "PHONE_VERIFY", target);
    return { sent: true, target };
  });

  app.post("/auth/verify/confirm", tight(20, "10 minutes"), async (req) => {
    const actor = requireActor(req);
    const body = z.object({ purpose: z.enum(["email", "phone"]), target: z.string().trim().max(200), code: z.string().trim().max(12) }).parse(req.body);
    if (body.purpose === "email") {
      const target = emailSchema.parse(body.target);
      const row = await consumeCode(db, "EMAIL_VERIFY", target, body.code);
      if (row.personId !== actor.personId) throw badRequest("code_wrong", "That code isn't right.");
      await db.person.update({ where: { id: actor.personId }, data: { email: target, emailVerifiedAt: new Date() } });
      await upsertVerification(db, actor.personId, "EMAIL");
      return { verified: true, purpose: "email" };
    }
    const target = normalizePhone(body.target);
    if (!target) throw badRequest("phone_invalid", "That number doesn't look right.");
    const row = await consumeCode(db, "PHONE_VERIFY", target, body.code);
    if (row.personId !== actor.personId) throw badRequest("code_wrong", "That code isn't right.");
    await db.person.update({ where: { id: actor.personId }, data: { phoneE164: target, phoneVerifiedAt: new Date() } });
    await upsertVerification(db, actor.personId, "PHONE");
    return { verified: true, purpose: "phone" };
  });

  // ── login ───────────────────────────────────────────────────────────────
  app.post("/auth/login", tight(10, "5 minutes"), async (req) => {
    const body = z.object({ identifier: z.string().trim().min(1).max(200), password: z.string().max(200), totp: z.string().max(12).optional(), client: z.string().max(30).optional() }).parse(req.body);
    const id = body.identifier.toLowerCase();
    const phone = normalizePhone(body.identifier);
    const person = await db.person.findFirst({ where: { OR: [{ email: id }, ...(phone ? [{ phoneE164: phone }] : []), { username: id }] } });
    const genericFail = () => unauthorized("That email/number and password don't match.");
    if (!person || !person.passwordHash) throw genericFail();
    if (!(await verifyPassword(person.passwordHash, body.password))) {
      await audit(db, { actorId: null, actorLabel: id, action: "person.login_failed", targetType: "Person", targetId: person.id, ip: clientIp(req) });
      throw genericFail();
    }
    if (person.status === "BANNED" || person.status === "SUSPENDED") throw new ApiError(403, "account_restricted", "This account can't sign in right now. Check your email for details.");
    if (person.status === "PENDING_DELETION") {
      await db.person.update({ where: { id: person.id }, data: { status: "ACTIVE", deleteAfter: null } });
    }
    if (person.mfaEnabledAt && person.mfaTotpSecret) {
      if (!body.totp) throw new ApiError(401, "mfa_required", "Enter the 6-digit code from your authenticator app.");
      if (!verifyTotp(person.mfaTotpSecret, body.totp)) throw new ApiError(401, "mfa_wrong", "That authenticator code isn't right.");
    }
    if (person.status === "DEACTIVATED") await db.person.update({ where: { id: person.id }, data: { status: "ACTIVE" } });
    const out = await sessionResponse(person.id, req, body.client ?? "web");
    await detectNewDevice(person.id, req);
    await audit(db, { actorId: person.id, action: "person.login", targetType: "Person", targetId: person.id, ip: clientIp(req) });
    await track(db, { personId: person.id, sessionId: out.sessionId, event: "login", client: body.client ?? "web" });
    return out;
  });

  app.post("/auth/refresh", tight(60), async (req) => {
    const body = z.object({ refreshToken: z.string().min(10).max(500) }).parse(req.body);
    return rotateSession(app, db, body.refreshToken);
  });

  app.post("/auth/logout", async (req) => {
    const actor = requireActor(req);
    await revokeSession(db, actor.sessionId);
    await track(db, { personId: actor.personId, sessionId: actor.sessionId, event: "logout" });
    return { ok: true };
  });

  app.post("/auth/logout-all", async (req) => {
    const actor = requireActor(req);
    await revokeAllSessions(db, actor.personId);
    await audit(db, { actorId: actor.personId, action: "person.logout_all", targetType: "Person", targetId: actor.personId });
    return { ok: true };
  });

  app.get("/auth/sessions", async (req) => {
    const actor = requireActor(req);
    const rows = await db.session.findMany({ where: { personId: actor.personId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: "desc" } });
    return {
      sessions: rows.map((s) => ({ id: s.id, deviceLabel: s.deviceLabel, client: s.client, ip: s.ip, lastUsedAt: s.lastUsedAt, createdAt: s.createdAt, current: s.id === actor.sessionId })),
    };
  });

  app.delete("/auth/sessions/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.session.findFirst({ where: { id, personId: actor.personId } });
    if (!row) throw notFound("That session");
    await revokeSession(db, id);
    return { ok: true };
  });

  // ── password ────────────────────────────────────────────────────────────
  app.post("/auth/password/forgot", tight(5, "15 minutes"), async (req) => {
    const body = z.object({ identifier: z.string().trim().min(1).max(200) }).parse(req.body);
    const id = body.identifier.toLowerCase();
    const phone = normalizePhone(body.identifier);
    const person = await db.person.findFirst({ where: { OR: [{ email: id }, ...(phone ? [{ phoneE164: phone }] : [])] } });
    // Always the same answer — never reveal whether the account exists.
    if (person) {
      const target = person.email && (id === person.email || !phone) ? person.email : person.phoneE164;
      if (target) {
        const resetToken = token(32);
        await db.verificationCode.create({
          data: { personId: person.id, purpose: "PASSWORD_RESET", target, codeHash: sha256(resetToken), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
        });
        const link = `${env().COMMUNITY_PUBLIC_URL}/reset-password?token=${resetToken}`;
        if (target.includes("@")) {
          await sendMail(db, { to: target, subject: "Reset your Loopcom Community password", text: `Reset your password here (valid 30 minutes):\n${link}\n\nIf you didn't ask for this, ignore it — nothing changes.` });
        } else {
          await sendSms(db, target, `Loopcom Community password reset: ${link}`);
        }
      }
    }
    return { ok: true, message: "If that account exists, a reset link is on its way." };
  });

  app.post("/auth/password/reset", tight(10, "15 minutes"), async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }).parse(req.body);
    const row = await db.verificationCode.findFirst({ where: { purpose: "PASSWORD_RESET", codeHash: sha256(body.token), usedAt: null } });
    if (!row || row.expiresAt < new Date() || !row.personId) throw badRequest("reset_invalid", "That reset link is no longer valid. Request a new one.");
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest("password_weak", problem);
    await db.$transaction([
      db.verificationCode.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      db.person.update({ where: { id: row.personId }, data: { passwordHash: await hashPassword(body.password) } }),
    ]);
    await revokeAllSessions(db, row.personId);
    await audit(db, { actorId: row.personId, action: "person.password_reset", targetType: "Person", targetId: row.personId, ip: clientIp(req) });
    await notify(db, { personId: row.personId, kind: "security.alert", title: "Your password was reset", body: "All devices were signed out. If this wasn't you, contact support immediately.", href: "/settings/security" });
    return { ok: true };
  });

  app.post("/auth/password/change", tight(10), async (req) => {
    const actor = requireActor(req);
    const body = z.object({ currentPassword: z.string().max(200).optional(), newPassword: z.string().max(200) }).parse(req.body);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId } });
    if (person.passwordHash) {
      if (!body.currentPassword || !(await verifyPassword(person.passwordHash, body.currentPassword))) throw badRequest("password_wrong", "Your current password isn't right.");
    }
    const problem = passwordProblem(body.newPassword, [person.email?.split("@")[0] ?? ""]);
    if (problem) throw badRequest("password_weak", problem);
    await db.person.update({ where: { id: actor.personId }, data: { passwordHash: await hashPassword(body.newPassword) } });
    await revokeAllSessions(db, actor.personId, actor.sessionId);
    await audit(db, { actorId: actor.personId, action: "person.password_change", targetType: "Person", targetId: actor.personId, ip: clientIp(req) });
    await notify(db, { personId: actor.personId, kind: "security.alert", title: "Your password was changed", body: "Other devices were signed out.", href: "/settings/security" });
    return { ok: true };
  });

  // ── MFA (TOTP) ──────────────────────────────────────────────────────────
  app.post("/auth/mfa/totp/setup", async (req) => {
    const actor = requireActor(req);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId } });
    if (person.mfaEnabledAt) throw conflict("mfa_already_on", "Two-step verification is already on. Turn it off first to set up a new app.");
    const secret = generateTotpSecret();
    await db.person.update({ where: { id: actor.personId }, data: { mfaTotpSecret: secret } });
    return { secret, otpauthUrl: otpauthUrl(secret, person.email || person.username) };
  });

  app.post("/auth/mfa/totp/enable", tight(10), async (req) => {
    const actor = requireActor(req);
    const { code } = z.object({ code: z.string().max(12) }).parse(req.body);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId } });
    if (!person.mfaTotpSecret) throw badRequest("mfa_not_setup", "Set up an authenticator app first.");
    if (!verifyTotp(person.mfaTotpSecret, code)) throw badRequest("mfa_wrong", "That code isn't right. Check the app and try again.");
    await db.person.update({ where: { id: actor.personId }, data: { mfaEnabledAt: new Date() } });
    await audit(db, { actorId: actor.personId, action: "person.mfa_enabled", targetType: "Person", targetId: actor.personId });
    return { enabled: true };
  });

  app.post("/auth/mfa/totp/disable", tight(10), async (req) => {
    const actor = requireActor(req);
    const { code } = z.object({ code: z.string().max(12) }).parse(req.body);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId } });
    if (!person.mfaEnabledAt || !person.mfaTotpSecret) return { enabled: false };
    if (!verifyTotp(person.mfaTotpSecret, code)) throw badRequest("mfa_wrong", "That code isn't right.");
    await db.person.update({ where: { id: actor.personId }, data: { mfaEnabledAt: null, mfaTotpSecret: null } });
    await audit(db, { actorId: actor.personId, action: "person.mfa_disabled", targetType: "Person", targetId: actor.personId });
    return { enabled: false };
  });

  // ── OAuth (Google / Apple) — sign in, or create when new ────────────────
  app.post("/auth/oauth/:provider", tight(20, "10 minutes"), async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(["google", "apple"]) }).parse(req.params);
    const body = z.object({ idToken: z.string().min(10).max(4000), firstName: z.string().max(60).optional(), lastName: z.string().max(60).optional(), client: z.string().max(30).optional() }).parse(req.body);
    const ident = await oauth(provider, body.idToken);
    if (!ident) throw unauthorized(`We couldn't verify that ${provider === "google" ? "Google" : "Apple"} sign-in. Try again.`);
    let personId: string | null = null;
    const linked = await db.oAuthAccount.findUnique({ where: { provider_subject: { provider, subject: ident.subject } } });
    if (linked) personId = linked.personId;
    else if (ident.email && ident.emailVerified) {
      const byEmail = await db.person.findUnique({ where: { email: ident.email } });
      if (byEmail) {
        personId = byEmail.id;
        await db.oAuthAccount.create({ data: { personId, provider, subject: ident.subject, email: ident.email } });
        if (!byEmail.emailVerifiedAt) await db.person.update({ where: { id: personId }, data: { emailVerifiedAt: new Date() } });
      }
    }
    let created = false;
    if (!personId) {
      const first = body.firstName || ident.firstName || (ident.email ? ident.email.split("@")[0] : "New");
      const last = body.lastName || ident.lastName || "Member";
      const person = await db.person.create({
        data: {
          username: await uniqueUsername(db, first, last),
          email: ident.email && ident.emailVerified ? ident.email : null,
          emailVerifiedAt: ident.email && ident.emailVerified ? new Date() : null,
          oauthAccounts: { create: { provider, subject: ident.subject, email: ident.email } },
          profile: { create: { firstName: first, lastName: last, searchText: buildSearchText([first, last]) } },
        },
      });
      personId = person.id;
      created = true;
      await track(db, { personId, event: "signup", client: body.client ?? "web", props: { provider } });
    }
    if (created) reply.status(201);
    const out = await sessionResponse(personId, req, body.client ?? "web");
    await audit(db, { actorId: personId, action: created ? "person.register" : "person.login", targetType: "Person", targetId: personId, ip: clientIp(req), after: { provider } });
    return { ...out, created };
  });

  // ── Loopcom SSO ─────────────────────────────────────────────────────────
  app.post("/auth/loopcom", tight(30, "10 minutes"), async (req, reply) => {
    const body = z.object({ token: z.string().min(10).max(4000), client: z.string().max(30).optional() }).parse(req.body);
    const ident = await loopcom(body.token);
    if (!ident) throw unauthorized("Loopcom didn't recognise that sign-in. Open Community from inside Loopcom and try again.");
    const email = ident.email.toLowerCase();
    let person = await db.person.findUnique({ where: { loopcomUserId: ident.userId } });
    let created = false;
    if (!person) {
      const byEmail = await db.person.findUnique({ where: { email } });
      if (byEmail) {
        if (byEmail.loopcomUserId && byEmail.loopcomUserId !== ident.userId) throw conflict("email_linked_elsewhere", "That email is already linked to a different Loopcom user.");
        person = await db.person.update({ where: { id: byEmail.id }, data: { loopcomUserId: ident.userId, loopcomTenantId: ident.tenantId, loopcomEmail: email, emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date() } });
      } else {
        const [first, last] = splitName(ident);
        person = await db.person.create({
          data: {
            username: await uniqueUsername(db, first, last),
            email,
            emailVerifiedAt: new Date(),
            loopcomUserId: ident.userId,
            loopcomTenantId: ident.tenantId,
            loopcomEmail: email,
            profile: { create: { firstName: first, lastName: last, searchText: buildSearchText([first, last]) } },
          },
        });
        created = true;
        await track(db, { personId: person.id, event: "signup", client: body.client ?? "web", props: { provider: "loopcom" } });
      }
      await upsertVerification(db, person.id, "LOOPCOM_CUSTOMER", { tenantId: ident.tenantId });
      await audit(db, { actorId: person.id, action: "person.loopcom_linked", targetType: "Person", targetId: person.id, after: { tenantId: ident.tenantId } });
    } else if (person.loopcomTenantId !== ident.tenantId) {
      person = await db.person.update({ where: { id: person.id }, data: { loopcomTenantId: ident.tenantId } });
    }
    // A Loopcom SUPER_ADMIN is platform staff here too.
    if (ident.role === "SUPER_ADMIN") {
      await db.staffGrant.upsert({ where: { personId: person.id }, create: { personId: person.id, role: "ADMIN" }, update: { role: "ADMIN" } });
    }
    if (created) reply.status(201);
    const out = await sessionResponse(person.id, req, body.client ?? "web");
    return { ...out, created, loopcom: { tenantId: ident.tenantId, tenantName: ident.tenantName ?? null, role: ident.role } };
  });

  app.post("/auth/link/loopcom", tight(10), async (req) => {
    const actor = requireActor(req);
    const body = z.object({ token: z.string().min(10).max(4000) }).parse(req.body);
    const ident = await loopcom(body.token);
    if (!ident) throw unauthorized("Loopcom didn't recognise that sign-in.");
    const taken = await db.person.findUnique({ where: { loopcomUserId: ident.userId } });
    if (taken && taken.id !== actor.personId) throw conflict("loopcom_user_linked", "That Loopcom user is already linked to another Loopcom ID.");
    await db.person.update({ where: { id: actor.personId }, data: { loopcomUserId: ident.userId, loopcomTenantId: ident.tenantId, loopcomEmail: ident.email.toLowerCase() } });
    await upsertVerification(db, actor.personId, "LOOPCOM_CUSTOMER", { tenantId: ident.tenantId });
    await audit(db, { actorId: actor.personId, action: "person.loopcom_linked", targetType: "Person", targetId: actor.personId, after: { tenantId: ident.tenantId } });
    return { linked: true, tenantId: ident.tenantId, tenantName: ident.tenantName ?? null };
  });

  app.delete("/auth/link/loopcom", async (req) => {
    const actor = requireActor(req);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId } });
    if (!person.passwordHash && !(await db.passkey.count({ where: { personId: actor.personId } })) && !(await db.oAuthAccount.count({ where: { personId: actor.personId } }))) {
      throw badRequest("no_other_login", "Set a password or add a passkey first, or you'd lose the only way to sign in.");
    }
    await db.person.update({ where: { id: actor.personId }, data: { loopcomUserId: null, loopcomTenantId: null, loopcomEmail: null } });
    await db.verification.updateMany({ where: { personId: actor.personId, kind: "LOOPCOM_CUSTOMER" }, data: { status: "EXPIRED" } });
    await audit(db, { actorId: actor.personId, action: "person.loopcom_unlinked", targetType: "Person", targetId: actor.personId });
    return { linked: false };
  });

  // ── me ──────────────────────────────────────────────────────────────────
  app.get("/auth/me", async (req) => {
    const actor = requireActor(req);
    const person = await db.person.findUniqueOrThrow({
      where: { id: actor.personId },
      include: {
        profile: true,
        memberships: { include: { organization: { select: { id: true, slug: true, displayName: true, logoAssetId: true, loopcomTenantId: true } } } },
      },
    });
    const [unreadNotifications, unreadMessages, pendingInvites] = await Promise.all([
      db.notification.count({ where: { personId: actor.personId, readAt: null } }),
      db.threadParticipant.aggregate({ where: { personId: actor.personId, state: "ACTIVE", archivedAt: null }, _sum: { unreadCount: true } }),
      db.connection.count({ where: { status: "PENDING", requesterId: { not: actor.personId }, OR: [{ aId: actor.personId }, { bId: actor.personId }] } }),
    ]);
    return {
      person: publicPerson(person),
      profile: person.profile,
      memberships: person.memberships.map((m) => ({ id: m.id, role: m.role, permissions: m.permissions, affiliation: m.affiliation, isPrimary: m.isPrimary, organization: m.organization })),
      staffRole: actor.staffRole,
      counts: { notifications: unreadNotifications, messages: unreadMessages._sum.unreadCount ?? 0, invitations: pendingInvites },
    };
  });

  // ── deactivate / delete / export ────────────────────────────────────────
  app.post("/auth/deactivate", async (req) => {
    const actor = requireActor(req);
    await db.person.update({ where: { id: actor.personId }, data: { status: "DEACTIVATED" } });
    await revokeAllSessions(db, actor.personId);
    await audit(db, { actorId: actor.personId, action: "person.deactivate", targetType: "Person", targetId: actor.personId });
    return { ok: true, message: "Your profile is hidden. Sign in any time to reactivate." };
  });

  app.post("/auth/delete", tight(5), async (req) => {
    const actor = requireActor(req);
    const body = z.object({ password: z.string().max(200).optional(), confirm: z.literal("DELETE") }).parse(req.body);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId } });
    if (person.passwordHash && (!body.password || !(await verifyPassword(person.passwordHash, body.password)))) throw badRequest("password_wrong", "Enter your password to confirm.");
    const deleteAfter = new Date(Date.now() + 14 * 86_400_000);
    await db.person.update({ where: { id: actor.personId }, data: { status: "PENDING_DELETION", deleteAfter } });
    await revokeAllSessions(db, actor.personId);
    if (person.email) {
      await sendMail(db, { to: person.email, subject: "Your Loopcom Community account will be deleted in 14 days", text: `We'll delete your account on ${deleteAfter.toDateString()}. Sign in before then to cancel.` });
    }
    await audit(db, { actorId: actor.personId, action: "person.delete_requested", targetType: "Person", targetId: actor.personId, after: { deleteAfter } });
    return { ok: true, deleteAfter };
  });

  app.get("/auth/export", tight(3, "1 hour"), async (req, reply) => {
    const actor = requireActor(req);
    const [person, posts, comments, connections, messages, notes, rfqs, quotes, applications, notifications] = await Promise.all([
      db.person.findUniqueOrThrow({ where: { id: actor.personId }, include: { profile: { include: { experiences: true, educations: true, services: true, certifications: true, portfolio: true } }, memberships: true, privacy: true, notificationPrefs: true, relationshipTags: true } }),
      db.post.findMany({ where: { authorId: actor.personId } }),
      db.comment.findMany({ where: { authorId: actor.personId } }),
      db.connection.findMany({ where: { OR: [{ aId: actor.personId }, { bId: actor.personId }] } }),
      db.message.findMany({ where: { senderId: actor.personId } }),
      db.privateNote.findMany({ where: { ownerId: actor.personId } }),
      db.rfq.findMany({ where: { buyerPersonId: actor.personId } }),
      db.quote.findMany({ where: { authorId: actor.personId } }),
      db.jobApplication.findMany({ where: { personId: actor.personId } }),
      db.notification.findMany({ where: { personId: actor.personId } }),
    ]);
    const { passwordHash, mfaTotpSecret, ...safePerson } = person as any;
    await audit(db, { actorId: actor.personId, action: "person.export", targetType: "Person", targetId: actor.personId });
    reply.header("content-disposition", `attachment; filename="loopcom-community-export-${person.username}.json"`);
    return { exportedAt: new Date().toISOString(), person: safePerson, posts, comments, connections, messages, notes, rfqs, quotes, applications, notifications };
  });

  // ── test hooks (never in production) ────────────────────────────────────
  if (testHooksEnabled()) {
    app.get("/dev/mailbox", async (req) => {
      const q = z.object({ to: z.string().optional(), limit: z.coerce.number().max(100).optional() }).parse(req.query);
      const rows = await db.outboundMail.findMany({ where: q.to ? { to: q.to } : {}, orderBy: { createdAt: "desc" }, take: q.limit ?? 20 });
      return { mail: rows };
    });
    app.get("/dev/last-code", async (req) => {
      const q = z.object({ target: z.string() }).parse(req.query);
      const row = await db.outboundMail.findFirst({ where: { to: q.target }, orderBy: { createdAt: "desc" } });
      const m = row?.text.match(/\b(\d{6})\b/);
      const link = row?.text.match(/token=([A-Za-z0-9_-]+)/);
      return { code: m?.[1] ?? null, resetToken: link?.[1] ?? null };
    });
  }

  registerPasskeyRoutes(app, db);
}

function splitName(ident: { firstName?: string | null; lastName?: string | null; displayName?: string | null; email: string }): [string, string] {
  if (ident.firstName || ident.lastName) return [ident.firstName || "New", ident.lastName || "Member"];
  const dn = (ident.displayName || "").trim();
  if (dn.includes(" ")) {
    const [f, ...rest] = dn.split(/\s+/);
    return [f, rest.join(" ")];
  }
  if (dn) return [dn, "Member"];
  return [ident.email.split("@")[0], "Member"];
}

export async function upsertVerification(db: Db, personId: string, kind: "EMAIL" | "PHONE" | "LOOPCOM_CUSTOMER" | "IDENTITY", evidence?: Record<string, unknown>) {
  const existing = await db.verification.findFirst({ where: { personId, kind } });
  if (existing) {
    await db.verification.update({ where: { id: existing.id }, data: { status: "VERIFIED", reviewedAt: new Date(), evidence: evidence as object | undefined } });
  } else {
    await db.verification.create({ data: { personId, kind, status: "VERIFIED", reviewedAt: new Date(), evidence: evidence as object | undefined } });
  }
}
