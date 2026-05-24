import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { encryptJson, decryptJson, hasCredentialsMasterKey } from "@connect/security";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return String(v);
}

function base64url(input: string | Buffer): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hmacSha256(key: string, data: string): string {
  const crypto = require("crypto");
  return base64url(crypto.createHmac("sha256", key).update(data, "utf8").digest());
}

async function requireAuth(req: any, reply: any): Promise<{ sub: string; tenantId: string; email?: string; role?: string } | null> {
  const user = req.user as { sub: string; tenantId: string; email?: string; role?: string } | undefined;
  if (!user?.sub || !user?.tenantId) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return user;
}

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const emailQueue = new Queue("crm-email-send", { connection: redis });

export async function registerCrmEmailRoutes(app: FastifyInstance) {
  // CRM Email Phase 1 is launching — routes always register unless explicitly disabled.
  const featureOff = String(process.env.CRM_EMAIL_PHASE1_ENABLED || "true").toLowerCase() === "false";
  if (featureOff) {
    app.log.info({ feature: "crm-email-phase1" }, "CRM Email Phase 1 disabled — routes not registered");
    return;
  }

  const cryptoReady = hasCredentialsMasterKey();
  if (!cryptoReady) app.log.warn("CRM email connection disabled: CREDENTIALS_MASTER_KEY missing/invalid");

  // GET /crm/email/connection — current user's connection (sanitized)
  app.get("/crm/email/connection", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const row = await db.crmEmailConnection.findUnique({ where: { tenantId_userId: { tenantId: user.tenantId, userId: user.sub } } }).catch(() => null);
    if (!row) return { connected: false, provider: null, emailAddress: null, displayName: null, replyTrackingEnabled: false, bodyCacheMode: "METADATA_ONLY", status: "DISCONNECTED" };
    return {
      connected: row.status === "CONNECTED",
      provider: row.provider,
      emailAddress: row.emailAddress,
      displayName: row.displayName,
      replyTrackingEnabled: row.replyTrackingEnabled,
      bodyCacheMode: row.bodyCacheMode,
      status: row.status,
      lastSyncAt: row.lastSyncAt,
      scopes: row.scopes,
    };
  });

  // POST /crm/email/oauth/start — returns Google OAuth URL (send-only scope in Phase 1)
  app.post("/crm/email/oauth/start", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    if (!cryptoReady) return reply.status(503).send({ error: "crypto_not_configured" });

    let clientId: string;
    let redirectUri: string;
    try {
      clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
      redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
    } catch {
      return reply.status(503).send({ error: "oauth_not_configured" });
    }

    const body = (req.body as any) || {};
    const bodyCacheMode = String(body?.bodyCacheMode || "METADATA_ONLY");
    const replyTrackingEnabled = false; // Phase 1 fixed

    const payload = {
      tenantId: user.tenantId,
      userId: user.sub,
      bodyCacheMode,
      replyTrackingEnabled,
      ts: Date.now(),
      nonce: base64url(Buffer.from(require("crypto").randomBytes(16))),
    };
    const payloadStr = JSON.stringify(payload);
    const sig = hmacSha256(process.env.JWT_SECRET || "connect-secret", payloadStr);
    const state = base64url(payloadStr) + "." + sig;

    const scope = [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send",
    ].join(" ");

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);

    return { url: url.toString() };
  });

  // GET /crm/email/oauth/callback — exchanges code, stores encrypted tokens, upserts connection
  app.get("/crm/email/oauth/callback", async (req, reply) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string };
      if (!code || !state) return reply.status(400).send({ error: "invalid_callback" });

      const [payloadB64, sig] = String(state).split(".");
      const payloadJson = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const expectSig = hmacSha256(process.env.JWT_SECRET || "connect-secret", payloadJson);
      if (sig !== expectSig) return reply.status(400).send({ error: "invalid_state" });
      const payload = JSON.parse(payloadJson) as { tenantId: string; userId: string; bodyCacheMode: string; replyTrackingEnabled: boolean };

      let clientId: string;
      let clientSecret: string;
      let redirectUri: string;
      try {
        clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
        clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
        redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
      } catch {
        return reply.status(503).send({ error: "oauth_not_configured" });
      }

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const tokenJson: any = await tokenRes.json();
      if (!tokenRes.ok) return reply.status(502).send({ error: "token_exchange_failed", detail: tokenJson });

      const accessToken = String(tokenJson.access_token || "");
      const refreshToken = String(tokenJson.refresh_token || "");
      const expiresInSec = Number(tokenJson.expires_in || 0);
      const tokenType = String(tokenJson.token_type || "Bearer");
      const scope = String(tokenJson.scope || "").split(/\s+/).filter(Boolean);
      const tokenExpiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null;

      // Fetch profile/email (displayName/email)
      const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const profile: any = await profileRes.json().catch(() => ({}));
      const emailAddress = String(profile?.email || "");
      const displayName = String(profile?.name || "");
      const googleAccountId = String(profile?.sub || "");

      const encryptedAccessToken = encryptJson({ accessToken, tokenType, scope });
      const encryptedRefreshToken = refreshToken ? encryptJson({ refreshToken }) : encryptJson({ refreshToken: null });

      const row = await db.crmEmailConnection.upsert({
        where: { tenantId_userId: { tenantId: payload.tenantId, userId: payload.userId } },
        create: {
          tenantId: payload.tenantId,
          userId: payload.userId,
          provider: "GOOGLE_WORKSPACE",
          emailAddress: emailAddress || "",
          displayName: displayName || null,
          googleAccountId: googleAccountId || null,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt,
          scopes: scope,
          replyTrackingEnabled: false,
          gmailHistoryId: null,
          bodyCacheMode: (payload.bodyCacheMode as any) || "METADATA_ONLY",
          bodyCacheRetentionDays: 30,
          status: "CONNECTED",
          lastSyncAt: null,
          lastError: null,
        },
        update: {
          emailAddress: emailAddress || undefined,
          displayName: displayName || undefined,
          googleAccountId: googleAccountId || undefined,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt,
          scopes: scope,
          replyTrackingEnabled: false,
          status: "CONNECTED",
          lastError: null,
        },
      });

      const portalUrl = (process.env.NEXT_PUBLIC_PORTAL_URL || "").trim();
      const redirectTarget = portalUrl ? `${portalUrl.replace(/\/$/, "")}/crm/email/settings?connected=1` : "/crm/email/settings?connected=1";
      reply.redirect(redirectTarget);
    } catch (e: any) {
      app.log.error({ route: "oauth_callback", err: e?.message || e });
      reply.status(500).send({ error: "oauth_callback_failed" });
    }
  });

  // DELETE /crm/email/connection — revoke + disconnect
  app.delete("/crm/email/connection", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const row = await db.crmEmailConnection.findUnique({ where: { tenantId_userId: { tenantId: user.tenantId, userId: user.sub } } });
    if (!row) return reply.send({ ok: true });

    try {
      // Best-effort revoke via Google using refresh token if present
      const refreshPayload = row.encryptedRefreshToken ? (decryptJson<any>(row.encryptedRefreshToken) || {}) : {};
      const tok = String(refreshPayload?.refreshToken || "");
      if (tok) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tok }),
        }).catch(() => undefined);
      }
    } catch {}

    await db.crmEmailConnection.update({
      where: { tenantId_userId: { tenantId: user.tenantId, userId: user.sub } },
      data: {
        status: "DISCONNECTED",
        encryptedAccessToken: encryptJson({ revoked: true }),
        encryptedRefreshToken: encryptJson({ revoked: true }),
        scopes: [],
        tokenExpiresAt: null,
        lastError: null,
      },
    });

    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_DISCONNECTED", entityType: "CrmEmailConnection", entityId: user.sub, actorUserId: user.sub } }).catch(() => undefined);
    return { ok: true };
  });

  // POST /crm/email/connection/test — queue a test email to self
  app.post("/crm/email/connection/test", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const row = await db.crmEmailConnection.findUnique({ where: { tenantId_userId: { tenantId: user.tenantId, userId: user.sub } } });
    if (!row || row.status !== "CONNECTED") return reply.status(400).send({ error: "not_connected" });

    const to = row.emailAddress;
    const subject = "Connect CRM test email";
    const bodyText = "This is a test email from Connect CRM.";

    await emailQueue.add("send", { tenantId: user.tenantId, userId: user.sub, to, subject, bodyText, contactId: null }, { removeOnComplete: 100, removeOnFail: 100 });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_TEST_QUEUED", entityType: "CrmEmailConnection", entityId: user.sub, actorUserId: user.sub } }).catch(() => undefined);
    return { ok: true };
  });

  // POST /crm/email/send — basic send (Phase 1). Body: { contactId?: string, toEmail?: string, subject?: string, bodyText?: string }
  app.post("/crm/email/send", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const row = await db.crmEmailConnection.findUnique({ where: { tenantId_userId: { tenantId: user.tenantId, userId: user.sub } } });
    if (!row || row.status !== "CONNECTED") return reply.status(400).send({ error: "not_connected" });

    const body = (req.body as any) || {};
    const contactId = body?.contactId ? String(body.contactId) : null;
    const toEmail = String(body?.toEmail || "").trim();
    let subject = String(body?.subject || "");
    let bodyText = String(body?.bodyText || "");
    const templateId = body?.templateId ? String(body.templateId) : null;

    if (templateId) {
      const tpl = await db.crmEmailTemplate.findFirst({
        where: {
          id: templateId,
          tenantId: user.tenantId,
          isArchived: false,
          OR: [{ visibility: "SHARED" }, { visibility: "PRIVATE", createdByUserId: user.sub }],
        },
      });
      if (!tpl) return reply.status(404).send({ error: "template_not_found" });
      if (!subject) subject = tpl.subject;
      if (!bodyText) bodyText = tpl.bodyText;
    }

    if (!contactId && !toEmail) return reply.status(400).send({ error: "invalid_payload", detail: "contactId or toEmail required" });
    if (subject.length > 500) return reply.status(400).send({ error: "invalid_payload", detail: "subject too long" });
    if (bodyText.length > 50000) return reply.status(400).send({ error: "invalid_payload", detail: "body too long" });

    // Resolve and validate contact belongs to tenant; derive toEmail if needed
    let resolvedTo = toEmail;
    if (contactId) {
      const contact = await db.contact.findFirst({ where: { id: contactId, tenantId: user.tenantId }, select: { id: true } });
      if (!contact) return reply.status(404).send({ error: "contact_not_found" });
      if (!resolvedTo) {
        const prim = await db.contactEmail.findFirst({ where: { contactId: contact.id, isPrimary: true }, select: { email: true } });
        if (!prim) return reply.status(404).send({ error: "contact_email_not_found" });
        resolvedTo = prim.email;
      }
    }

    // Simple per-user 1-minute rate limit using send logs
    const since = new Date(Date.now() - 60 * 1000);
    const recent = await db.crmEmailSendLog.count({ where: { tenantId: user.tenantId, userId: user.sub, createdAt: { gte: since } } });
    const MAX_PER_MINUTE = Number(process.env.CRM_EMAIL_MAX_PER_MINUTE || 30);
    if (recent >= MAX_PER_MINUTE) return reply.status(429).send({ error: "rate_limited", retryAfterSec: 60 });

    await emailQueue.add("send", { tenantId: user.tenantId, userId: user.sub, to: resolvedTo, subject, bodyText, contactId }, { removeOnComplete: 100, removeOnFail: 100 });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_SEND_QUEUED", entityType: "Contact", entityId: contactId || "", actorUserId: user.sub } }).catch(() => undefined);
    return { ok: true };
  });

  // GET /crm/email/templates — list templates available to this user (shared + own private)
  app.get("/crm/email/templates", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const includeArchived = String((req.query as any)?.includeArchived || "") === "true";
    const rows = await db.crmEmailTemplate.findMany({
      where: {
        tenantId: user.tenantId,
        ...(includeArchived ? {} : { isArchived: false }),
        OR: [
          { visibility: "SHARED" },
          { visibility: "PRIVATE", createdByUserId: user.sub },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
      select: { id: true, name: true, subject: true, bodyText: true, visibility: true, isArchived: true, createdByUserId: true, createdAt: true, updatedAt: true },
    });
    return { templates: rows };
  });

  // GET /crm/email/templates/:id
  app.get("/crm/email/templates/:id", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const row = await db.crmEmailTemplate.findFirst({
      where: {
        id,
        tenantId: user.tenantId,
        OR: [
          { visibility: "SHARED" },
          { visibility: "PRIVATE", createdByUserId: user.sub },
        ],
      },
    });
    if (!row) return reply.code(404).send({ error: "template_not_found" });
    return row;
  });

  // POST /crm/email/templates — create
  app.post("/crm/email/templates", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const body = (req.body as any) || {};
    const name = String(body?.name || "").trim();
    const subject = String(body?.subject || "").trim();
    const bodyText = String(body?.bodyText || "");
    const visibility = String(body?.visibility || "SHARED") === "PRIVATE" ? "PRIVATE" : "SHARED";
    if (!name) return reply.code(400).send({ error: "invalid_payload", detail: "name required" });
    if (!subject) return reply.code(400).send({ error: "invalid_payload", detail: "subject required" });
    if (name.length > 200) return reply.code(400).send({ error: "invalid_payload", detail: "name too long" });
    if (subject.length > 500) return reply.code(400).send({ error: "invalid_payload", detail: "subject too long" });
    if (bodyText.length > 50000) return reply.code(400).send({ error: "invalid_payload", detail: "body too long" });
    const row = await db.crmEmailTemplate.create({
      data: { tenantId: user.tenantId, createdByUserId: user.sub, name, subject, bodyText, visibility },
    });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_TEMPLATE_CREATED", entityType: "CrmEmailTemplate", entityId: row.id, actorUserId: user.sub } }).catch(() => undefined);
    return row;
  });

  // PUT /crm/email/templates/:id — update (creator or admin only)
  app.put("/crm/email/templates/:id", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await db.crmEmailTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    const isAdmin = user.role === "ADMIN" || user.role === "TENANT_ADMIN" || user.role === "SUPER_ADMIN";
    if (!isAdmin && existing.createdByUserId !== user.sub) return reply.code(403).send({ error: "forbidden" });
    const body = (req.body as any) || {};
    const data: any = {};
    if (typeof body?.name === "string") data.name = String(body.name).trim().slice(0, 200);
    if (typeof body?.subject === "string") data.subject = String(body.subject).trim().slice(0, 500);
    if (typeof body?.bodyText === "string") data.bodyText = String(body.bodyText).slice(0, 50000);
    if (typeof body?.visibility === "string") data.visibility = body.visibility === "PRIVATE" ? "PRIVATE" : "SHARED";
    if (typeof body?.isArchived === "boolean") data.isArchived = body.isArchived;
    if (data.name === "") return reply.code(400).send({ error: "invalid_payload", detail: "name required" });
    if (data.subject === "") return reply.code(400).send({ error: "invalid_payload", detail: "subject required" });
    const row = await db.crmEmailTemplate.update({ where: { id }, data });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_TEMPLATE_UPDATED", entityType: "CrmEmailTemplate", entityId: row.id, actorUserId: user.sub } }).catch(() => undefined);
    return row;
  });

  // DELETE /crm/email/templates/:id — archive (soft)
  app.delete("/crm/email/templates/:id", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await db.crmEmailTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    const isAdmin = user.role === "ADMIN" || user.role === "TENANT_ADMIN" || user.role === "SUPER_ADMIN";
    if (!isAdmin && existing.createdByUserId !== user.sub) return reply.code(403).send({ error: "forbidden" });
    await db.crmEmailTemplate.update({ where: { id }, data: { isArchived: true } });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_TEMPLATE_ARCHIVED", entityType: "CrmEmailTemplate", entityId: id, actorUserId: user.sub } }).catch(() => undefined);
    return { ok: true };
  });

  // GET /crm/email/recent — recent sent log (for dashboard)
  app.get("/crm/email/recent", async (req, reply) => {
    const user = await requireAuth(req, reply); if (!user) return;
    const limit = Math.min(50, Math.max(1, Number((req.query as any)?.limit ?? 20)));
    const rows = await db.crmEmailSendLog.findMany({
      where: { tenantId: user.tenantId, userId: user.sub },
      orderBy: [{ sentAt: "desc" }],
      take: limit,
      select: { id: true, toEmail: true, subject: true, status: true, errorMessage: true, sentAt: true, contactId: true, gmailMessageId: true },
    });
    return { sent: rows };
  });
}
