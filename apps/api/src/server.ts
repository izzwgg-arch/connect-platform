import Fastify from "fastify";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import {
  FakeNumberProvider,
  NumberProvider,
  sendTwilioTestMessage,
  TwilioNumberProvider,
  TwilioCredentials,
  validateTwilioCredentials,
  validateTwilioRequest,
  validateVoipMsCredentials,
  VoipMsCredentials,
  VoipMsNumberProvider
} from "@connect/integrations";
import { assessSmsRisk, normalizeSmsWithStop, tenDlcSubmissionSchema, twilioSettingsSchema } from "./validation";

const MAX_DAILY_LIMIT = 10000;
const MAX_HOURLY_LIMIT = 2000;
const MAX_PER_SECOND = 20;

const DEFAULT_DAILY_LIMIT = 500;
const DEFAULT_HOURLY_LIMIT = 100;
const DEFAULT_PER_SECOND = 5;
const DEFAULT_MAX_CAMPAIGN = 2000;

const app = Fastify({ logger: true });
const fallbackNumberProvider = new FakeNumberProvider();

app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
app.register(jwt, { secret: process.env.JWT_SECRET || "change-me" });

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });
const canUseCredentialCrypto = hasCredentialsMasterKey();
const providerTestMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
if (!canUseCredentialCrypto) app.log.warn("Provider credential endpoints disabled: CREDENTIALS_MASTER_KEY missing or invalid");

type JwtUser = { sub: string; tenantId: string; email: string; role: string };
type ProviderName = "TWILIO" | "VOIPMS";

type TwilioCredentialPayload = {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  fromNumber?: string;
  label?: string;
};

type VoipMsCredentialPayload = {
  username: string;
  password: string;
  fromNumber: string;
  apiBaseUrl?: string;
  label?: string;
};

type CampaignDecision = {
  status: "QUEUED" | "NEEDS_APPROVAL";
  requiresApproval: boolean;
  holdReason: string | null;
  riskScore: number;
  normalizedMessage: string;
};

const providerCredCache = new Map<string, { recordId: string; creds: any; expiresAt: number }>();
const providerCredCacheTtlMs = 60_000;
const testSendLimiter = new Map<string, number[]>();

function encodeEin(rawEin: string): string {
  return Buffer.from(rawEin, "utf8").toString("base64");
}

function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function maskValue(value: string | undefined | null, start = 6, end = 4): string | null {
  if (!value) return null;
  if (value.length <= start + end) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, start)}${"*".repeat(value.length - start - end)}${value.slice(-end)}`;
}

function credCacheKey(tenantId: string, provider: ProviderName): string {
  return `${tenantId}:${provider}`;
}

async function audit(params: {
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId?: string;
  provider?: ProviderName;
}) {
  await db.auditLog.create({
    data: {
      tenantId: params.tenantId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      actorUserId: params.actorUserId || null,
      provider: params.provider
    }
  });
}

function getUser(req: any): JwtUser {
  return req.user as JwtUser;
}

async function requireAdmin(req: any, reply: any): Promise<JwtUser | null> {
  const user = getUser(req);
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
    reply.status(403).send({ error: "forbidden" });
    return null;
  }
  return user;
}

async function requireSuperAdmin(req: any, reply: any): Promise<JwtUser | null> {
  const user = getUser(req);
  if (user.role !== "SUPER_ADMIN") {
    reply.status(403).send({ error: "forbidden" });
    return null;
  }
  return user;
}

function ensureCredentialCrypto(reply: any): boolean {
  if (canUseCredentialCrypto) return true;
  reply.status(503).send({ error: "provider_settings_unavailable", message: "Provider settings are unavailable until credential encryption is configured." });
  return false;
}

async function getTenantProviderCredentials(tenantId: string, provider: ProviderName, requireEnabled = true): Promise<{ recordId: string; creds: any } | null> {
  const key = credCacheKey(tenantId, provider);
  const cached = providerCredCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { recordId: cached.recordId, creds: cached.creds };

  const record = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId, provider } } });
  if (!record) return null;
  if (requireEnabled && !record.isEnabled) return null;

  try {
    const creds = decryptJson<any>(record.credentialsEncrypted);
    providerCredCache.set(key, { recordId: record.id, creds, expiresAt: Date.now() + providerCredCacheTtlMs });
    return { recordId: record.id, creds };
  } catch {
    return null;
  }
}

async function getTenantTwilioCredentials(tenantId: string): Promise<{ recordId: string; creds: TwilioCredentialPayload } | null> {
  const item = await getTenantProviderCredentials(tenantId, "TWILIO", true);
  if (!item) return null;
  const creds = item.creds as TwilioCredentialPayload;
  if (!creds.accountSid || !creds.authToken || (!creds.messagingServiceSid && !creds.fromNumber)) return null;
  return { recordId: item.recordId, creds };
}

async function providerIsReady(tenantId: string, provider: ProviderName): Promise<boolean> {
  const item = await getTenantProviderCredentials(tenantId, provider, true);
  if (!item) return false;
  if (provider === "TWILIO") {
    const c = item.creds as TwilioCredentialPayload;
    return !!(c.accountSid && c.authToken && (c.messagingServiceSid || c.fromNumber));
  }
  const c = item.creds as VoipMsCredentialPayload;
  return !!(c.username && c.password && c.fromNumber);
}

async function getNumberProviderClient(tenantId: string, provider: ProviderName): Promise<NumberProvider> {
  const creds = await getTenantProviderCredentials(tenantId, provider, true);
  if (!creds) throw new Error("provider_not_enabled");

  if (provider === "TWILIO") {
    const c = creds.creds as TwilioCredentials;
    return new TwilioNumberProvider(c, providerTestMode);
  }

  const c = creds.creds as VoipMsCredentials;
  return new VoipMsNumberProvider(c, providerTestMode);
}

async function getUsageAndFailureStats(tenantId: string): Promise<{ todaySent: number; hourSent: number; failureRate15m: number }> {
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startHour = new Date(Date.now() - 60 * 60 * 1000);
  const start15m = new Date(Date.now() - 15 * 60 * 1000);

  const [todaySent, hourSent, recent] = await Promise.all([
    db.smsMessage.count({ where: { campaign: { tenantId }, status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: startToday } } }),
    db.smsMessage.count({ where: { campaign: { tenantId }, status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: startHour } } }),
    db.smsMessage.findMany({ where: { campaign: { tenantId }, OR: [{ createdAt: { gte: start15m } }, { lastProviderUpdateAt: { gte: start15m } }] }, select: { status: true, providerStatus: true } })
  ]);

  let total = 0;
  let failures = 0;
  for (const msg of recent) {
    if (msg.status === "QUEUED") continue;
    total += 1;
    if (msg.status === "FAILED" || (msg.providerStatus || "").toLowerCase() === "undelivered") failures += 1;
  }

  return { todaySent, hourSent, failureRate15m: total > 0 ? failures / total : 0 };
}

async function getProviderHealthSummary(tenantId: string): Promise<Record<string, { sent: number; failed: number; circuitOpenUntil: string | null; lastErrorCode: string | null; lastErrorAt: string | null }>> {
  const since = new Date(Date.now() - 5 * 60 * 1000);
  const rows = await db.providerHealth.findMany({ where: { tenantId, windowStart: { gte: since } }, orderBy: { updatedAt: "desc" } });

  const out: Record<string, { sent: number; failed: number; circuitOpenUntil: string | null; lastErrorCode: string | null; lastErrorAt: string | null }> = {};
  for (const r of rows) {
    if (!out[r.provider]) {
      out[r.provider] = { sent: 0, failed: 0, circuitOpenUntil: r.circuitOpenUntil ? r.circuitOpenUntil.toISOString() : null, lastErrorCode: r.lastErrorCode || null, lastErrorAt: r.lastErrorAt ? r.lastErrorAt.toISOString() : null };
    }
    out[r.provider].sent += r.sentCount;
    out[r.provider].failed += r.failCount;
    if (!out[r.provider].circuitOpenUntil && r.circuitOpenUntil) out[r.provider].circuitOpenUntil = r.circuitOpenUntil.toISOString();
  }
  if (!out.TWILIO) out.TWILIO = { sent: 0, failed: 0, circuitOpenUntil: null, lastErrorCode: null, lastErrorAt: null };
  if (!out.VOIPMS) out.VOIPMS = { sent: 0, failed: 0, circuitOpenUntil: null, lastErrorCode: null, lastErrorAt: null };
  return out;
}

async function enqueueCampaignMessages(campaignId: string, tenantId: string) {
  const messages = await db.smsMessage.findMany({ where: { campaignId } });
  for (const msg of messages) {
    await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: null } });
    await smsQueue.add("send", { messageId: msg.id, tenantId }, { removeOnComplete: true, attempts: 3 });
  }
}

async function dailyUsageCount(tenantId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.smsMessage.count({ where: { campaign: { tenantId }, status: { in: ["QUEUED", "SENDING", "SENT"] }, createdAt: { gte: start } } });
}

async function latestTenDlcStatus(tenantId: string): Promise<string | null> {
  const latest = await db.tenDlcSubmission.findFirst({ where: { tenantId }, orderBy: { createdAt: "desc" }, select: { status: true } });
  return latest?.status || null;
}

function checkAndConsumeTestSendQuota(tenantId: string): boolean {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const entries = (testSendLimiter.get(tenantId) || []).filter((t) => t >= oneHourAgo);
  if (entries.length >= 5) {
    testSendLimiter.set(tenantId, entries);
    return false;
  }
  entries.push(now);
  testSendLimiter.set(tenantId, entries);
  return true;
}

function sanitizeLimitInput(input: { dailySmsLimit: number; hourlySmsLimit: number; perSecondRateLimit: number; maxCampaignSize: number }) {
  return {
    dailySmsLimit: Math.min(MAX_DAILY_LIMIT, Math.max(1, input.dailySmsLimit)),
    hourlySmsLimit: Math.min(MAX_HOURLY_LIMIT, Math.max(1, input.hourlySmsLimit)),
    perSecondRateLimit: Math.min(MAX_PER_SECOND, Math.max(1, input.perSecondRateLimit)),
    maxCampaignSize: Math.max(1, input.maxCampaignSize)
  };
}

async function decideCampaignPolicy(params: { tenant: any; tenantId: string; actorUserId: string; message: string; recipientsCount: number }): Promise<CampaignDecision | { reject: string }> {
  const { tenant, tenantId, actorUserId, message, recipientsCount } = params;

  if (recipientsCount > tenant.maxCampaignSize) {
    await audit({ tenantId, actorUserId, action: "SMS_CAMPAIGN_REJECTED_MAX_SIZE", entityType: "Tenant", entityId: tenantId });
    return { reject: `Campaign exceeds maxCampaignSize (${tenant.maxCampaignSize})` };
  }

  const normalized = normalizeSmsWithStop(message);
  if (!normalized.ok) {
    await audit({ tenantId, actorUserId, action: "SMS_ENFORCE_STOP_APPEND_TOO_LONG", entityType: "Tenant", entityId: tenantId });
    return { status: "NEEDS_APPROVAL", requiresApproval: true, holdReason: "STOP instruction required but message would exceed 160 characters. Manual review required.", riskScore: 45, normalizedMessage: message };
  }

  if (normalized.appendedStop) await audit({ tenantId, actorUserId, action: "SMS_STOP_INSTRUCTION_APPENDED", entityType: "Tenant", entityId: tenantId });

  const usage = await dailyUsageCount(tenantId);
  if (usage + recipientsCount > tenant.dailySmsCap) {
    await audit({ tenantId, actorUserId, action: "SMS_DAILY_CAP_REJECTED", entityType: "Tenant", entityId: tenantId });
    return { reject: `Daily SMS cap exceeded: cap=${tenant.dailySmsCap}, current=${usage}, requested=${recipientsCount}` };
  }

  const risk = assessSmsRisk(normalized.message);
  if (risk.riskScore >= 70) {
    await audit({ tenantId, actorUserId, action: "SMS_RISK_REQUIRES_APPROVAL", entityType: "Tenant", entityId: tenantId });
    return { status: "NEEDS_APPROVAL", requiresApproval: true, holdReason: `Risk score ${risk.riskScore}: ${risk.reasons.join(", ")}`, riskScore: risk.riskScore, normalizedMessage: normalized.message };
  }

  if (!tenant.isApproved) {
    await audit({ tenantId, actorUserId, action: "SMS_TENANT_NOT_APPROVED", entityType: "Tenant", entityId: tenantId });
    return { status: "NEEDS_APPROVAL", requiresApproval: true, holdReason: "Tenant is not approved for outbound messaging.", riskScore: risk.riskScore, normalizedMessage: normalized.message };
  }

  const sentCampaignCount = await db.smsCampaign.count({ where: { tenantId, status: "SENT" } });
  if (tenant.firstCampaignRequiresApproval && sentCampaignCount === 0) {
    await audit({ tenantId, actorUserId, action: "SMS_FIRST_CAMPAIGN_APPROVAL_REQUIRED", entityType: "Tenant", entityId: tenantId });
    return { status: "NEEDS_APPROVAL", requiresApproval: true, holdReason: "First campaign requires admin approval.", riskScore: risk.riskScore, normalizedMessage: normalized.message };
  }

  return { status: "QUEUED", requiresApproval: false, holdReason: null, riskScore: risk.riskScore, normalizedMessage: normalized.message };
}

app.get("/health", async () => ({ ok: true }));

const signupSchema = z.object({ tenantName: z.string().min(2), email: z.string().email(), password: z.string().min(8) });

app.post("/auth/signup", async (req, reply) => {
  const input = signupSchema.parse(req.body);
  const tenant = await db.tenant.create({
    data: {
      name: input.tenantName,
      isApproved: false,
      dailySmsCap: 100,
      perSecondRate: 1.0,
      firstCampaignRequiresApproval: true,
      smsSendMode: "TEST",
      dailySmsLimit: DEFAULT_DAILY_LIMIT,
      hourlySmsLimit: DEFAULT_HOURLY_LIMIT,
      perSecondRateLimit: DEFAULT_PER_SECOND,
      maxCampaignSize: DEFAULT_MAX_CAMPAIGN,
      smsSuspended: false,
      smsRoutingMode: "FAILOVER",
      smsPrimaryProvider: "TWILIO",
      smsSecondaryProvider: "VOIPMS",
      numberPurchaseEnabled: true
    }
  });

  const passwordHash = await bcrypt.hash(input.password, 10);
  const normalizedEmail = input.email.toLowerCase();
  const role = normalizedEmail.startsWith("support") && normalizedEmail.endsWith("@connectcomunications.com") ? "ADMIN" : "USER";
  const user = await db.user.create({ data: { tenantId: tenant.id, email: input.email, passwordHash, role } });

  await audit({ tenantId: tenant.id, actorUserId: user.id, action: "TENANT_SIGNUP_CREATED", entityType: "Tenant", entityId: tenant.id });
  const token = await reply.jwtSign({ sub: user.id, tenantId: tenant.id, email: user.email, role: user.role });
  return { token, user: { id: user.id, email: user.email, role: user.role }, tenant: { id: tenant.id, name: tenant.name } };
});

app.post("/auth/login", async (req, reply) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body);
  const user = await db.user.findUnique({ where: { email: input.email } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return reply.status(401).send({ error: "invalid_credentials" });
  const token = await reply.jwtSign({ sub: user.id, tenantId: user.tenantId, email: user.email, role: user.role });
  return { token };
});

app.addHook("preHandler", async (req, reply) => {
  if (["/health", "/auth/signup", "/auth/login", "/webhooks/twilio/sms-status"].includes(req.url)) return;
  try {
    await req.jwtVerify();
  } catch {
    return reply.status(401).send({ error: "unauthorized" });
  }
});

app.get("/me", async (req) => {
  const user = getUser(req);
  return { id: user.sub, tenantId: user.tenantId, email: user.email, role: user.role };
});

app.get("/settings/sms-limits", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });
  const usage = await getUsageAndFailureStats(admin.tenantId);
  return {
    limits: { dailySmsLimit: tenant.dailySmsLimit, hourlySmsLimit: tenant.hourlySmsLimit, perSecondRateLimit: tenant.perSecondRateLimit, maxCampaignSize: tenant.maxCampaignSize },
    usage,
    suspension: { smsSuspended: tenant.smsSuspended, smsSuspendedReason: tenant.smsSuspendedReason, smsSuspendedAt: tenant.smsSuspendedAt }
  };
});

app.post("/settings/sms-limits", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({
    dailySmsLimit: z.number().int().positive().optional(),
    hourlySmsLimit: z.number().int().positive().optional(),
    perSecondRateLimit: z.number().int().positive().optional(),
    maxCampaignSize: z.number().int().positive().optional(),
    smsSuspended: z.boolean().optional(),
    smsSuspendedReason: z.string().max(200).optional(),
    requestReview: z.boolean().optional()
  }).parse(req.body);

  if (input.requestReview) {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_REVIEW_REQUESTED", entityType: "Tenant", entityId: admin.tenantId });
    return { ok: true, requested: true };
  }

  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const isSuperAdmin = admin.role === "SUPER_ADMIN";
  const desired = sanitizeLimitInput({
    dailySmsLimit: input.dailySmsLimit ?? tenant.dailySmsLimit,
    hourlySmsLimit: input.hourlySmsLimit ?? tenant.hourlySmsLimit,
    perSecondRateLimit: input.perSecondRateLimit ?? tenant.perSecondRateLimit,
    maxCampaignSize: input.maxCampaignSize ?? tenant.maxCampaignSize
  });

  if (!isSuperAdmin) {
    if (desired.dailySmsLimit > DEFAULT_DAILY_LIMIT || desired.hourlySmsLimit > DEFAULT_HOURLY_LIMIT || desired.perSecondRateLimit > DEFAULT_PER_SECOND || desired.maxCampaignSize > DEFAULT_MAX_CAMPAIGN) {
      return reply.status(403).send({ error: "LIMIT_INCREASE_NOT_ALLOWED", message: "ADMIN cannot raise limits beyond default system baselines." });
    }
  }

  if (desired.dailySmsLimit > MAX_DAILY_LIMIT || desired.hourlySmsLimit > MAX_HOURLY_LIMIT || desired.perSecondRateLimit > MAX_PER_SECOND) {
    return reply.status(400).send({ error: "LIMIT_EXCEEDS_GLOBAL_HARD_CAP" });
  }

  const updateData: any = {
    dailySmsLimit: desired.dailySmsLimit,
    hourlySmsLimit: desired.hourlySmsLimit,
    perSecondRateLimit: desired.perSecondRateLimit,
    maxCampaignSize: desired.maxCampaignSize
  };

  if (typeof input.smsSuspended === "boolean") {
    updateData.smsSuspended = input.smsSuspended;
    if (input.smsSuspended) {
      updateData.smsSuspendedReason = input.smsSuspendedReason || "MANUAL_SUSPEND";
      updateData.smsSuspendedAt = new Date();
    } else {
      updateData.smsSuspendedReason = null;
      updateData.smsSuspendedAt = null;
    }
  }

  const updated = await db.tenant.update({ where: { id: admin.tenantId }, data: updateData });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_LIMITS_UPDATED", entityType: "Tenant", entityId: admin.tenantId });
  if (typeof input.smsSuspended === "boolean") {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: input.smsSuspended ? "SMS_TENANT_SUSPENDED" : "SMS_TENANT_UNSUSPENDED", entityType: "Tenant", entityId: admin.tenantId });
  }

  return {
    limits: { dailySmsLimit: updated.dailySmsLimit, hourlySmsLimit: updated.hourlySmsLimit, perSecondRateLimit: updated.perSecondRateLimit, maxCampaignSize: updated.maxCampaignSize },
    suspension: { smsSuspended: updated.smsSuspended, smsSuspendedReason: updated.smsSuspendedReason, smsSuspendedAt: updated.smsSuspendedAt }
  };
});

app.get("/settings/providers", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const creds = await db.providerCredential.findMany({ where: { tenantId: admin.tenantId }, orderBy: { updatedAt: "desc" } });

  return creds.map((row) => {
    let preview: Record<string, string | null> = {};
    try {
      if (row.provider === "TWILIO") {
        const d = decryptJson<TwilioCredentialPayload>(row.credentialsEncrypted);
        preview = { accountSid: maskValue(d.accountSid), authToken: d.authToken ? "********" : null, messagingServiceSid: maskValue(d.messagingServiceSid), fromNumber: maskValue(d.fromNumber, 2, 2) };
      } else if (row.provider === "VOIPMS") {
        const d = decryptJson<VoipMsCredentialPayload>(row.credentialsEncrypted);
        preview = { username: maskValue(d.username, 2, 2), password: d.password ? "********" : null, fromNumber: maskValue(d.fromNumber, 2, 2), apiBaseUrl: d.apiBaseUrl || null };
      }
    } catch {
      preview = {};
    }
    return { provider: row.provider, isEnabled: row.isEnabled, label: row.label, updatedAt: row.updatedAt, preview };
  });
});

app.put("/settings/providers/twilio", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = twilioSettingsSchema.parse(req.body);
  const payload: TwilioCredentialPayload = { accountSid: input.accountSid, authToken: input.authToken, messagingServiceSid: input.messagingServiceSid || undefined, fromNumber: input.fromNumber || undefined, label: input.label || undefined };
  const encrypted = encryptJson(payload);
  const existing = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: "TWILIO" } } });

  const updated = await db.providerCredential.upsert({
    where: { tenantId_provider: { tenantId: admin.tenantId, provider: "TWILIO" } },
    create: { tenantId: admin.tenantId, provider: "TWILIO", label: payload.label || "Primary Twilio", isEnabled: false, credentialsEncrypted: encrypted, credentialsKeyId: "v1", createdByUserId: admin.sub, updatedByUserId: admin.sub },
    update: { label: payload.label || existing?.label || "Primary Twilio", isEnabled: false, credentialsEncrypted: encrypted, credentialsKeyId: "v1", updatedByUserId: admin.sub }
  });

  providerCredCache.delete(credCacheKey(admin.tenantId, "TWILIO"));
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: existing ? "PROVIDER_CREDENTIAL_UPDATED" : "PROVIDER_CREDENTIAL_CREATED", entityType: "ProviderCredential", entityId: updated.id, provider: "TWILIO" });

  return { provider: "TWILIO", label: updated.label, isEnabled: updated.isEnabled, updatedAt: updated.updatedAt, preview: { accountSid: maskValue(payload.accountSid), authToken: "********", messagingServiceSid: maskValue(payload.messagingServiceSid), fromNumber: maskValue(payload.fromNumber, 2, 2) } };
});

app.post("/settings/providers/twilio/enable", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const record = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: "TWILIO" } } });
  if (!record) return reply.status(404).send({ error: "provider_not_configured" });

  let creds: TwilioCredentialPayload;
  try {
    creds = decryptJson<TwilioCredentialPayload>(record.credentialsEncrypted);
    if (!creds.accountSid || !creds.authToken || (!creds.messagingServiceSid && !creds.fromNumber)) {
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATION_FAILED", entityType: "ProviderCredential", entityId: record.id, provider: "TWILIO" });
      return reply.status(400).send({ error: "TWILIO_VALIDATION_FAILED", message: "Twilio credential fields are incomplete." });
    }
  } catch {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATION_FAILED", entityType: "ProviderCredential", entityId: record.id, provider: "TWILIO" });
    return reply.status(400).send({ error: "TWILIO_VALIDATION_FAILED", message: "Unable to decrypt Twilio credentials." });
  }

  const validation = await validateTwilioCredentials(creds);
  if (!validation.ok) {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATION_FAILED", entityType: "ProviderCredential", entityId: record.id, provider: "TWILIO" });
    return reply.status(400).send({ error: "TWILIO_VALIDATION_FAILED", message: validation.message });
  }

  const updated = await db.providerCredential.update({ where: { id: record.id }, data: { isEnabled: true, updatedByUserId: admin.sub } });
  providerCredCache.delete(credCacheKey(admin.tenantId, "TWILIO"));
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATED", entityType: "ProviderCredential", entityId: updated.id, provider: "TWILIO" });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_ENABLED", entityType: "ProviderCredential", entityId: updated.id, provider: "TWILIO" });

  return { provider: "TWILIO", isEnabled: true, updatedAt: updated.updatedAt };
});

app.post("/settings/providers/twilio/disable", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const record = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: "TWILIO" } } });
  if (!record) return reply.status(404).send({ error: "provider_not_configured" });

  const updated = await db.providerCredential.update({ where: { id: record.id }, data: { isEnabled: false, updatedByUserId: admin.sub } });
  providerCredCache.delete(credCacheKey(admin.tenantId, "TWILIO"));
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_DISABLED", entityType: "ProviderCredential", entityId: updated.id, provider: "TWILIO" });
  return { provider: "TWILIO", isEnabled: false, updatedAt: updated.updatedAt };
});

app.put("/settings/providers/voipms", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ username: z.string().min(1), password: z.string().min(1), fromNumber: z.string().min(8), apiBaseUrl: z.string().url().optional(), label: z.string().optional() }).parse(req.body);
  const payload: VoipMsCredentialPayload = { username: input.username, password: input.password, fromNumber: input.fromNumber, apiBaseUrl: input.apiBaseUrl, label: input.label };
  const encrypted = encryptJson(payload);
  const existing = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: "VOIPMS" } } });

  const updated = await db.providerCredential.upsert({
    where: { tenantId_provider: { tenantId: admin.tenantId, provider: "VOIPMS" } },
    create: { tenantId: admin.tenantId, provider: "VOIPMS", label: payload.label || "Primary VoIP.ms", isEnabled: false, credentialsEncrypted: encrypted, credentialsKeyId: "v1", createdByUserId: admin.sub, updatedByUserId: admin.sub },
    update: { label: payload.label || existing?.label || "Primary VoIP.ms", isEnabled: false, credentialsEncrypted: encrypted, credentialsKeyId: "v1", updatedByUserId: admin.sub }
  });

  providerCredCache.delete(credCacheKey(admin.tenantId, "VOIPMS"));
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: existing ? "PROVIDER_CREDENTIAL_UPDATED" : "PROVIDER_CREDENTIAL_CREATED", entityType: "ProviderCredential", entityId: updated.id, provider: "VOIPMS" });
  return { provider: "VOIPMS", label: updated.label, isEnabled: updated.isEnabled, updatedAt: updated.updatedAt, preview: { username: maskValue(payload.username, 2, 2), password: "********", fromNumber: maskValue(payload.fromNumber, 2, 2), apiBaseUrl: payload.apiBaseUrl || null } };
});

app.post("/settings/providers/voipms/enable", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const record = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: "VOIPMS" } } });
  if (!record) return reply.status(404).send({ error: "provider_not_configured" });

  let creds: VoipMsCredentialPayload;
  try {
    creds = decryptJson<VoipMsCredentialPayload>(record.credentialsEncrypted);
    if (!creds.username || !creds.password || !creds.fromNumber) {
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATION_FAILED", entityType: "ProviderCredential", entityId: record.id, provider: "VOIPMS" });
      return reply.status(400).send({ error: "VOIPMS_VALIDATION_FAILED", message: "VoIP.ms credential fields are incomplete." });
    }
  } catch {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATION_FAILED", entityType: "ProviderCredential", entityId: record.id, provider: "VOIPMS" });
    return reply.status(400).send({ error: "VOIPMS_VALIDATION_FAILED", message: "Unable to decrypt VoIP.ms credentials." });
  }

  const validation = await validateVoipMsCredentials(creds);
  if (!validation.ok) {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATION_FAILED", entityType: "ProviderCredential", entityId: record.id, provider: "VOIPMS" });
    return reply.status(400).send({ error: "VOIPMS_VALIDATION_FAILED", message: validation.message });
  }

  const updated = await db.providerCredential.update({ where: { id: record.id }, data: { isEnabled: true, updatedByUserId: admin.sub } });
  providerCredCache.delete(credCacheKey(admin.tenantId, "VOIPMS"));
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_VALIDATED", entityType: "ProviderCredential", entityId: updated.id, provider: "VOIPMS" });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_ENABLED", entityType: "ProviderCredential", entityId: updated.id, provider: "VOIPMS" });
  return { provider: "VOIPMS", isEnabled: true, updatedAt: updated.updatedAt };
});

app.post("/settings/providers/voipms/disable", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const record = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: "VOIPMS" } } });
  if (!record) return reply.status(404).send({ error: "provider_not_configured" });

  const updated = await db.providerCredential.update({ where: { id: record.id }, data: { isEnabled: false, updatedByUserId: admin.sub } });
  providerCredCache.delete(credCacheKey(admin.tenantId, "VOIPMS"));
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_DISABLED", entityType: "ProviderCredential", entityId: updated.id, provider: "VOIPMS" });
  return { provider: "VOIPMS", isEnabled: false, updatedAt: updated.updatedAt };
});

app.get("/settings/sms-routing", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const [twilio, voipms, health] = await Promise.all([providerIsReady(admin.tenantId, "TWILIO"), providerIsReady(admin.tenantId, "VOIPMS"), getProviderHealthSummary(admin.tenantId)]);

  let activeDecision: "PRIMARY" | "SECONDARY" | "LOCKED" = "PRIMARY";
  if (tenant.smsProviderLock) activeDecision = "LOCKED";
  else if (tenant.smsRoutingMode === "FAILOVER") {
    const primaryHealth = health[tenant.smsPrimaryProvider];
    if (primaryHealth?.circuitOpenUntil && tenant.smsSecondaryProvider) activeDecision = "SECONDARY";
  }

  return {
    smsRoutingMode: tenant.smsRoutingMode,
    smsPrimaryProvider: tenant.smsPrimaryProvider,
    smsSecondaryProvider: tenant.smsSecondaryProvider,
    smsProviderLock: tenant.smsProviderLock,
    smsProviderLockReason: tenant.smsProviderLockReason,
    providerEnabled: { TWILIO: twilio, VOIPMS: voipms },
    health,
    activeProviderDecision: activeDecision
  };
});

app.post("/settings/sms-routing", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({ routingMode: z.enum(["SINGLE_PRIMARY", "FAILOVER"]), primaryProvider: z.enum(["TWILIO", "VOIPMS"]), secondaryProvider: z.enum(["TWILIO", "VOIPMS"]).nullable().optional() }).parse(req.body);

  if (input.secondaryProvider && input.secondaryProvider === input.primaryProvider) return reply.status(400).send({ error: "ROUTING_INVALID", message: "Primary and secondary providers must differ." });

  const primaryReady = await providerIsReady(admin.tenantId, input.primaryProvider as ProviderName);
  if (!primaryReady) return reply.status(400).send({ error: "ROUTING_INVALID", message: "Primary provider must be enabled and validated." });

  if (input.routingMode === "FAILOVER" && input.secondaryProvider) {
    const secondaryReady = await providerIsReady(admin.tenantId, input.secondaryProvider as ProviderName);
    if (!secondaryReady) return reply.status(400).send({ error: "ROUTING_INVALID", message: "Secondary provider must be enabled and validated." });
  }

  const updated = await db.tenant.update({
    where: { id: admin.tenantId },
    data: {
      smsRoutingMode: input.routingMode,
      smsPrimaryProvider: input.primaryProvider,
      smsSecondaryProvider: input.routingMode === "FAILOVER" ? input.secondaryProvider || null : null
    }
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_ROUTING_UPDATED", entityType: "Tenant", entityId: admin.tenantId });
  return { smsRoutingMode: updated.smsRoutingMode, smsPrimaryProvider: updated.smsPrimaryProvider, smsSecondaryProvider: updated.smsSecondaryProvider };
});

app.post("/settings/sms-routing/lock", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({ provider: z.enum(["TWILIO", "VOIPMS"]), reason: z.string().min(2) }).parse(req.body);
  const ready = await providerIsReady(admin.tenantId, input.provider as ProviderName);
  if (!ready) return reply.status(400).send({ error: "ROUTING_LOCK_INVALID", message: "Cannot lock to a provider that is not enabled and validated." });

  const updated = await db.tenant.update({
    where: { id: admin.tenantId },
    data: {
      smsProviderLock: input.provider,
      smsProviderLockReason: input.reason,
      smsProviderLockedAt: new Date(),
      smsProviderLockedByUserId: admin.sub
    }
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_PROVIDER_LOCKED", entityType: "Tenant", entityId: admin.tenantId, provider: input.provider as ProviderName });
  return { smsProviderLock: updated.smsProviderLock, smsProviderLockReason: updated.smsProviderLockReason, smsProviderLockedAt: updated.smsProviderLockedAt };
});

app.post("/settings/sms-routing/unlock", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  await db.tenant.update({ where: { id: admin.tenantId }, data: { smsProviderLock: null, smsProviderLockReason: null, smsProviderLockedAt: null, smsProviderLockedByUserId: null } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_PROVIDER_UNLOCKED", entityType: "Tenant", entityId: admin.tenantId });
  return { unlocked: true };
});

app.get("/numbers", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const rows = await db.phoneNumber.findMany({ where: { tenantId: admin.tenantId }, orderBy: { createdAt: "desc" } });
  return rows.map((n) => ({
    id: n.id,
    provider: n.provider,
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    capabilities: n.capabilities,
    region: n.region,
    areaCode: n.areaCode,
    monthlyCostCents: n.monthlyCostCents,
    status: n.status,
    purchasedAt: n.purchasedAt,
    releasedAt: n.releasedAt,
    isDefaultSms: tenant.defaultSmsFromNumberId === n.id
  }));
});

app.post("/numbers/search", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });
  if (!tenant.numberPurchaseEnabled) return reply.status(403).send({ error: "NUMBER_PURCHASE_DISABLED" });

  const input = z.object({ provider: z.enum(["TWILIO", "VOIPMS"]), type: z.enum(["local", "tollfree"]).default("local"), areaCode: z.string().optional(), contains: z.string().optional(), limit: z.number().int().positive().max(50).optional() }).parse(req.body);

  if (!(await providerIsReady(admin.tenantId, input.provider as ProviderName))) {
    return reply.status(400).send({ error: "PROVIDER_NOT_READY", message: "Provider is not enabled and validated." });
  }

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_SEARCHED", entityType: "Tenant", entityId: admin.tenantId, provider: input.provider as ProviderName });

  try {
    const provider = await getNumberProviderClient(admin.tenantId, input.provider as ProviderName);
    const found = await provider.searchNumbers({ type: input.type, areaCode: input.areaCode, contains: input.contains, limit: input.limit || 20 });
    return { provider: input.provider, results: found };
  } catch (e: any) {
    if (String(e?.code || "").includes("VOIPMS_NUMBER_SEARCH_UNAVAILABLE")) {
      return reply.status(200).send({ provider: input.provider, unavailable: true, message: "VoIP.ms number search not available yet", results: [] });
    }
    return reply.status(400).send({ error: "NUMBER_SEARCH_FAILED", message: "Unable to search numbers with selected provider." });
  }
});

app.post("/numbers/purchase", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });
  if (!tenant.numberPurchaseEnabled) return reply.status(403).send({ error: "NUMBER_PURCHASE_DISABLED" });

  const input = z.object({ provider: z.enum(["TWILIO", "VOIPMS"]), phoneNumber: z.string(), makeDefaultSms: z.boolean().optional() }).parse(req.body);
  if (!isE164(input.phoneNumber)) return reply.status(400).send({ error: "INVALID_PHONE_NUMBER" });

  if (!(await providerIsReady(admin.tenantId, input.provider as ProviderName))) {
    return reply.status(400).send({ error: "PROVIDER_NOT_READY", message: "Provider is not enabled and validated." });
  }

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_PURCHASE_REQUESTED", entityType: "Tenant", entityId: admin.tenantId, provider: input.provider as ProviderName });

  let purchased: any = null;
  let providerClient: NumberProvider = fallbackNumberProvider;
  try {
    providerClient = await getNumberProviderClient(admin.tenantId, input.provider as ProviderName);
    purchased = await providerClient.purchaseNumber({ phoneNumber: input.phoneNumber });

    const created = await db.phoneNumber.create({
      data: {
        tenantId: admin.tenantId,
        provider: input.provider,
        phoneNumber: purchased.phoneNumber,
        providerId: purchased.providerId,
        capabilities: purchased.capabilities as any,
        monthlyCostCents: purchased.monthlyCostCents || null,
        areaCode: purchased.phoneNumber.slice(2, 5),
        status: "ACTIVE"
      }
    });

    if (input.makeDefaultSms) {
      await db.tenant.update({ where: { id: admin.tenantId }, data: { defaultSmsFromNumberId: created.id } });
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_DEFAULT_SET", entityType: "PhoneNumber", entityId: created.id, provider: input.provider as ProviderName });
    }

    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_PURCHASED", entityType: "PhoneNumber", entityId: created.id, provider: input.provider as ProviderName });
    return { number: created };
  } catch (e: any) {
    if (purchased?.providerId) {
      try {
        await providerClient.releaseNumber({ providerId: purchased.providerId, phoneNumber: purchased.phoneNumber });
      } catch {
        await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_RELEASE_REQUESTED", entityType: "PhoneNumber", entityId: purchased.providerId, provider: input.provider as ProviderName });
      }
    }
    return reply.status(400).send({ error: "NUMBER_PURCHASE_FAILED", message: "Unable to purchase number." });
  }
});

app.post("/numbers/:id/set-default-sms", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const { id } = req.params as { id: string };
  const number = await db.phoneNumber.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!number) return reply.status(404).send({ error: "number_not_found" });
  if (number.status !== "ACTIVE") return reply.status(400).send({ error: "number_not_active" });

  await db.tenant.update({ where: { id: admin.tenantId }, data: { defaultSmsFromNumberId: number.id } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_DEFAULT_SET", entityType: "PhoneNumber", entityId: number.id, provider: number.provider as ProviderName });
  return { ok: true };
});

app.post("/numbers/:id/release", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const { id } = req.params as { id: string };
  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  const number = await db.phoneNumber.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!tenant || !number) return reply.status(404).send({ error: "number_not_found" });
  if (tenant.defaultSmsFromNumberId === number.id) {
    return reply.status(400).send({ error: "CANNOT_RELEASE_DEFAULT_NUMBER", message: "Set a different default number before releasing this one." });
  }

  await db.phoneNumber.update({ where: { id: number.id }, data: { status: "RELEASING" } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_RELEASE_REQUESTED", entityType: "PhoneNumber", entityId: number.id, provider: number.provider as ProviderName });

  try {
    const provider = await getNumberProviderClient(admin.tenantId, number.provider as ProviderName);
    await provider.releaseNumber({ providerId: number.providerId || undefined, phoneNumber: number.phoneNumber });
    const updated = await db.phoneNumber.update({ where: { id: number.id }, data: { status: "RELEASED", releasedAt: new Date() } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "NUMBER_RELEASED", entityType: "PhoneNumber", entityId: number.id, provider: number.provider as ProviderName });
    return { number: updated };
  } catch {
    return reply.status(400).send({ error: "NUMBER_RELEASE_FAILED", message: "Unable to release number with provider." });
  }
});

app.get("/admin/numbers", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const query = z.object({ provider: z.enum(["TWILIO", "VOIPMS"]).optional(), status: z.enum(["ACTIVE", "RELEASING", "RELEASED", "SUSPENDED"]).optional(), tenantId: z.string().optional() }).parse(req.query || {});
  const rows = await db.phoneNumber.findMany({
    where: {
      provider: query.provider,
      status: query.status,
      tenantId: query.tenantId
    },
    orderBy: { createdAt: "desc" },
    include: { tenant: true }
  });
  return rows.map((r) => ({ ...r, tenantName: r.tenant.name, isOrphaned: !r.providerId && r.status === "ACTIVE" }));
});

app.post("/admin/tenants/:id/number-purchase-enabled", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const { id } = req.params as { id: string };
  const input = z.object({ enabled: z.boolean() }).parse(req.body);
  const updated = await db.tenant.update({ where: { id }, data: { numberPurchaseEnabled: input.enabled } });
  await audit({ tenantId: updated.id, actorUserId: admin.sub, action: "NUMBER_ASSIGNMENT_UPDATED", entityType: "Tenant", entityId: updated.id });
  return { tenantId: updated.id, numberPurchaseEnabled: updated.numberPurchaseEnabled };
});

app.post("/settings/providers/twilio/test-send", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  if (!checkAndConsumeTestSendQuota(admin.tenantId)) return reply.status(429).send({ error: "TEST_SEND_RATE_LIMITED", message: "Test SMS limit reached (5 per hour)." });

  const input = z.object({ to: z.string().min(8), message: z.string().min(1).max(160) }).parse(req.body);
  const twilioCred = await getTenantTwilioCredentials(admin.tenantId);
  if (!twilioCred) {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "TWILIO_TEST_SEND_FAILED", entityType: "ProviderCredential", entityId: "tenant", provider: "TWILIO" });
    return reply.status(400).send({ error: "TWILIO_TEST_SEND_FAILED", message: "Twilio provider must be enabled with valid credentials." });
  }

  const sent = await sendTwilioTestMessage(twilioCred.creds, input.to, input.message);
  if (!sent.ok) {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "TWILIO_TEST_SEND_FAILED", entityType: "ProviderCredential", entityId: twilioCred.recordId, provider: "TWILIO" });
    return reply.status(400).send({ error: "TWILIO_TEST_SEND_FAILED", message: sent.message });
  }

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "TWILIO_TEST_SEND_SUCCESS", entityType: "ProviderCredential", entityId: twilioCred.recordId, provider: "TWILIO" });
  return { success: true, providerMessageId: sent.providerMessageId };
});

app.get("/settings/sms-mode", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const latestStatus = await latestTenDlcStatus(admin.tenantId);
  return { smsSendMode: tenant.smsSendMode, smsLiveEnabledAt: tenant.smsLiveEnabledAt, tenDlcApproved: latestStatus === "APPROVED", tenDlcStatus: latestStatus };
});

app.post("/settings/sms-mode", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ mode: z.enum(["TEST", "LIVE"]) }).parse(req.body);
  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  if (input.mode === "LIVE") {
    const tenDlcStatus = await latestTenDlcStatus(admin.tenantId);
    const isSuperAdmin = admin.role === "SUPER_ADMIN";
    if (tenDlcStatus !== "APPROVED" && !isSuperAdmin) {
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_SEND_MODE_CHANGE_REJECTED", entityType: "Tenant", entityId: admin.tenantId, provider: "TWILIO" });
      return reply.status(400).send({ error: "10DLC_NOT_APPROVED", message: "10DLC approval is required before enabling LIVE SMS sending." });
    }

    const primaryReady = await providerIsReady(admin.tenantId, tenant.smsPrimaryProvider as ProviderName);
    if (!primaryReady) {
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_SEND_MODE_CHANGE_REJECTED", entityType: "Tenant", entityId: admin.tenantId, provider: tenant.smsPrimaryProvider as ProviderName });
      return reply.status(400).send({ error: "LIVE_MODE_REQUIRES_ENABLED_PROVIDER", message: "Enable and validate the primary SMS provider before LIVE mode." });
    }

    const updated = await db.tenant.update({ where: { id: admin.tenantId }, data: { smsSendMode: "LIVE", smsLiveEnabledAt: new Date(), smsLiveEnabledByUserId: admin.sub } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_SEND_MODE_CHANGED", entityType: "Tenant", entityId: admin.tenantId, provider: tenant.smsPrimaryProvider as ProviderName });
    return { smsSendMode: updated.smsSendMode, smsLiveEnabledAt: updated.smsLiveEnabledAt };
  }

  const updated = await db.tenant.update({ where: { id: admin.tenantId }, data: { smsSendMode: "TEST" } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_SEND_MODE_CHANGED", entityType: "Tenant", entityId: admin.tenantId });
  return { smsSendMode: updated.smsSendMode, smsLiveEnabledAt: updated.smsLiveEnabledAt };
});

app.post("/ten-dlc/submit", async (req) => {
  const user = getUser(req);
  const input = tenDlcSubmissionSchema.parse(req.body);

  const created = await db.tenDlcSubmission.create({
    data: {
      tenantId: user.tenantId,
      legalName: input.legalName,
      dba: input.dba || null,
      einEncrypted: encodeEin(input.ein),
      businessType: input.businessType,
      websiteUrl: input.websiteUrl,
      addressStreet: input.businessAddress.street,
      addressCity: input.businessAddress.city,
      addressState: input.businessAddress.state,
      addressPostalCode: input.businessAddress.zip,
      addressCountry: input.businessAddress.country,
      supportEmail: input.supportEmail,
      supportPhone: input.supportPhone,
      useCaseCategory: input.useCaseCategory,
      sampleMessage1: input.messageSamples[0],
      sampleMessage2: input.messageSamples[1],
      sampleMessage3: input.messageSamples[2],
      optInMethod: input.optInMethod,
      optInWorkflow: input.optInWorkflowDescription,
      optInProofUrl: input.optInProofUrl || null,
      messagesPerDay: input.volumeEstimate.messagesPerDay,
      messagesPerMonth: input.volumeEstimate.messagesPerMonth,
      includesEmbeddedLinks: input.includesEmbeddedLinks,
      includesPhoneNumbers: input.includesEmbeddedPhoneNumbers,
      includesAffiliateMktg: input.includesAffiliateMarketing,
      ageGatedContent: input.ageGatedContent,
      termsAccepted: input.termsAccepted,
      signatureName: input.signatureName,
      signatureDate: new Date(input.signatureDate),
      status: "SUBMITTED",
      submittedAt: new Date()
    }
  });

  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "TEN_DLC_SUBMIT", entityType: "TenDlcSubmission", entityId: created.id });
  return created;
});

app.get("/ten-dlc/status", async (req) => {
  const user = getUser(req);
  return db.tenDlcSubmission.findFirst({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
});

app.get("/admin/ten-dlc/submissions", async (req, reply) => {
  const user = await requireAdmin(req, reply);
  if (!user) return;
  const query = z.object({ status: z.enum(["DRAFT", "SUBMITTED", "NEEDS_INFO", "APPROVED", "REJECTED"]).optional() }).parse(req.query || {});
  return db.tenDlcSubmission.findMany({ where: query.status ? { status: query.status } : undefined, orderBy: { createdAt: "desc" } });
});

app.get("/admin/ten-dlc/submissions/:id", async (req, reply) => {
  const user = await requireAdmin(req, reply);
  if (!user) return;
  const { id } = req.params as { id: string };
  return db.tenDlcSubmission.findUnique({ where: { id } });
});

app.post("/admin/ten-dlc/submissions/:id/status", async (req, reply) => {
  const user = await requireAdmin(req, reply);
  if (!user) return;
  const { id } = req.params as { id: string };
  const input = z.object({ status: z.enum(["NEEDS_INFO", "APPROVED", "REJECTED"]), note: z.string().min(2) }).parse(req.body);
  const updated = await db.tenDlcSubmission.update({ where: { id }, data: { status: input.status, internalNotes: input.note, reviewedAt: new Date() } });
  await audit({ tenantId: updated.tenantId, actorUserId: user.sub, action: `TEN_DLC_STATUS_${input.status}`, entityType: "TenDlcSubmission", entityId: id });
  return updated;
});

app.get("/admin/tenants", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const tenants = await db.tenant.findMany({ orderBy: { createdAt: "desc" } });
  const rows = await Promise.all(tenants.map(async (t) => {
    const userCount = await db.user.count({ where: { tenantId: t.id } });
    const campaignCount = await db.smsCampaign.count({ where: { tenantId: t.id } });
    return { id: t.id, name: t.name, isApproved: t.isApproved, dailySmsCap: t.dailySmsCap, perSecondRate: t.perSecondRate, firstCampaignRequiresApproval: t.firstCampaignRequiresApproval, stats: { users: userCount, campaigns: campaignCount } };
  }));

  return rows;
});

app.patch("/admin/tenants/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ isApproved: z.boolean().optional(), dailySmsCap: z.number().int().positive().optional(), perSecondRate: z.number().positive().optional(), firstCampaignRequiresApproval: z.boolean().optional() }).parse(req.body);
  const updated = await db.tenant.update({ where: { id }, data: input });
  await audit({ tenantId: updated.id, actorUserId: admin.sub, action: "TENANT_GUARDRAILS_UPDATED", entityType: "Tenant", entityId: updated.id });
  return updated;
});

app.get("/admin/sms/provider-health", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const since = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db.providerHealth.findMany({ where: { windowStart: { gte: since } }, include: { tenant: true }, orderBy: { updatedAt: "desc" } });

  const byTenant: Record<string, { tenantId: string; tenantName: string; sent: number; failed: number; openCircuits: number; providers: Record<string, { sent: number; failed: number }> }> = {};
  for (const r of rows) {
    const key = r.tenantId;
    if (!byTenant[key]) byTenant[key] = { tenantId: r.tenantId, tenantName: r.tenant.name, sent: 0, failed: 0, openCircuits: 0, providers: {} };
    byTenant[key].sent += r.sentCount;
    byTenant[key].failed += r.failCount;
    if (r.circuitOpenUntil && r.circuitOpenUntil > new Date()) byTenant[key].openCircuits += 1;
    if (!byTenant[key].providers[r.provider]) byTenant[key].providers[r.provider] = { sent: 0, failed: 0 };
    byTenant[key].providers[r.provider].sent += r.sentCount;
    byTenant[key].providers[r.provider].failed += r.failCount;
  }

  const failoversRecent = await db.auditLog.count({ where: { action: "SMS_PROVIDER_FAILOVER_USED", createdAt: { gte: since } } });
  const tenantRows = Object.values(byTenant).sort((a, b) => b.failed - a.failed);
  const topFailingTenants = tenantRows.slice(0, 10);
  const circuitsOpen = tenantRows.filter((t) => t.openCircuits > 0);

  const providerDistribution = {
    TWILIO: rows.reduce((acc, r) => acc + (r.provider === "TWILIO" ? r.sentCount : 0), 0),
    VOIPMS: rows.reduce((acc, r) => acc + (r.provider === "VOIPMS" ? r.sentCount : 0), 0)
  };

  const recentLocks = await db.auditLog.findMany({ where: { action: "SMS_PROVIDER_LOCKED", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20 });
  return { topFailingTenants, circuitsOpen, providerDistribution, recentLocks, failoversRecent };
});

app.post("/sms/campaigns", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    name: z.string().min(2),
    fromNumber: z.string().min(7).optional(),
    fromNumberId: z.string().optional(),
    message: z.string().min(3).max(320),
    audienceType: z.string().default("manual"),
    recipients: z.array(z.string().min(8)).min(1)
  }).parse(req.body);

  const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  let selectedNumber = null as any;
  if (input.fromNumberId) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { id: input.fromNumberId, tenantId: user.tenantId } });
  } else if (input.fromNumber) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { phoneNumber: input.fromNumber, tenantId: user.tenantId } });
  } else if (tenant.defaultSmsFromNumberId) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { id: tenant.defaultSmsFromNumberId, tenantId: user.tenantId } });
  }

  if (tenant.smsSendMode === "LIVE") {
    if (!selectedNumber) return reply.status(400).send({ error: "NO_SENDER_NUMBER", message: "You must purchase/assign a sending number before sending in LIVE mode." });
    if (selectedNumber.status !== "ACTIVE") return reply.status(400).send({ error: "SENDER_NUMBER_NOT_ACTIVE" });
  }

  const effectiveFrom = selectedNumber?.phoneNumber || input.fromNumber || "+15550000000";

  const allowedProviders: string[] = [];
  if (tenant.smsProviderLock) {
    allowedProviders.push(tenant.smsProviderLock);
  } else if (tenant.smsRoutingMode === "SINGLE_PRIMARY") {
    allowedProviders.push(tenant.smsPrimaryProvider);
  } else {
    allowedProviders.push(tenant.smsPrimaryProvider);
    if (tenant.smsSecondaryProvider) allowedProviders.push(tenant.smsSecondaryProvider);
  }

  let forcedNeedsApproval = false;
  if (tenant.smsSendMode === "LIVE" && selectedNumber && !allowedProviders.includes(selectedNumber.provider)) {
    forcedNeedsApproval = true;
  }

  const decision = await decideCampaignPolicy({ tenant, tenantId: user.tenantId, actorUserId: user.sub, message: input.message, recipientsCount: input.recipients.length });
  if ("reject" in decision) return reply.status(400).send({ error: decision.reject });

  const campaignStatus = forcedNeedsApproval ? "NEEDS_APPROVAL" : decision.status;
  const holdReason = forcedNeedsApproval ? "SENDER_PROVIDER_MISMATCH" : decision.holdReason;

  const campaign = await db.smsCampaign.create({
    data: {
      tenantId: user.tenantId,
      name: input.name,
      message: decision.normalizedMessage,
      fromNumber: effectiveFrom,
      audienceType: input.audienceType,
      status: campaignStatus,
      requiresApproval: campaignStatus === "NEEDS_APPROVAL",
      holdReason,
      riskScore: decision.riskScore
    }
  });

  const createdMessages = await Promise.all(
    input.recipients.map((to) => db.smsMessage.create({ data: { campaignId: campaign.id, toNumber: to, fromNumber: effectiveFrom, fromNumberId: selectedNumber?.id || null, body: decision.normalizedMessage, status: "QUEUED" } }))
  );

  if (campaign.status === "QUEUED") {
    await enqueueCampaignMessages(campaign.id, user.tenantId);
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_QUEUED", entityType: "SmsCampaign", entityId: campaign.id });
  } else {
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_HELD_FOR_APPROVAL", entityType: "SmsCampaign", entityId: campaign.id });
  }

  return { campaign, queuedMessages: campaign.status === "QUEUED" ? createdMessages.length : 0, holdReason: campaign.holdReason };
});

app.get("/sms/campaigns", async (req) => {
  const user = getUser(req);
  return db.smsCampaign.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
});

app.get("/sms/campaigns/:id", async (req) => {
  const user = getUser(req);
  const { id } = req.params as { id: string };
  return db.smsCampaign.findFirst({ where: { id, tenantId: user.tenantId }, include: { messages: true } });
});

app.get("/sms/messages", async (req) => {
  const user = getUser(req);
  const query = z.object({ campaignId: z.string().optional() }).parse(req.query || {});
  return db.smsMessage.findMany({ where: query.campaignId ? { campaignId: query.campaignId, campaign: { tenantId: user.tenantId } } : { campaign: { tenantId: user.tenantId } }, orderBy: { createdAt: "desc" } });
});

app.get("/admin/sms/campaigns", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const query = z.object({ status: z.enum(["NEEDS_APPROVAL", "QUEUED", "SENDING", "SENT", "FAILED", "PAUSED", "DRAFT"]).optional() }).parse(req.query || {});
  return db.smsCampaign.findMany({ where: query.status ? { status: query.status } : undefined, orderBy: { createdAt: "desc" } });
});

app.post("/admin/sms/campaigns/:id/approve", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const campaign = await db.smsCampaign.findUnique({ where: { id } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const updated = await db.smsCampaign.update({ where: { id }, data: { status: "QUEUED", requiresApproval: false, approvedAt: new Date(), approvedByUserId: admin.sub, holdReason: null } });
  await enqueueCampaignMessages(id, campaign.tenantId);
  await audit({ tenantId: campaign.tenantId, actorUserId: admin.sub, action: "SMS_CAMPAIGN_APPROVED", entityType: "SmsCampaign", entityId: id });
  return updated;
});

app.post("/admin/sms/campaigns/:id/reject", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ reason: z.string().min(2) }).parse(req.body);
  const campaign = await db.smsCampaign.findUnique({ where: { id } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const updated = await db.smsCampaign.update({ where: { id }, data: { status: "FAILED", requiresApproval: false, approvedByUserId: admin.sub, approvedAt: new Date(), holdReason: input.reason } });
  await db.smsMessage.updateMany({ where: { campaignId: id, status: { in: ["QUEUED", "SENDING"] } }, data: { status: "FAILED", error: `Rejected: ${input.reason}` } });
  await audit({ tenantId: campaign.tenantId, actorUserId: admin.sub, action: "SMS_CAMPAIGN_REJECTED", entityType: "SmsCampaign", entityId: id });
  return updated;
});

app.post("/webhooks/twilio/sms-status", async (req, reply) => {
  if (!ensureCredentialCrypto(reply)) return;

  const signature = String(req.headers["x-twilio-signature"] || "");
  if (!signature) return reply.status(400).send({ error: "missing_twilio_signature" });

  const body = (req.body || {}) as Record<string, string>;
  const sid = String(body.MessageSid || "");
  const statusRaw = String(body.MessageStatus || "").toLowerCase();
  const host = String(req.headers.host || "app.connectcomunications.com");
  const proto = String(req.headers["x-forwarded-proto"] || "https");
  const url = `${proto}://${host}/webhooks/twilio/sms-status`;

  const message = sid ? await db.smsMessage.findFirst({ where: { providerMessageId: sid }, include: { campaign: { include: { tenant: true } } } }) : null;

  if (!message) {
    await db.smsWebhookEvent.create({ data: { tenantId: null, provider: "TWILIO", messageId: null, providerMessageId: sid || "unknown", eventType: statusRaw || "unmatched", payload: body as any } });
    return { ok: true };
  }

  const twilioCred = await getTenantTwilioCredentials(message.campaign.tenantId);
  if (!twilioCred) {
    await db.smsWebhookEvent.create({ data: { tenantId: message.campaign.tenantId, provider: "TWILIO", messageId: message.id, providerMessageId: sid || "unknown", eventType: "missing_or_invalid_tenant_credentials", payload: body as any } });
    return reply.status(403).send({ error: "invalid_signature" });
  }

  const isValid = validateTwilioRequest(twilioCred.creds.authToken, signature, url, body);
  if (!isValid) {
    await db.smsWebhookEvent.create({ data: { tenantId: message.campaign.tenantId, provider: "TWILIO", messageId: message.id, providerMessageId: sid || "unknown", eventType: "invalid_signature", payload: body as any } });
    return reply.status(403).send({ error: "invalid_signature" });
  }

  let mapped: "QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "FAILED" = "SENT";
  if (statusRaw === "delivered") mapped = "DELIVERED";
  else if (statusRaw === "failed" || statusRaw === "undelivered") mapped = "FAILED";
  else if (statusRaw === "queued") mapped = "QUEUED";
  else if (statusRaw === "accepted") mapped = "SENDING";

  const now = new Date();
  await db.smsMessage.update({ where: { id: message.id }, data: { status: mapped, providerStatus: statusRaw || null, lastProviderUpdateAt: now, deliveryUpdatedAt: mapped === "DELIVERED" || mapped === "FAILED" ? now : null } });
  await db.smsWebhookEvent.create({ data: { tenantId: message.campaign.tenantId, provider: "TWILIO", messageId: message.id, providerMessageId: sid || "unknown", eventType: statusRaw || "unknown", payload: body as any } });
  await audit({ tenantId: message.campaign.tenantId, action: "SMS_WEBHOOK_STATUS_UPDATED", entityType: "SmsMessage", entityId: message.id, provider: "TWILIO" });

  return { ok: true };
});

const port = Number(process.env.PORT || 3001);
app.listen({ host: "0.0.0.0", port }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
