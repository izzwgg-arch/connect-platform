import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { encryptJson, decryptJson, hasCredentialsMasterKey } from "@connect/security";
import { randomUUID } from "node:crypto";
import { CRM_EMAIL_MERGE_FIELDS, plainTextToCrmHtml } from "@connect/shared";

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

import { requireCrmAccess, requireCrmEmailSettingsAccess, crmRoleBypassesContactRestriction, loadCrmUserAccessRole, isAdminRole } from "./guard.js";
import { assertCrmContactAllowed } from "./crmContactAccess.js";
import {
  canManageTenantSender,
  hasReadonlyScope,
  replyTrackingStatus,
  GMAIL_READONLY_SCOPE,
  resolveImplicitSenderConnectionOrder,
} from "./crmEmailHelpers.js";
import { generateCrmEmailTemplateDraft, CrmEmailTemplateAiError } from "./emailTemplateAi.js";
import {
  normalizeCrmEmailBrandingPayload,
  normalizeCrmEmailSignaturePayload,
  resolveCrmEmailBranding,
  resolveCrmEmailSignature,
} from "./emailTemplateBranding.js";
import {
  normalizeCrmEmailCategory,
  renderCrmEmailTemplate,
} from "./emailTemplateRenderer.js";
import {
  assertCrmEmailFileAllowed,
  normalizeCrmEmailMime,
  readCrmEmailAssetFile,
  writeCrmEmailAssetFile,
} from "./emailTemplateAttachmentStorage.js";
export { canManageTenantSender, hasReadonlyScope, replyTrackingStatus, GMAIL_READONLY_SCOPE } from "./crmEmailHelpers.js";

/**
 * Resolve the CrmEmailConnection a caller should send from, given an optional explicit choice.
 * Returns null when no usable sender exists.
 *
 * Fallback order:
 *   1. explicit connectionId (caller-chosen) — must be allowed (own USER row OR any TENANT row in tenant)
 *   2. tenant default TENANT connection (CONNECTED)
 *   3. lone TENANT connection (CONNECTED) when exactly one exists
 *   4. caller's own USER connection (CONNECTED)
 *   5. null
 */
async function resolveSenderConnection(opts: {
  tenantId: string;
  userId: string;
  explicitId?: string | null;
}): Promise<{ id: string; emailAddress: string; senderName: string | null; displayName: string | null; scope: "USER" | "TENANT" } | null> {
  const { tenantId, userId, explicitId } = opts;

  if (explicitId) {
    const row = await db.crmEmailConnection.findFirst({
      where: {
        id: explicitId,
        tenantId,
        status: "CONNECTED",
        OR: [
          { scope: "USER", userId },
          { scope: "TENANT" },
        ],
      },
      select: { id: true, emailAddress: true, senderName: true, displayName: true, scope: true },
    });
    if (row) return row as any;
    return null;
  }

  const rows = await db.crmEmailConnection.findMany({
    where: {
      tenantId,
      status: "CONNECTED",
      OR: [
        { scope: "TENANT" },
        { scope: "USER", userId },
      ],
    },
    select: { id: true, emailAddress: true, senderName: true, displayName: true, scope: true, userId: true, isDefaultForTenant: true },
  });
  const selected = resolveImplicitSenderConnectionOrder(rows as any, userId);
  if (selected) return selected as any;

  return null;
}

async function canManageTenantSenderForUser(user: { tenantId: string; sub: string; role?: string }): Promise<boolean> {
  if (canManageTenantSender(user)) return true;
  const crmRole = await loadCrmUserAccessRole(user.tenantId, user.sub);
  return canManageTenantSender(user, crmRole);
}

function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const emailQueue = new Queue("crm-email-send", { connection: redis });
const emailSyncQueue = new Queue("crm-email-sync", { connection: redis });

function isTemplateAdmin(user: { role?: string }) {
  return isAdminRole(user.role);
}

async function canEditTemplate(
  user: { sub: string; tenantId: string; role?: string },
  template: { createdByUserId?: string | null },
) {
  if (isTemplateAdmin(user)) return true;
  if (template.createdByUserId === user.sub) return true;
  const crmRole = await loadCrmUserAccessRole(user.tenantId, user.sub);
  return crmRoleBypassesContactRestriction(crmRole);
}

function normalizeTemplatePayload(body: any, creating = false): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (creating || typeof body?.name === "string") data.name = String(body?.name || "").trim().slice(0, 200);
  if (creating || typeof body?.subject === "string") data.subject = String(body?.subject || "").trim().slice(0, 500);
  if (creating || typeof body?.bodyText === "string") data.bodyText = String(body?.bodyText || "").slice(0, 50000);
  if (typeof body?.previewText === "string") data.previewText = String(body.previewText).trim().slice(0, 300);
  if (typeof body?.category === "string") data.category = normalizeCrmEmailCategory(body.category);
  if (typeof body?.isFavorite === "boolean") data.isFavorite = body.isFavorite;
  if (typeof body?.isDraft === "boolean") data.isDraft = body.isDraft;
  if (typeof body?.bodyHtml === "string") data.bodyHtml = String(body.bodyHtml).slice(0, 120000);
  if (body?.bodyJson !== undefined) data.bodyJson = body.bodyJson;
  if (typeof body?.visibility === "string") data.visibility = body.visibility === "PRIVATE" ? "PRIVATE" : "SHARED";
  if (typeof body?.isArchived === "boolean") data.isArchived = body.isArchived;
  return data;
}

function formatTemplate(row: any) {
  return {
    ...row,
    attachments: (row.attachments || []).map(formatAttachment),
  };
}

function formatAttachment(row: any) {
  return {
    id: row.id,
    templateId: row.templateId,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes || 0),
    disposition: row.disposition,
    isOptional: row.isOptional,
    createdAt: row.createdAt,
  };
}

async function formatBrandingForResponse(tenantId: string, tenantName?: string | null) {
  return resolveCrmEmailBranding(tenantId, tenantName, { logoMode: "preview" });
}

const STARTER_TEMPLATES = [
  {
    key: "welcome-new-lead",
    name: "Welcome New Lead",
    category: "Welcome",
    subject: "Welcome to {{business.name}}, {{contact.firstName}}",
    previewText: "We are excited to help you with your goals.",
    bodyText:
      "Hi {{contact.firstName}},\n\nThank you for reaching out to {{business.name}}. We are thrilled to have the opportunity to work with you and help you achieve your goals.\n\nHere is what you can expect next:\n\n- A member of our team will reach out shortly\n- We will create a customized plan for your needs\n- You will start seeing results\n\nIf you have any questions in the meantime, feel free to reply to this email.\n\nLooking forward to helping you succeed!\n\n{{sender.signature}}",
  },
  {
    key: "missed-call-follow-up",
    name: "Missed Call Follow-Up",
    category: "Follow-up",
    subject: "Sorry we missed you, {{contact.firstName}}",
    previewText: "Following up so we can help.",
    bodyText:
      "Hi {{contact.firstName}},\n\nSorry we missed your call. I wanted to follow up quickly and make sure you get the help you need.\n\nYou can reply to this email or call us at {{business.phone}} when it is convenient.\n\nBest regards,\n{{sender.signature}}",
  },
  {
    key: "appointment-reminder",
    name: "Appointment Reminder",
    category: "Appointment",
    subject: "Appointment reminder from {{business.name}}",
    previewText: "A quick reminder about your upcoming appointment.",
    bodyText:
      "Hi {{contact.firstName}},\n\nThis is a friendly reminder about your upcoming appointment with {{business.name}}.\n\nIf you need to reschedule, please reply to this email or call {{business.phone}}.\n\nThank you,\n{{sender.signature}}",
  },
  {
    key: "quote-follow-up",
    name: "Quote Follow-Up",
    category: "Sales",
    subject: "Following up on your quote, {{contact.firstName}}",
    previewText: "Checking in on the quote we prepared.",
    bodyText:
      "Hi {{contact.firstName}},\n\nI wanted to follow up on the quote we prepared for {{contact.company}}. I am happy to answer questions or adjust anything based on your goals.\n\nWould you like to review the next steps this week?\n\nBest,\n{{sender.signature}}",
  },
  {
    key: "payment-reminder",
    name: "Payment Reminder",
    category: "Collections",
    subject: "Payment reminder from {{business.name}}",
    previewText: "A friendly reminder about your account.",
    bodyText:
      "Hi {{contact.firstName}},\n\nThis is a friendly reminder from {{business.name}} regarding your account. Please contact us if you have already sent payment or need help with next steps.\n\nThank you,\n{{sender.signature}}",
  },
  {
    key: "thank-you",
    name: "Thank You",
    category: "Follow-up",
    subject: "Thank you, {{contact.firstName}}",
    previewText: "We appreciate the opportunity to work with you.",
    bodyText:
      "Hi {{contact.firstName}},\n\nThank you for choosing {{business.name}}. We appreciate the opportunity to work with you and look forward to supporting your goals.\n\nBest regards,\n{{sender.signature}}",
  },
  {
    key: "renewal-notice",
    name: "Renewal Notice",
    category: "Renewal",
    subject: "Your renewal with {{business.name}}",
    previewText: "Important renewal information for your account.",
    bodyText:
      "Hi {{contact.firstName}},\n\nYour renewal with {{business.name}} is coming up. We would be happy to review your current plan and confirm everything still fits your needs.\n\nPlease reply with any questions.\n\nBest,\n{{sender.signature}}",
  },
  {
    key: "re-engagement",
    name: "Re-engagement",
    category: "Sales",
    subject: "Still interested, {{contact.firstName}}?",
    previewText: "Checking in to see if we can still help.",
    bodyText:
      "Hi {{contact.firstName}},\n\nI wanted to check in and see if {{business.name}} can still help with your goals. If now is not the right time, no problem. If you would like to reconnect, just reply here.\n\nBest regards,\n{{sender.signature}}",
  },
];

export async function registerCrmEmailRoutes(app: FastifyInstance) {
  // CRM Email Phase 1 is launching — routes always register unless explicitly disabled.
  const featureOff = String(process.env.CRM_EMAIL_PHASE1_ENABLED || "true").toLowerCase() === "false";
  if (featureOff) {
    app.log.info({ feature: "crm-email-phase1" }, "CRM Email Phase 1 disabled — routes not registered");
    return;
  }

  const cryptoReady = hasCredentialsMasterKey();
  if (!cryptoReady) app.log.warn("CRM email connection disabled: CREDENTIALS_MASTER_KEY missing/invalid");

  // GET /crm/email/connection — backward-compat: caller's own USER connection
  app.get("/crm/email/connection", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const row = await db.crmEmailConnection.findFirst({
      where: { tenantId: user.tenantId, userId: user.sub, scope: "USER" },
    }).catch(() => null);
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

  // GET /crm/email/connections — all senders the caller is allowed to send from
  // Returns: { senders: SenderRef[], canManageTenantSenders: boolean }
  app.get("/crm/email/connections", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const rows = await db.crmEmailConnection.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { scope: "USER", userId: user.sub },
          { scope: "TENANT" },
        ],
      },
      orderBy: [{ scope: "asc" }, { isDefaultForTenant: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        scope: true,
        emailAddress: true,
        displayName: true,
        label: true,
        senderName: true,
        isDefaultForTenant: true,
        status: true,
        userId: true,
        managedByUserId: true,
        scopes: true,
        replyTrackingEnabled: true,
        lastSyncAt: true,
        lastError: true,
      },
    });
    const isAdmin = await canManageTenantSenderForUser(user);
    const senders = rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      emailAddress: r.emailAddress,
      displayName: r.displayName,
      label: r.label,
      senderName: r.senderName,
      isDefaultForTenant: r.isDefaultForTenant,
      status: r.status,
      isMine: r.scope === "USER" && r.userId === user.sub,
      canManage: r.scope === "USER" ? r.userId === user.sub : isAdmin,
      replyTrackingEnabled: r.replyTrackingEnabled,
      lastSyncAt: r.lastSyncAt,
      lastError: r.lastError,
    }));
    const autoSyncEnabled = (process.env.CRM_EMAIL_AUTO_SYNC_ENABLED || "false").toLowerCase() === "true";
    const autoSyncIntervalMs = Math.max(60_000, Number(process.env.CRM_EMAIL_AUTO_SYNC_INTERVAL_MS || 300_000));
    return { senders, canManageTenantSenders: isAdmin, autoSyncEnabled, autoSyncIntervalMs };
  });

  // POST /crm/email/oauth/start — returns Google OAuth URL (send-only scope in Phase 1)
  app.post("/crm/email/oauth/start", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
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
    const enableReplyTracking = Boolean(body?.enableReplyTracking);

    // scope = USER (default) or TENANT (admins only). label/isDefaultForTenant apply to TENANT.
    const scopeChoice: "USER" | "TENANT" = body?.scope === "TENANT" ? "TENANT" : "USER";
    if (scopeChoice === "TENANT" && !(await canManageTenantSenderForUser(user))) {
      return reply.status(403).send({ error: "forbidden", detail: "tenant_sender_requires_admin" });
    }
    const wantsDefault = scopeChoice === "TENANT" ? Boolean(body?.isDefaultForTenant) : false;
    const label = typeof body?.label === "string" ? String(body.label).trim().slice(0, 120) : null;

    const payload = {
      tenantId: user.tenantId,
      userId: user.sub,
      bodyCacheMode,
      replyTrackingEnabled: enableReplyTracking,
      scopeChoice,
      wantsDefault,
      label: label || null,
      ts: Date.now(),
      nonce: base64url(Buffer.from(require("crypto").randomBytes(16))),
    };
    const payloadStr = JSON.stringify(payload);
    const sig = hmacSha256(process.env.JWT_SECRET || "connect-secret", payloadStr);
    const state = base64url(payloadStr) + "." + sig;

    const scopesArr = [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send",
    ];
    if (enableReplyTracking) scopesArr.push("https://www.googleapis.com/auth/gmail.readonly");
    const scope = scopesArr.join(" ");

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
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
      if (!payloadB64 || !sig) return reply.status(400).send({ error: "invalid_state" });
      const payloadJson = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const expectSig = hmacSha256(process.env.JWT_SECRET || "connect-secret", payloadJson);
      // Constant-time compare to avoid timing oracle on the HMAC.
      const sigBuf = Buffer.from(sig);
      const expectBuf = Buffer.from(expectSig);
      const sigsMatch = sigBuf.length === expectBuf.length
        && require("crypto").timingSafeEqual(sigBuf, expectBuf);
      if (!sigsMatch) return reply.status(400).send({ error: "invalid_state" });
      const payload = JSON.parse(payloadJson) as {
        tenantId: string;
        userId: string;
        bodyCacheMode: string;
        replyTrackingEnabled: boolean;
        scopeChoice?: "USER" | "TENANT";
        wantsDefault?: boolean;
        label?: string | null;
        ts?: number;
      };
      // Reject expired state (10-minute window). The OAuth round-trip is normally
      // a few seconds; a 10-minute ceiling allows for slow consent screens but
      // forecloses indefinite replay of leaked state.
      const stateAgeMs = Date.now() - Number(payload.ts || 0);
      if (!Number.isFinite(stateAgeMs) || stateAgeMs < -60_000 || stateAgeMs > 10 * 60_000) {
        return reply.status(400).send({ error: "expired_state" });
      }
      if (!payload.tenantId || !payload.userId) {
        return reply.status(400).send({ error: "invalid_state" });
      }
      const scopeChoice: "USER" | "TENANT" = payload.scopeChoice === "TENANT" ? "TENANT" : "USER";

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
      const replyEnabled = scope.includes("https://www.googleapis.com/auth/gmail.readonly");

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

      let createdId: string | null = null;
      if (scopeChoice === "USER") {
        const existing = await db.crmEmailConnection.findFirst({
          where: { tenantId: payload.tenantId, userId: payload.userId, scope: "USER" },
          select: { id: true },
        });
        if (existing) {
          await db.crmEmailConnection.update({
            where: { id: existing.id },
            data: {
              emailAddress: emailAddress || undefined,
              displayName: displayName || undefined,
              googleAccountId: googleAccountId || undefined,
              encryptedAccessToken,
              encryptedRefreshToken,
              tokenExpiresAt,
              scopes: scope,
              replyTrackingEnabled: replyEnabled,
              status: "CONNECTED",
              lastError: null,
            },
          });
          createdId = existing.id;
        } else {
          const row = await db.crmEmailConnection.create({
            data: {
              tenantId: payload.tenantId,
              userId: payload.userId,
              scope: "USER",
              managedByUserId: null,
              provider: "GOOGLE_WORKSPACE",
              emailAddress: emailAddress || "",
              displayName: displayName || null,
              googleAccountId: googleAccountId || null,
              encryptedAccessToken,
              encryptedRefreshToken,
              tokenExpiresAt,
              scopes: scope,
              replyTrackingEnabled: replyEnabled,
              gmailHistoryId: null,
              bodyCacheMode: (payload.bodyCacheMode as any) || "METADATA_ONLY",
              bodyCacheRetentionDays: 30,
              status: "CONNECTED",
              lastSyncAt: null,
              lastError: null,
            },
            select: { id: true },
          });
          createdId = row.id;
        }
      } else {
        // TENANT scope — keyed by (tenantId, emailAddress, scope=TENANT). Reconnecting the
        // same mailbox refreshes tokens; a different admin would still write the same row.
        const existing = emailAddress
          ? await db.crmEmailConnection.findFirst({
              where: { tenantId: payload.tenantId, scope: "TENANT", emailAddress },
              select: { id: true, isDefaultForTenant: true },
            })
          : null;

        // Auto-promote: if this is the first TENANT sender for the tenant, mark as default.
        const otherCount = await db.crmEmailConnection.count({
          where: { tenantId: payload.tenantId, scope: "TENANT" },
        });
        const autoDefault = otherCount === 0;
        const shouldBeDefault = Boolean(payload.wantsDefault) || autoDefault || (existing?.isDefaultForTenant ?? false);

        if (existing) {
          await db.crmEmailConnection.update({
            where: { id: existing.id },
            data: {
              displayName: displayName || undefined,
              googleAccountId: googleAccountId || undefined,
              managedByUserId: payload.userId,
              label: payload.label ?? undefined,
              encryptedAccessToken,
              encryptedRefreshToken,
              tokenExpiresAt,
              scopes: scope,
              replyTrackingEnabled: replyEnabled,
              status: "CONNECTED",
              lastError: null,
            },
          });
          createdId = existing.id;
        } else {
          const row = await db.crmEmailConnection.create({
            data: {
              tenantId: payload.tenantId,
              userId: null,
              scope: "TENANT",
              managedByUserId: payload.userId,
              label: payload.label || null,
              isDefaultForTenant: false, // promote below in a tx to avoid partial-index collisions
              provider: "GOOGLE_WORKSPACE",
              emailAddress: emailAddress || "",
              displayName: displayName || null,
              googleAccountId: googleAccountId || null,
              encryptedAccessToken,
              encryptedRefreshToken,
              tokenExpiresAt,
              scopes: scope,
              replyTrackingEnabled: replyEnabled,
              gmailHistoryId: null,
              bodyCacheMode: (payload.bodyCacheMode as any) || "METADATA_ONLY",
              bodyCacheRetentionDays: 30,
              status: "CONNECTED",
              lastSyncAt: null,
              lastError: null,
            },
            select: { id: true },
          });
          createdId = row.id;
        }

        if (shouldBeDefault && createdId) {
          // Atomic swap: clear any previous default in same tenant, then set this one.
          await db.$transaction([
            db.crmEmailConnection.updateMany({
              where: { tenantId: payload.tenantId, scope: "TENANT", isDefaultForTenant: true, NOT: { id: createdId } },
              data: { isDefaultForTenant: false },
            }),
            db.crmEmailConnection.update({
              where: { id: createdId },
              data: { isDefaultForTenant: true },
            }),
          ]);
        }
      }

      await db.auditLog.create({
        data: {
          tenantId: payload.tenantId,
          action: scopeChoice === "TENANT" ? "CRM_EMAIL_TENANT_CONNECTED" : "CRM_EMAIL_USER_CONNECTED",
          entityType: "CrmEmailConnection",
          entityId: createdId || "",
          actorUserId: payload.userId,
        },
      }).catch(() => undefined);

      const portalUrl = (process.env.NEXT_PUBLIC_PORTAL_URL || "").trim();
      const redirectTarget = portalUrl ? `${portalUrl.replace(/\/$/, "")}/crm/email?connected=1` : "/crm/email?connected=1";
      reply.redirect(redirectTarget);
    } catch (e: any) {
      app.log.error({ route: "oauth_callback", err: e?.message || e });
      reply.status(500).send({ error: "oauth_callback_failed" });
    }
  });

  // Shared revoke-and-disconnect logic for both DELETE endpoints.
  async function softDisconnect(rowId: string, actorUserId: string, tenantId: string, encRefresh: string | null | undefined) {
    try {
      const refreshPayload = encRefresh ? (decryptJson<any>(encRefresh) || {}) : {};
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
      where: { id: rowId },
      data: {
        status: "DISCONNECTED",
        encryptedAccessToken: encryptJson({ revoked: true }),
        encryptedRefreshToken: encryptJson({ revoked: true }),
        scopes: [],
        tokenExpiresAt: null,
        lastError: null,
        isDefaultForTenant: false, // a disconnected sender can't be tenant default
      },
    });
    await db.auditLog.create({
      data: {
        tenantId,
        action: "CRM_EMAIL_DISCONNECTED",
        entityType: "CrmEmailConnection",
        entityId: rowId,
        actorUserId,
      },
    }).catch(() => undefined);
  }

  // DELETE /crm/email/connection — backward-compat: revoke caller's USER connection
  app.delete("/crm/email/connection", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const row = await db.crmEmailConnection.findFirst({
      where: { tenantId: user.tenantId, userId: user.sub, scope: "USER" },
    });
    if (!row) return reply.send({ ok: true });
    await softDisconnect(row.id, user.sub, user.tenantId, row.encryptedRefreshToken);
    return { ok: true };
  });

  // DELETE /crm/email/connections/:id — revoke any connection caller is allowed to manage
  app.delete("/crm/email/connections/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const row = await db.crmEmailConnection.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!row) return reply.code(404).send({ error: "connection_not_found" });
    const allowed =
      (row.scope === "USER" && row.userId === user.sub) ||
      (row.scope === "TENANT" && await canManageTenantSenderForUser(user));
    if (!allowed) return reply.code(403).send({ error: "forbidden" });
    await softDisconnect(row.id, user.sub, user.tenantId, row.encryptedRefreshToken);
    return { ok: true };
  });

  // PATCH /crm/email/connections/:id — edit label / senderName / isDefaultForTenant
  app.patch("/crm/email/connections/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const row = await db.crmEmailConnection.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!row) return reply.code(404).send({ error: "connection_not_found" });
    const allowed =
      (row.scope === "USER" && row.userId === user.sub) ||
      (row.scope === "TENANT" && await canManageTenantSenderForUser(user));
    if (!allowed) return reply.code(403).send({ error: "forbidden" });

    const body = (req.body as any) || {};
    const data: any = {};
    if (typeof body?.label === "string") data.label = String(body.label).trim().slice(0, 120) || null;
    if (typeof body?.senderName === "string") data.senderName = String(body.senderName).trim().slice(0, 120) || null;

    // isDefaultForTenant: TENANT scope only; atomic swap.
    const wantsDefault = typeof body?.isDefaultForTenant === "boolean" ? body.isDefaultForTenant : null;
    if (wantsDefault !== null) {
      if (row.scope !== "TENANT") return reply.code(400).send({ error: "invalid_payload", detail: "default_only_for_tenant_scope" });
      if (wantsDefault) {
        await db.$transaction([
          db.crmEmailConnection.updateMany({
            where: { tenantId: user.tenantId, scope: "TENANT", isDefaultForTenant: true, NOT: { id } },
            data: { isDefaultForTenant: false },
          }),
          db.crmEmailConnection.update({ where: { id }, data: { ...data, isDefaultForTenant: true } }),
        ]);
      } else {
        await db.crmEmailConnection.update({ where: { id }, data: { ...data, isDefaultForTenant: false } });
      }
    } else if (Object.keys(data).length > 0) {
      await db.crmEmailConnection.update({ where: { id }, data });
    }

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        action: "CRM_EMAIL_CONNECTION_UPDATED",
        entityType: "CrmEmailConnection",
        entityId: id,
        actorUserId: user.sub,
      },
    }).catch(() => undefined);
    return { ok: true };
  });

  // POST /crm/email/connection/test — queue a test email through resolved sender
  // Body (optional): { connectionId?: string } — explicit sender; otherwise fallback chain
  app.post("/crm/email/connection/test", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const body = (req.body as any) || {};
    const explicitId = body?.connectionId ? String(body.connectionId) : null;
    const sender = await resolveSenderConnection({ tenantId: user.tenantId, userId: user.sub, explicitId });
    if (!sender) return reply.status(400).send({ error: "not_connected" });

    const to = sender.emailAddress;
    const subject = "Connect CRM test email";
    const bodyText = "This is a test email from Connect CRM.";

    await emailQueue.add("send", {
      tenantId: user.tenantId,
      userId: user.sub,
      connectionId: sender.id,
      to, subject, bodyText, contactId: null,
    }, { removeOnComplete: 100, removeOnFail: 100 });
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        action: "CRM_EMAIL_TEST_QUEUED",
        entityType: "CrmEmailConnection",
        entityId: sender.id,
        actorUserId: user.sub,
      },
    }).catch(() => undefined);
    return { ok: true, senderId: sender.id, sentTo: to };
  });

  // POST /crm/email/sync-now — enqueue metadata-only reply sync (opt-in connections only)
  app.post("/crm/email/sync-now", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const body = (req.body as any) || {};
    const explicitId = body?.connectionId ? String(body.connectionId) : null;
    const diag = body?.diag === true;
    let targets: { id: string; scope: "USER" | "TENANT"; userId: string | null }[] = [];
    if (explicitId) {
      const r = await db.crmEmailConnection.findFirst({ where: { id: explicitId, tenantId: user.tenantId }, select: { id: true, scope: true, userId: true, replyTrackingEnabled: true, status: true } });
      if (!r) return reply.code(404).send({ error: "connection_not_found" });
      const canManageTenant = await canManageTenantSenderForUser(user);
      const allowed = (r.scope === "USER" && r.userId === user.sub) || (r.scope === "TENANT" && canManageTenant);
      if (!allowed) return reply.code(403).send({ error: "forbidden" });
      if (!r.replyTrackingEnabled || r.status !== "CONNECTED") return reply.code(400).send({ error: "not_enabled" });
      targets = [{ id: r.id, scope: r.scope as any, userId: r.userId }];
    } else {
      const rows = await db.crmEmailConnection.findMany({
        where: {
          tenantId: user.tenantId,
          replyTrackingEnabled: true,
          status: "CONNECTED",
          OR: [
            { scope: "USER", userId: user.sub },
            ...((await canManageTenantSenderForUser(user)) ? [{ scope: "TENANT" as const }] : []),
          ],
        },
        select: { id: true, scope: true, userId: true },
        take: 20,
      });
      targets = rows as any;
    }
    for (const t of targets) {
      await emailSyncQueue.add("sync", { tenantId: user.tenantId, connectionId: t.id, diag }, { removeOnComplete: 100, removeOnFail: 100 });
    }
    return { ok: true, queued: targets.length };
  });

  // GET /crm/email/sync-last — last sync diagnostics for a connection (admin or owner)
  app.get("/crm/email/sync-last", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { connectionId } = req.query as any;
    const id = String(connectionId || "");
    if (!id) return reply.code(400).send({ error: "invalid_query" });
    const row = await db.crmEmailConnection.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true, scope: true, userId: true } });
    if (!row) return reply.code(404).send({ error: "connection_not_found" });
    const allowed = (row.scope === "USER" && row.userId === user.sub) || (row.scope === "TENANT" && await canManageTenantSenderForUser(user));
    if (!allowed) return reply.code(403).send({ error: "forbidden" });
    const audit = await db.auditLog.findFirst({
      where: { tenantId: user.tenantId, entityType: "CrmEmailConnection", entityId: id, action: "CRM_EMAIL_SYNC_RESULT" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, metadata: true },
    });
    return { last: audit || null };
  });

  // GET /crm/email/replies/recent — metadata-only recent inbound messages
  app.get("/crm/email/replies/recent", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const limit = Math.min(50, Math.max(1, Number((req.query as any)?.limit ?? 20)));
    const isAdmin = await canManageTenantSenderForUser(user);
    const rows = await db.crmEmailMessage.findMany({
      where: {
        tenantId: user.tenantId,
        direction: "INBOUND",
        ...(isAdmin ? {} : { OR: [{ userId: user.sub }, { thread: { userId: user.sub } }] }),
      },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        id: true,
        gmailMessageId: true,
        direction: true,
        subject: true,
        fromEmail: true,
        toEmail: true,
        previewSnippet: true,
        receivedAt: true,
        contactId: true,
        thread: { select: { gmailThreadId: true } },
      },
    });
    const replies = rows.map((r) => ({
      id: r.id,
      gmailMessageId: r.gmailMessageId,
      gmailThreadId: r.thread?.gmailThreadId || null,
      subject: r.subject || null,
      fromEmail: r.fromEmail || null,
      toEmail: r.toEmail || null,
      previewSnippet: r.previewSnippet || null,
      receivedAt: r.receivedAt || null,
      contactId: r.contactId || null,
    }));
    return { replies };
  });

  // POST /crm/email/send — CRM email send with optional server-side template render.
  // Body: { contactId?, toEmail?, subject?, bodyText?, bodyHtml?, templateId?, connectionId?, attachmentIds?, ccSelf? }
  app.post("/crm/email/send", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;

    const body = (req.body as any) || {};
    const explicitConnectionId = body?.connectionId ? String(body.connectionId) : null;
    const sender = await resolveSenderConnection({
      tenantId: user.tenantId,
      userId: user.sub,
      explicitId: explicitConnectionId,
    });
    if (!sender) return reply.status(409).send({ error: "no_sender_available" });

    const contactId = body?.contactId ? String(body.contactId) : null;
    const toEmail = String(body?.toEmail || "").trim();
    const hasBodyTextOverride = typeof body?.bodyText === "string";
    const hasBodyHtmlOverride = typeof body?.bodyHtml === "string";
    let subject = String(body?.subject || "");
    let bodyText = String(body?.bodyText || "");
    let bodyHtml = hasBodyHtmlOverride ? String(body.bodyHtml) : "";
    const templateId = body?.templateId ? String(body.templateId) : null;
    const attachmentIds = Array.isArray(body?.attachmentIds) ? body.attachmentIds.map(String).slice(0, 20) : undefined;
    const ccSelf = body?.ccSelf === true;
    let ccEmail: string | null = null;

    if (ccSelf) {
      const row = await db.user.findFirst({
        where: { id: user.sub, tenantId: user.tenantId },
        select: { email: true },
      });
      const candidate = String(row?.email || "").trim();
      if (!candidate || !isValidEmailAddress(candidate)) {
        return reply.status(400).send({ error: "invalid_payload", detail: "user email required for ccSelf" });
      }
      ccEmail = candidate;
    }

    if (templateId) {
      const tpl = await (db as any).crmEmailTemplate.findFirst({
        where: {
          id: templateId,
          tenantId: user.tenantId,
          isArchived: false,
          OR: [{ visibility: "SHARED" }, { visibility: "PRIVATE", createdByUserId: user.sub }],
        },
      });
      if (!tpl) return reply.status(404).send({ error: "template_not_found" });
      const rendered = await renderCrmEmailTemplate({
        template: {
          subject: subject || tpl.subject,
          previewText: tpl.previewText,
          bodyText: hasBodyTextOverride ? bodyText : tpl.bodyText,
          bodyHtml: hasBodyHtmlOverride ? bodyHtml : (hasBodyTextOverride ? null : tpl.bodyHtml),
          bodyJson: tpl.bodyJson,
        },
        tenantId: user.tenantId,
        userId: user.sub,
        contactId,
        toEmail,
        sender,
      });
      subject = rendered.subject;
      bodyText = rendered.text;
      bodyHtml = rendered.html;
    }

    if (!contactId && !toEmail) return reply.status(400).send({ error: "invalid_payload", detail: "contactId or toEmail required" });
    if (subject.length > 500) return reply.status(400).send({ error: "invalid_payload", detail: "subject too long" });
    if (bodyText.length > 50000) return reply.status(400).send({ error: "invalid_payload", detail: "body too long" });
    if (bodyHtml.length > 150000) return reply.status(400).send({ error: "invalid_payload", detail: "html body too long" });

    // Resolve and validate contact belongs to tenant; derive toEmail if needed
    let resolvedTo = toEmail;
    if (contactId) {
      if (!(await assertCrmContactAllowed(user, contactId, reply))) return;
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

    await emailQueue.add("send", {
      tenantId: user.tenantId,
      userId: user.sub,
      connectionId: sender.id,
      to: resolvedTo,
      subject,
      bodyText,
      bodyHtml,
      contactId,
      templateId,
      attachmentIds,
      ccEmail,
      ccSelf,
    }, { removeOnComplete: 100, removeOnFail: 100 });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_SEND_QUEUED", entityType: "Contact", entityId: contactId || "", actorUserId: user.sub } }).catch(() => undefined);
    return { ok: true, senderId: sender.id };
  });

  app.get("/crm/email/merge-fields", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    return { fields: CRM_EMAIL_MERGE_FIELDS };
  });

  app.get("/crm/email/template-starters", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    return {
      starters: STARTER_TEMPLATES.map((starter) => ({
        ...starter,
        bodyHtml: plainTextToCrmHtml(starter.bodyText),
      })),
    };
  });

  app.get("/crm/email/branding", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const tenant = await (db as any).tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }).catch(() => null);
    const branding = await resolveCrmEmailBranding(user.tenantId, tenant?.name, { logoMode: "preview" });
    return { branding };
  });

  app.get("/crm/email/branding/logo", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const row = await (db as any).crmEmailBranding.findUnique({
      where: { tenantId: user.tenantId },
      select: { logoStorageKey: true, logoMimeType: true },
    }).catch(() => null);
    if (!row?.logoStorageKey) return reply.code(404).send({ error: "logo_not_found" });
    try {
      const bytes = await readCrmEmailAssetFile(row.logoStorageKey);
      reply.header("content-type", row.logoMimeType || "application/octet-stream");
      reply.header("cache-control", "private, max-age=300");
      return reply.send(bytes);
    } catch {
      return reply.code(404).send({ error: "logo_not_found" });
    }
  });

  app.put("/crm/email/branding", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const data = normalizeCrmEmailBrandingPayload((req.body as any) || {});
    await (db as any).crmEmailBranding.upsert({
      where: { tenantId: user.tenantId },
      create: { tenantId: user.tenantId, createdByUserId: user.sub, updatedByUserId: user.sub, ...data },
      update: { updatedByUserId: user.sub, ...data },
    });
    const tenant = await (db as any).tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }).catch(() => null);
    return { branding: await formatBrandingForResponse(user.tenantId, tenant?.name) };
  });

  app.post("/crm/email/branding/logo", async (req: any, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    if (!req.isMultipart?.()) return reply.code(400).send({ error: "multipart_required" });
    const file = await req.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: "file_required" });
    const buffer = await file.toBuffer();
    const mimeType = normalizeCrmEmailMime(file.mimetype);
    try {
      assertCrmEmailFileAllowed({ mimeType, originalFileName: file.filename || "logo", sizeBytes: buffer.length, logo: true });
      const fileId = randomUUID();
      const stored = await writeCrmEmailAssetFile({
        tenantId: user.tenantId,
        ownerId: "branding",
        fileId,
        buffer,
        mimeType,
        originalFileName: file.filename || "logo",
        logo: true,
      });
      await (db as any).crmEmailBranding.upsert({
        where: { tenantId: user.tenantId },
        create: {
          tenantId: user.tenantId,
          createdByUserId: user.sub,
          updatedByUserId: user.sub,
          logoStorageKey: stored.storageKey,
          logoMimeType: mimeType,
          logoFileName: file.filename || "logo",
        },
        update: {
          updatedByUserId: user.sub,
          logoStorageKey: stored.storageKey,
          logoMimeType: mimeType,
          logoFileName: file.filename || "logo",
        },
      });
      const tenant = await (db as any).tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }).catch(() => null);
      return { branding: await formatBrandingForResponse(user.tenantId, tenant?.name) };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || "upload_failed" });
    }
  });

  app.get("/crm/email/signature", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const signature = await resolveCrmEmailSignature({ tenantId: user.tenantId, userId: user.sub });
    return { signature };
  });

  app.put("/crm/email/signature", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const data = normalizeCrmEmailSignaturePayload((req.body as any) || {});
    const row = await (db as any).crmEmailSignature.upsert({
      where: { tenantId_userId: { tenantId: user.tenantId, userId: user.sub } },
      create: { tenantId: user.tenantId, userId: user.sub, ...data },
      update: data,
    });
    return { signature: row };
  });

  // GET /crm/email/templates — list templates available to this user (shared + own private)
  app.get("/crm/email/templates", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const includeArchived = String((req.query as any)?.includeArchived || "") === "true";
    const rows = await (db as any).crmEmailTemplate.findMany({
      where: {
        tenantId: user.tenantId,
        ...(includeArchived ? {} : { isArchived: false }),
        OR: [
          { visibility: "SHARED" },
          { visibility: "PRIVATE", createdByUserId: user.sub },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
      include: { attachments: true },
    });
    return { templates: rows.map(formatTemplate) };
  });

  // GET /crm/email/templates/:id
  app.get("/crm/email/templates/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const row = await (db as any).crmEmailTemplate.findFirst({
      where: {
        id,
        tenantId: user.tenantId,
        OR: [
          { visibility: "SHARED" },
          { visibility: "PRIVATE", createdByUserId: user.sub },
        ],
      },
      include: { attachments: true },
    });
    if (!row) return reply.code(404).send({ error: "template_not_found" });
    return formatTemplate(row);
  });

  // POST /crm/email/templates — create
  app.post("/crm/email/templates", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const body = (req.body as any) || {};
    const data = normalizeTemplatePayload(body, true);
    if (!String(data.name || "").trim()) return reply.code(400).send({ error: "invalid_payload", detail: "name required" });
    if (!String(data.subject || "").trim() && !body?.isDraft) return reply.code(400).send({ error: "invalid_payload", detail: "subject required" });
    const row = await (db as any).crmEmailTemplate.create({
      data: { tenantId: user.tenantId, createdByUserId: user.sub, visibility: "SHARED", category: "Custom", ...data },
    });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_TEMPLATE_CREATED", entityType: "CrmEmailTemplate", entityId: row.id, actorUserId: user.sub } }).catch(() => undefined);
    return formatTemplate({ ...row, attachments: [] });
  });

  // PUT /crm/email/templates/:id — update (creator or admin only)
  app.put("/crm/email/templates/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await (db as any).crmEmailTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    if (!(await canEditTemplate(user, existing))) return reply.code(403).send({ error: "forbidden" });
    const body = (req.body as any) || {};
    const data: any = normalizeTemplatePayload(body);
    if (data.name === "") return reply.code(400).send({ error: "invalid_payload", detail: "name required" });
    if (data.subject === "" && !body?.isDraft) return reply.code(400).send({ error: "invalid_payload", detail: "subject required" });
    const row = await (db as any).crmEmailTemplate.update({ where: { id }, data, include: { attachments: true } });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_TEMPLATE_UPDATED", entityType: "CrmEmailTemplate", entityId: row.id, actorUserId: user.sub } }).catch(() => undefined);
    return formatTemplate(row);
  });

  app.post("/crm/email/templates/:id/duplicate", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await (db as any).crmEmailTemplate.findFirst({
      where: {
        id,
        tenantId: user.tenantId,
        OR: [{ visibility: "SHARED" }, { visibility: "PRIVATE", createdByUserId: user.sub }],
      },
      include: { attachments: true },
    });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    const copy = await (db as any).crmEmailTemplate.create({
      data: {
        tenantId: user.tenantId,
        createdByUserId: user.sub,
        name: `${existing.name} Copy`.slice(0, 200),
        subject: existing.subject,
        bodyText: existing.bodyText,
        previewText: existing.previewText,
        category: existing.category,
        isFavorite: false,
        isDraft: existing.isDraft,
        bodyHtml: existing.bodyHtml,
        bodyJson: existing.bodyJson,
        builderVersion: existing.builderVersion,
        visibility: existing.visibility,
        attachments: {
          create: (existing.attachments || []).map((a: any) => ({
            tenantId: user.tenantId,
            uploadedByUserId: user.sub,
            originalFileName: a.originalFileName,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            storageKey: a.storageKey,
            contentHash: a.contentHash,
            disposition: a.disposition,
            isOptional: a.isOptional,
          })),
        },
      },
      include: { attachments: true },
    });
    return formatTemplate(copy);
  });

  app.post("/crm/email/templates/:id/send-test", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body as any) || {};
    const toEmail = String(body?.toEmail || "").trim() || String((await (db as any).user.findFirst({ where: { id: user.sub, tenantId: user.tenantId }, select: { email: true } }).catch(() => null))?.email || "");
    if (!toEmail) return reply.code(400).send({ error: "test_email_required" });
    const sender = await resolveSenderConnection({ tenantId: user.tenantId, userId: user.sub, explicitId: body?.connectionId ? String(body.connectionId) : null });
    if (!sender) return reply.status(409).send({ error: "no_sender_available" });
    const tpl = await (db as any).crmEmailTemplate.findFirst({
      where: { id, tenantId: user.tenantId, isArchived: false, OR: [{ visibility: "SHARED" }, { visibility: "PRIVATE", createdByUserId: user.sub }] },
    });
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    const rendered = await renderCrmEmailTemplate({ template: tpl, tenantId: user.tenantId, userId: user.sub, toEmail, sender });
    await emailQueue.add("send", {
      tenantId: user.tenantId,
      userId: user.sub,
      connectionId: sender.id,
      to: toEmail,
      subject: rendered.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
      templateId: id,
    }, { removeOnComplete: 100, removeOnFail: 100 });
    return { ok: true, toEmail, senderId: sender.id };
  });

  app.post("/crm/email/templates/ai", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const body = (req.body as any) || {};
    try {
      const draft = await generateCrmEmailTemplateDraft({
        action: String(body?.action || "generate"),
        prompt: String(body?.prompt || "").slice(0, 4000),
        subject: body?.subject,
        bodyText: body?.bodyText,
        category: body?.category,
      });
      return draft;
    } catch (err: any) {
      if (err instanceof CrmEmailTemplateAiError) {
        return reply.code(err.code === "ai_not_configured" ? 503 : 502).send({ error: err.code, detail: err.message });
      }
      return reply.code(502).send({ error: "ai_failed", detail: "AI generation failed." });
    }
  });

  app.post("/crm/email/templates/:id/attachments", async (req: any, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    if (!req.isMultipart?.()) return reply.code(400).send({ error: "multipart_required" });
    const { id } = req.params as { id: string };
    const existing = await (db as any).crmEmailTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    if (!(await canEditTemplate(user, existing))) return reply.code(403).send({ error: "forbidden" });
    const file = await req.file({ limits: { fileSize: Number(process.env.CRM_EMAIL_ATTACHMENT_MAX_BYTES || 15 * 1024 * 1024) } });
    if (!file) return reply.code(400).send({ error: "file_required" });
    const buffer = await file.toBuffer();
    const mimeType = normalizeCrmEmailMime(file.mimetype);
    try {
      assertCrmEmailFileAllowed({ mimeType, originalFileName: file.filename || "attachment", sizeBytes: buffer.length });
      const attachmentId = randomUUID();
      const stored = await writeCrmEmailAssetFile({
        tenantId: user.tenantId,
        ownerId: id,
        fileId: attachmentId,
        buffer,
        mimeType,
        originalFileName: file.filename || "attachment",
      });
      const row = await (db as any).crmEmailTemplateAttachment.create({
        data: {
          id: attachmentId,
          tenantId: user.tenantId,
          templateId: id,
          uploadedByUserId: user.sub,
          originalFileName: file.filename || "attachment",
          mimeType,
          sizeBytes: BigInt(stored.storedBytes),
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          isOptional: Boolean((file.fields as any)?.isOptional?.value),
        },
      });
      return { attachment: formatAttachment(row) };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || "upload_failed" });
    }
  });

  app.delete("/crm/email/templates/:id/attachments/:attachmentId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const existing = await (db as any).crmEmailTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    if (!(await canEditTemplate(user, existing))) return reply.code(403).send({ error: "forbidden" });
    await (db as any).crmEmailTemplateAttachment.deleteMany({ where: { id: attachmentId, templateId: id, tenantId: user.tenantId } });
    return { ok: true };
  });

  app.post("/crm/email/templates/:id/archive", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await (db as any).crmEmailTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    if (!(await canEditTemplate(user, existing))) return reply.code(403).send({ error: "forbidden" });
    await (db as any).crmEmailTemplate.update({ where: { id }, data: { isArchived: true } });
    await db.auditLog.create({ data: { tenantId: user.tenantId, action: "CRM_EMAIL_TEMPLATE_ARCHIVED", entityType: "CrmEmailTemplate", entityId: id, actorUserId: user.sub } }).catch(() => undefined);
    return { ok: true };
  });

  // DELETE remains archive-compatible for existing callers.
  app.delete("/crm/email/templates/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await (db as any).crmEmailTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    if (!(await canEditTemplate(user, existing))) return reply.code(403).send({ error: "forbidden" });
    await (db as any).crmEmailTemplate.update({ where: { id }, data: { isArchived: true } });
    return { ok: true };
  });

  // GET /crm/email/recent — recent sent log (for dashboard)
  app.get("/crm/email/recent", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const limit = Math.min(50, Math.max(1, Number((req.query as any)?.limit ?? 20)));
    const rows = await db.crmEmailSendLog.findMany({
      where: { tenantId: user.tenantId, userId: user.sub },
      orderBy: [{ sentAt: "desc" }],
      take: limit,
      select: { id: true, toEmail: true, subject: true, status: true, errorMessage: true, sentAt: true, contactId: true, gmailMessageId: true },
    });
    return { sent: rows };
  });

  // GET /crm/email/diagnostics/reply-tracking — fleet-level reply tracking health snapshot.
  // Returns aggregate counts only — no OAuth tokens, no email bodies, no secrets.
  app.get("/crm/email/diagnostics/reply-tracking", async (req, reply) => {
    const user = await requireCrmEmailSettingsAccess(req, reply); if (!user) return;
    const { tenantId } = user;

    const [
      trackedThreads,
      inboundReplies,
      connections,
      legacyThreadsCount,
      lastSyncAudit,
      outboundMessages,
    ] = await Promise.all([
      db.crmEmailThread.count({ where: { tenantId } }),
      db.crmEmailMessage.count({ where: { tenantId, direction: "INBOUND" } }),
      db.crmEmailConnection.findMany({
        where: { tenantId },
        select: { id: true, status: true, replyTrackingEnabled: true, scopes: true, lastSyncAt: true, lastError: true },
      }),
      db.crmEmailThread.count({ where: { tenantId, senderConnectionId: null } }),
      db.auditLog.findFirst({
        where: { tenantId, action: "CRM_EMAIL_SYNC_RESULT" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, metadata: true },
      }),
      db.crmEmailMessage.count({ where: { tenantId, direction: "OUTBOUND" } }),
    ]);

    const connected = connections.filter((c) => c.status === "CONNECTED");
    const connectionsTotal = connected.length;
    const connectionsEnabled = connected.filter((c) => c.replyTrackingEnabled).length;
    const connectionsMissingScope = connected.filter((c) => !hasReadonlyScope(c.scopes)).length;
    const connectionsDisabled = connected.filter((c) => !c.replyTrackingEnabled).length;
    const connectionsWithErrors = connected.filter((c) => c.lastError).length;

    const autoSyncOn = (process.env.CRM_EMAIL_AUTO_SYNC_ENABLED || "true").toLowerCase() !== "false";
    const autoSyncIntervalMs = Math.max(60_000, Number(process.env.CRM_EMAIL_AUTO_SYNC_INTERVAL_MS || 300_000));

    return {
      trackedThreads,
      inboundReplies,
      outboundMessages,
      legacyThreadsWithNullSender: legacyThreadsCount,
      connectionsTotal,
      connectionsEnabled,
      connectionsDisabled,
      connectionsMissingScope,
      connectionsWithErrors,
      lastSyncAt: lastSyncAudit?.createdAt ?? null,
      lastSyncResult: (lastSyncAudit?.metadata as any) ?? null,
      autoSyncEnabled: autoSyncOn,
      autoSyncIntervalMs,
    };
  });
}
