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
  sendTwilioTestMessage,
  validateTwilioCredentials,
  validateTwilioRequest
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
const numberProvider = new FakeNumberProvider();

app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
app.register(jwt, { secret: process.env.JWT_SECRET || "change-me" });

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });
const canUseCredentialCrypto = hasCredentialsMasterKey();
if (!canUseCredentialCrypto) {
  app.log.warn("Provider credential endpoints disabled: CREDENTIALS_MASTER_KEY missing or invalid");
}

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

type TwilioCredentialPayload = {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  fromNumber?: string;
  label?: string;
};

type CampaignDecision = {
  status: "QUEUED" | "NEEDS_APPROVAL";
  requiresApproval: boolean;
  holdReason: string | null;
  riskScore: number;
  normalizedMessage: string;
};

const twilioCredCache = new Map<string, { recordId: string; creds: TwilioCredentialPayload; expiresAt: number }>();
const twilioCredCacheTtlMs = 60_000;
const testSendLimiter = new Map<string, number[]>();

function encodeEin(rawEin: string): string {
  return Buffer.from(rawEin, "utf8").toString("base64");
}

function maskValue(value: string | undefined | null, start = 6, end = 4): string | null {
  if (!value) return null;
  if (value.length <= start + end) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, start)}${"*".repeat(value.length - start - end)}${value.slice(-end)}`;
}

async function audit(params: {
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId?: string;
  provider?: "TWILIO" | "VOIPMS";
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

function ensureCredentialCrypto(reply: any): boolean {
  if (canUseCredentialCrypto) return true;
  reply.status(503).send({ error: "provider_settings_unavailable", message: "Provider settings are unavailable until credential encryption is configured." });
  return false;
}

async function getTenantTwilioCredentials(tenantId: string): Promise<{ recordId: string; creds: TwilioCredentialPayload } | null> {
  const cached = twilioCredCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return { recordId: cached.recordId, creds: cached.creds };
  }

  const record = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId, provider: "TWILIO" } } });
  if (!record || !record.isEnabled) return null;

  try {
    const creds = decryptJson<TwilioCredentialPayload>(record.credentialsEncrypted);
    if (!creds.accountSid || !creds.authToken || (!creds.messagingServiceSid && !creds.fromNumber)) {
      return null;
    }
    twilioCredCache.set(tenantId, { recordId: record.id, creds, expiresAt: Date.now() + twilioCredCacheTtlMs });
    return { recordId: record.id, creds };
  } catch {
    return null;
  }
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
  return db.smsMessage.count({
    where: {
      campaign: { tenantId },
      status: { in: ["QUEUED", "SENDING", "SENT"] },
      createdAt: { gte: start }
    }
  });
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

function sanitizeLimitInput(input: {
  dailySmsLimit: number;
  hourlySmsLimit: number;
  perSecondRateLimit: number;
  maxCampaignSize: number;
}): {
  dailySmsLimit: number;
  hourlySmsLimit: number;
  perSecondRateLimit: number;
  maxCampaignSize: number;
} {
  return {
    dailySmsLimit: Math.min(MAX_DAILY_LIMIT, Math.max(1, input.dailySmsLimit)),
    hourlySmsLimit: Math.min(MAX_HOURLY_LIMIT, Math.max(1, input.hourlySmsLimit)),
    perSecondRateLimit: Math.min(MAX_PER_SECOND, Math.max(1, input.perSecondRateLimit)),
    maxCampaignSize: Math.max(1, input.maxCampaignSize)
  };
}

async function decideCampaignPolicy(params: {
  tenant: any;
  tenantId: string;
  actorUserId: string;
  message: string;
  recipientsCount: number;
}): Promise<CampaignDecision | { reject: string }> {
  const { tenant, tenantId, actorUserId, message, recipientsCount } = params;

  if (recipientsCount > tenant.maxCampaignSize) {
    await audit({ tenantId, actorUserId, action: "SMS_CAMPAIGN_REJECTED_MAX_SIZE", entityType: "Tenant", entityId: tenantId });
    return { reject: `Campaign exceeds maxCampaignSize (${tenant.maxCampaignSize})` };
  }

  const normalized = normalizeSmsWithStop(message);
  if (!normalized.ok) {
    await audit({ tenantId, actorUserId, action: "SMS_ENFORCE_STOP_APPEND_TOO_LONG", entityType: "Tenant", entityId: tenantId });
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: "STOP instruction required but message would exceed 160 characters. Manual review required.",
      riskScore: 45,
      normalizedMessage: message
    };
  }

  if (normalized.appendedStop) {
    await audit({ tenantId, actorUserId, action: "SMS_STOP_INSTRUCTION_APPENDED", entityType: "Tenant", entityId: tenantId });
  }

  const usage = await dailyUsageCount(tenantId);
  if (usage + recipientsCount > tenant.dailySmsCap) {
    await audit({ tenantId, actorUserId, action: "SMS_DAILY_CAP_REJECTED", entityType: "Tenant", entityId: tenantId });
    return { reject: `Daily SMS cap exceeded: cap=${tenant.dailySmsCap}, current=${usage}, requested=${recipientsCount}` };
  }

  const risk = assessSmsRisk(normalized.message);
  if (risk.riskScore >= 70) {
    await audit({ tenantId, actorUserId, action: "SMS_RISK_REQUIRES_APPROVAL", entityType: "Tenant", entityId: tenantId });
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: `Risk score ${risk.riskScore}: ${risk.reasons.join(", ")}`,
      riskScore: risk.riskScore,
      normalizedMessage: normalized.message
    };
  }

  if (!tenant.isApproved) {
    await audit({ tenantId, actorUserId, action: "SMS_TENANT_NOT_APPROVED", entityType: "Tenant", entityId: tenantId });
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: "Tenant is not approved for outbound messaging.",
      riskScore: risk.riskScore,
      normalizedMessage: normalized.message
    };
  }

  const sentCampaignCount = await db.smsCampaign.count({ where: { tenantId, status: "SENT" } });
  if (tenant.firstCampaignRequiresApproval && sentCampaignCount === 0) {
    await audit({ tenantId, actorUserId, action: "SMS_FIRST_CAMPAIGN_APPROVAL_REQUIRED", entityType: "Tenant", entityId: tenantId });
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: "First campaign requires admin approval.",
      riskScore: risk.riskScore,
      normalizedMessage: normalized.message
    };
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
      smsSuspended: false
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
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    return reply.status(401).send({ error: "invalid_credentials" });
  }
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
    limits: {
      dailySmsLimit: tenant.dailySmsLimit,
      hourlySmsLimit: tenant.hourlySmsLimit,
      perSecondRateLimit: tenant.perSecondRateLimit,
      maxCampaignSize: tenant.maxCampaignSize
    },
    usage,
    suspension: {
      smsSuspended: tenant.smsSuspended,
      smsSuspendedReason: tenant.smsSuspendedReason,
      smsSuspendedAt: tenant.smsSuspendedAt
    }
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
    if (
      desired.dailySmsLimit > DEFAULT_DAILY_LIMIT ||
      desired.hourlySmsLimit > DEFAULT_HOURLY_LIMIT ||
      desired.perSecondRateLimit > DEFAULT_PER_SECOND ||
      desired.maxCampaignSize > DEFAULT_MAX_CAMPAIGN
    ) {
      return reply.status(403).send({ error: "LIMIT_INCREASE_NOT_ALLOWED", message: "ADMIN cannot raise limits beyond default system baselines." });
    }
  }

  if (
    desired.dailySmsLimit > MAX_DAILY_LIMIT ||
    desired.hourlySmsLimit > MAX_HOURLY_LIMIT ||
    desired.perSecondRateLimit > MAX_PER_SECOND
  ) {
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
    await audit({
      tenantId: admin.tenantId,
      actorUserId: admin.sub,
      action: input.smsSuspended ? "SMS_TENANT_SUSPENDED" : "SMS_TENANT_UNSUSPENDED",
      entityType: "Tenant",
      entityId: admin.tenantId
    });
  }

  return {
    limits: {
      dailySmsLimit: updated.dailySmsLimit,
      hourlySmsLimit: updated.hourlySmsLimit,
      perSecondRateLimit: updated.perSecondRateLimit,
      maxCampaignSize: updated.maxCampaignSize
    },
    suspension: {
      smsSuspended: updated.smsSuspended,
      smsSuspendedReason: updated.smsSuspendedReason,
      smsSuspendedAt: updated.smsSuspendedAt
    }
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
        const decrypted = decryptJson<TwilioCredentialPayload>(row.credentialsEncrypted);
        preview = {
          accountSid: maskValue(decrypted.accountSid),
          authToken: decrypted.authToken ? "********" : null,
          messagingServiceSid: maskValue(decrypted.messagingServiceSid),
          fromNumber: maskValue(decrypted.fromNumber, 2, 2)
        };
      }
    } catch {
      preview = { accountSid: null, authToken: "********", messagingServiceSid: null, fromNumber: null };
    }

    return { provider: row.provider, isEnabled: row.isEnabled, label: row.label, updatedAt: row.updatedAt, preview };
  });
});

app.put("/settings/providers/twilio", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = twilioSettingsSchema.parse(req.body);
  const payload: TwilioCredentialPayload = {
    accountSid: input.accountSid,
    authToken: input.authToken,
    messagingServiceSid: input.messagingServiceSid || undefined,
    fromNumber: input.fromNumber || undefined,
    label: input.label || undefined
  };

  const encrypted = encryptJson(payload);
  const existing = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: "TWILIO" } } });

  const updated = await db.providerCredential.upsert({
    where: { tenantId_provider: { tenantId: admin.tenantId, provider: "TWILIO" } },
    create: {
      tenantId: admin.tenantId,
      provider: "TWILIO",
      label: payload.label || "Primary Twilio",
      isEnabled: false,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      createdByUserId: admin.sub,
      updatedByUserId: admin.sub
    },
    update: {
      label: payload.label || existing?.label || "Primary Twilio",
      isEnabled: false,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      updatedByUserId: admin.sub
    }
  });

  twilioCredCache.delete(admin.tenantId);
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: existing ? "PROVIDER_CREDENTIAL_UPDATED" : "PROVIDER_CREDENTIAL_CREATED", entityType: "ProviderCredential", entityId: updated.id, provider: "TWILIO" });

  return {
    provider: "TWILIO",
    label: updated.label,
    isEnabled: updated.isEnabled,
    updatedAt: updated.updatedAt,
    preview: {
      accountSid: maskValue(payload.accountSid),
      authToken: "********",
      messagingServiceSid: maskValue(payload.messagingServiceSid),
      fromNumber: maskValue(payload.fromNumber, 2, 2)
    }
  };
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
  twilioCredCache.delete(admin.tenantId);
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
  twilioCredCache.delete(admin.tenantId);
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PROVIDER_CREDENTIAL_DISABLED", entityType: "ProviderCredential", entityId: updated.id, provider: "TWILIO" });
  return { provider: "TWILIO", isEnabled: false, updatedAt: updated.updatedAt };
});

app.post("/settings/providers/twilio/test-send", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  if (!checkAndConsumeTestSendQuota(admin.tenantId)) {
    return reply.status(429).send({ error: "TEST_SEND_RATE_LIMITED", message: "Test SMS limit reached (5 per hour)." });
  }

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
  return {
    smsSendMode: tenant.smsSendMode,
    smsLiveEnabledAt: tenant.smsLiveEnabledAt,
    tenDlcApproved: latestStatus === "APPROVED",
    tenDlcStatus: latestStatus
  };
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

    const twilioCred = await getTenantTwilioCredentials(admin.tenantId);
    if (!twilioCred) {
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_SEND_MODE_CHANGE_REJECTED", entityType: "Tenant", entityId: admin.tenantId, provider: "TWILIO" });
      return reply.status(400).send({ error: "LIVE_MODE_REQUIRES_ENABLED_TWILIO", message: "Enable validated Twilio credentials before LIVE mode." });
    }

    const updated = await db.tenant.update({ where: { id: admin.tenantId }, data: { smsSendMode: "LIVE", smsLiveEnabledAt: new Date(), smsLiveEnabledByUserId: admin.sub } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_SEND_MODE_CHANGED", entityType: "Tenant", entityId: admin.tenantId, provider: "TWILIO" });
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
  const rows = await Promise.all(
    tenants.map(async (t) => {
      const userCount = await db.user.count({ where: { tenantId: t.id } });
      const campaignCount = await db.smsCampaign.count({ where: { tenantId: t.id } });
      return {
        id: t.id,
        name: t.name,
        isApproved: t.isApproved,
        dailySmsCap: t.dailySmsCap,
        perSecondRate: t.perSecondRate,
        firstCampaignRequiresApproval: t.firstCampaignRequiresApproval,
        stats: { users: userCount, campaigns: campaignCount }
      };
    })
  );

  return rows;
});

app.patch("/admin/tenants/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    isApproved: z.boolean().optional(),
    dailySmsCap: z.number().int().positive().optional(),
    perSecondRate: z.number().positive().optional(),
    firstCampaignRequiresApproval: z.boolean().optional()
  }).parse(req.body);

  const updated = await db.tenant.update({ where: { id }, data: input });
  await audit({ tenantId: updated.id, actorUserId: admin.sub, action: "TENANT_GUARDRAILS_UPDATED", entityType: "Tenant", entityId: updated.id });
  return updated;
});

app.post("/sms/campaigns", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    name: z.string().min(2),
    fromNumber: z.string().min(7),
    message: z.string().min(3).max(320),
    audienceType: z.string().default("manual"),
    recipients: z.array(z.string().min(8)).min(1)
  }).parse(req.body);

  const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const decision = await decideCampaignPolicy({ tenant, tenantId: user.tenantId, actorUserId: user.sub, message: input.message, recipientsCount: input.recipients.length });
  if ("reject" in decision) return reply.status(400).send({ error: decision.reject });

  const campaign = await db.smsCampaign.create({
    data: {
      tenantId: user.tenantId,
      name: input.name,
      message: decision.normalizedMessage,
      fromNumber: input.fromNumber,
      audienceType: input.audienceType,
      status: decision.status,
      requiresApproval: decision.requiresApproval,
      holdReason: decision.holdReason,
      riskScore: decision.riskScore
    }
  });

  const createdMessages = await Promise.all(
    input.recipients.map((to) => db.smsMessage.create({ data: { campaignId: campaign.id, toNumber: to, fromNumber: input.fromNumber, body: decision.normalizedMessage, status: "QUEUED" } }))
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
  return db.smsMessage.findMany({
    where: query.campaignId ? { campaignId: query.campaignId, campaign: { tenantId: user.tenantId } } : { campaign: { tenantId: user.tenantId } },
    orderBy: { createdAt: "desc" }
  });
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
  const campaign = await db.smsCampaign.findUnique({ where: { id }, include: { messages: true } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const updated = await db.smsCampaign.update({
    where: { id },
    data: { status: "QUEUED", requiresApproval: false, approvedAt: new Date(), approvedByUserId: admin.sub, holdReason: null }
  });

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

  const updated = await db.smsCampaign.update({
    where: { id },
    data: { status: "FAILED", requiresApproval: false, approvedByUserId: admin.sub, approvedAt: new Date(), holdReason: input.reason }
  });

  await db.smsMessage.updateMany({ where: { campaignId: id, status: { in: ["QUEUED", "SENDING"] } }, data: { status: "FAILED", error: `Rejected: ${input.reason}` } });
  await audit({ tenantId: campaign.tenantId, actorUserId: admin.sub, action: "SMS_CAMPAIGN_REJECTED", entityType: "SmsCampaign", entityId: id });
  return updated;
});

app.post("/webhooks/twilio/sms-status", async (req, reply) => {
  if (!ensureCredentialCrypto(reply)) return;

  const signature = String(req.headers["x-twilio-signature"] || "");
  if (!signature) {
    return reply.status(400).send({ error: "missing_twilio_signature" });
  }

  const body = (req.body || {}) as Record<string, string>;
  const sid = String(body.MessageSid || "");
  const statusRaw = String(body.MessageStatus || "").toLowerCase();
  const host = String(req.headers.host || "app.connectcomunications.com");
  const proto = String(req.headers["x-forwarded-proto"] || "https");
  const url = `${proto}://${host}/webhooks/twilio/sms-status`;

  const message = sid
    ? await db.smsMessage.findFirst({ where: { providerMessageId: sid }, include: { campaign: { include: { tenant: true } } } })
    : null;

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
  else if (statusRaw === "sent") mapped = "SENT";

  const now = new Date();
  await db.smsMessage.update({
    where: { id: message.id },
    data: {
      status: mapped,
      providerStatus: statusRaw || null,
      lastProviderUpdateAt: now,
      deliveryUpdatedAt: mapped === "DELIVERED" || mapped === "FAILED" ? now : null
    }
  });

  await db.smsWebhookEvent.create({ data: { tenantId: message.campaign.tenantId, provider: "TWILIO", messageId: message.id, providerMessageId: sid || "unknown", eventType: statusRaw || "unknown", payload: body as any } });
  await audit({ tenantId: message.campaign.tenantId, action: "SMS_WEBHOOK_STATUS_UPDATED", entityType: "SmsMessage", entityId: message.id, provider: "TWILIO" });

  return { ok: true };
});

app.post("/numbers/search", async (req) => {
  const input = z.object({ areaCode: z.string().optional(), type: z.string().optional() }).parse(req.body);
  return numberProvider.searchNumbers(input);
});

app.post("/numbers/purchase", async (req) => {
  const user = getUser(req);
  const input = z.object({ e164: z.string() }).parse(req.body);
  const provider = await numberProvider.purchaseNumber({ e164: input.e164, tenantId: user.tenantId });
  const record = await db.phoneNumber.create({ data: { tenantId: user.tenantId, e164: input.e164, status: "purchased" } });
  return { provider, record };
});

const port = Number(process.env.PORT || 3001);
app.listen({ host: "0.0.0.0", port }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
