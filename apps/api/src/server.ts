import Fastify from "fastify";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import net from "net";
import dgram from "dgram";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
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
  VoipMsNumberProvider,
  SolaCardknoxAdapter,
  WirePbxClient,
  normalizeWirePbxEvent,
  type NormalizedWirePbxEvent
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
const voiceSimulate = (process.env.VOICE_SIMULATE || "false").toLowerCase() === "true";
const mobilePushSimulate = (process.env.MOBILE_PUSH_SIMULATE || "false").toLowerCase() === "true";
const mobilePushAccessToken = process.env.EXPO_PUSH_ACCESS_TOKEN || "";
const pbxWebhookVerifyMode = (process.env.PBX_WEBHOOK_VERIFY_MODE || "token").toLowerCase();
const pbxWebhookToken = process.env.PBX_WEBHOOK_TOKEN || "";
const pbxWebhookSignatureSecret = process.env.PBX_WEBHOOK_SIGNATURE_SECRET || "";
const pbxWebhookAllowedIps = (process.env.PBX_WEBHOOK_ALLOWED_IPS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && (process.env.SOLA_CARDKNOX_SIMULATE || "false").toLowerCase() === "true") {
  throw new Error("SOLA_CARDKNOX_SIMULATE is not allowed in production");
}
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
const execFileAsync = promisify(execFile);
const providerCredCacheTtlMs = 60_000;
const testSendLimiter = new Map<string, number[]>();
const billingRateLimiter = new Map<string, number[]>();
const voiceDiagHeartbeatLimiter = new Map<string, number>();
const voiceDiagEventLimiter = new Map<string, number[]>();
const turnValidationTokenSecret = process.env.TURN_VALIDATION_TOKEN_SECRET || process.env.JWT_SECRET || "change-me";
const mobileProvisioningTokenSecret = process.env.MOBILE_PROVISIONING_TOKEN_SECRET || process.env.JWT_SECRET || "change-me";
const sbcKamailioHost = process.env.SBC_KAMAILIO_HOST || "sbc-kamailio";
const sbcKamailioSipPort = Number(process.env.SBC_KAMAILIO_SIP_PORT || 5060);
const sbcKamailioTcpPort = Number(process.env.SBC_KAMAILIO_TCP_PORT || 5061);
const sbcRtpengineHost = process.env.SBC_RTPENGINE_HOST || "sbc-rtpengine";
const sbcRtpengineCtrlPort = Number(process.env.SBC_RTPENGINE_CTRL_PORT || 2223);
const sbcPbxHost = process.env.SBC_PBX_HOST || "pbx";
const sbcPbxPort = Number(process.env.SBC_PBX_PORT || 5060);
const sbcKamailioContainer = process.env.SBC_KAMAILIO_CONTAINER || "sbc-kamailio";
const sbcRtpengineContainer = process.env.SBC_RTPENGINE_CONTAINER || "sbc-rtpengine";

const BILLING_PLAN_CODE = "SMS_MONTHLY_10";
const BILLING_PLAN_PRICE_CENTS = 1000;

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" }
];

function getSolaAdapter(): SolaCardknoxAdapter {
  return new SolaCardknoxAdapter({
    baseUrl: process.env.SOLA_CARDKNOX_API_BASE_URL,
    apiKey: process.env.SOLA_CARDKNOX_API_KEY,
    apiSecret: process.env.SOLA_CARDKNOX_API_SECRET,
    webhookSecret: process.env.SOLA_CARDKNOX_WEBHOOK_SECRET,
    mode: (process.env.SOLA_CARDKNOX_MODE as "sandbox" | "prod" | undefined) || "sandbox",
    simulate: (process.env.SOLA_CARDKNOX_SIMULATE || "false").toLowerCase() === "true",
    hostedSessionPath: process.env.SOLA_CARDKNOX_HOSTED_SESSION_PATH || "/hosted-checkout/sessions",
    chargePath: process.env.SOLA_CARDKNOX_CHARGE_PATH || "/subscriptions/charge",
    cancelPath: process.env.SOLA_CARDKNOX_CANCEL_PATH || "/subscriptions/cancel",
    webhookSignatureHeader: process.env.SOLA_CARDKNOX_WEBHOOK_SIGNATURE_HEADER || "x-sola-signature",
    webhookTimestampHeader: process.env.SOLA_CARDKNOX_WEBHOOK_TIMESTAMP_HEADER || "x-sola-timestamp"
  });
}


function getWirePbxClient(config?: { baseUrl?: string; token?: string; secret?: string }): WirePbxClient {
  const simulate = (process.env.PBX_SIMULATE || "false").toLowerCase() === "true";
  const baseUrl = config?.baseUrl || process.env.PBX_BASE_URL;
  const token = config?.token || process.env.PBX_API_TOKEN;
  const secret = config?.secret || process.env.PBX_API_SECRET;

  return new WirePbxClient({
    baseUrl,
    apiToken: token,
    apiSecret: secret,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 10000),
    simulate,
    webhookRegisterPath: process.env.PBX_WEBHOOK_REGISTER_PATH,
    webhookListPath: process.env.PBX_WEBHOOK_LIST_PATH,
    webhookDeletePath: process.env.PBX_WEBHOOK_DELETE_PATH,
    activeCallsPath: process.env.PBX_ACTIVE_CALLS_PATH,
    supportsWebhooks: process.env.PBX_SUPPORTS_WEBHOOKS ? process.env.PBX_SUPPORTS_WEBHOOKS.toLowerCase() === "true" : undefined,
    supportsActiveCallPolling: process.env.PBX_SUPPORTS_ACTIVE_CALL_POLLING ? process.env.PBX_SUPPORTS_ACTIVE_CALL_POLLING.toLowerCase() === "true" : undefined,
    webhookSignatureMode: (process.env.PBX_WEBHOOK_SIGNATURE_MODE as "HMAC" | "TOKEN" | "NONE" | undefined) || undefined,
    webhookEventTypes: (process.env.PBX_WEBHOOK_EVENT_TYPES || "").split(",").map((x) => x.trim()).filter(Boolean),
    webhookCallbackUrl: process.env.PBX_WEBHOOK_CALLBACK_URL
  });
}

async function queuePbxJob(input: { tenantId: string; pbxInstanceId?: string | null; type: string; payload: any; lastError?: string | null }) {
  return db.pbxJob.create({
    data: {
      tenantId: input.tenantId,
      pbxInstanceId: input.pbxInstanceId || null,
      type: input.type,
      payload: input.payload as any,
      status: "QUEUED",
      attempts: 0,
      nextRunAt: new Date(),
      lastError: input.lastError || null
    }
  });
}

async function getTenantPbxLinkOrThrow(tenantId: string) {
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId }, include: { pbxInstance: true } });
  if (!link || link.status !== "LINKED" || !link.pbxInstance.isEnabled) {
    const err: any = new Error("PBX_NOT_LINKED");
    err.code = "PBX_NOT_LINKED";
    throw err;
  }
  return link;
}

function resolveWebrtcConfig(tenant: any, link: any) {
  const domain = tenant?.sipDomain || link?.pbxDomain || (link?.pbxInstance?.baseUrl ? new URL(link.pbxInstance.baseUrl).hostname : null);
  const configuredIce = Array.isArray(tenant?.iceServers) ? tenant.iceServers.filter((x: any) => x?.urls) : [];
  const explicitSipWsUrl = tenant?.sipWsUrl?.trim() || null;
  // /sip is the public nginx websocket path that proxies internally to Kamailio on the SBC layer.
  const fallbackSipWsUrl = tenant?.webrtcRouteViaSbc
    ? "wss://app.connectcomunications.com/sip"
    : (process.env.PBX_WS_ENDPOINT || null);
  return {
    webrtcEnabled: !!tenant?.webrtcEnabled,
    webrtcRouteViaSbc: !!tenant?.webrtcRouteViaSbc,
    sipWsUrl: explicitSipWsUrl || fallbackSipWsUrl,
    sipDomain: domain,
    outboundProxy: tenant?.outboundProxy || null,
    iceServers: configuredIce.length ? configuredIce : DEFAULT_ICE_SERVERS,
    dtmfMode: tenant?.dtmfMode || "RFC2833"
  };
}

function buildVoiceProvisioningBundle(tenant: any, link: any, sipUsername: string, sipPassword: string | null) {
  const cfg = resolveWebrtcConfig(tenant, link);
  return {
    sipUsername,
    sipPassword,
    sipWsUrl: cfg.sipWsUrl,
    sipDomain: cfg.sipDomain,
    outboundProxy: cfg.outboundProxy,
    iceServers: cfg.iceServers,
    dtmfMode: cfg.dtmfMode
  };
}

async function getOrCreateSubscription(tenantId: string) {
  const existing = await db.subscription.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return db.subscription.create({
    data: {
      tenantId,
      planCode: BILLING_PLAN_CODE,
      priceCents: BILLING_PLAN_PRICE_CENTS,
      status: "NONE"
    }
  });
}

async function enforceBillingForLive(tenantId: string): Promise<boolean> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return false;
  if (!tenant.smsBillingEnforced || !tenant.smsSubscriptionRequired) return true;
  const sub = await db.subscription.findUnique({ where: { tenantId } });
  return sub?.status === "ACTIVE";
}


async function queueReceiptEmail(params: { tenantId: string; to: string; amountCents: number; periodEnd: Date; receiptId: string }) {
  const endpoint = process.env.BILLING_RECEIPT_EMAIL_ENDPOINT;
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: params.to,
        subject: "Your Connect Communications SMS Subscription Receipt",
        amountCents: params.amountCents,
        nextBillingDate: params.periodEnd.toISOString(),
        receiptId: params.receiptId
      })
    });
  } catch {
    await db.auditLog.create({ data: { tenantId: params.tenantId, action: "BILLING_RECEIPT_EMAIL_FAILED", entityType: "Receipt", entityId: params.receiptId } });
  }
}

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


function maskHostOnly(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    if (raw.includes("://")) return new URL(raw).host.toLowerCase();
    const host = raw.split("/")[0].trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

function maskHostLabel(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "[unset]";
  return maskValue(normalized, 2, 2) || "[hidden]";
}

function normalizeVoiceRegState(v: unknown): "IDLE" | "REGISTERING" | "REGISTERED" | "FAILED" {
  const x = String(v || "").toLowerCase();
  if (x.includes("registering")) return "REGISTERING";
  if (x.includes("registered")) return "REGISTERED";
  if (x.includes("fail")) return "FAILED";
  return "IDLE";
}

function normalizeVoiceCallState(v: unknown): "IDLE" | "DIALING" | "RINGING" | "CONNECTED" | "ENDED" {
  const x = String(v || "").toLowerCase();
  if (x.includes("dial")) return "DIALING";
  if (x.includes("ring")) return "RINGING";
  if (x.includes("connect")) return "CONNECTED";
  if (x.includes("end") || x.includes("term")) return "ENDED";
  return "IDLE";
}

function sanitizeDiagPayload(input: any): any {
  const blocked = new Set(["password", "sipPassword", "authorization", "auth", "token", "secret", "sdp", "headers"]);
  function walk(v: any): any {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x));
    if (typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        const key = String(k);
        if (blocked.has(key) || key.toLowerCase().includes("password") || key.toLowerCase().includes("secret")) {
          out[key] = "[REDACTED]";
          continue;
        }
        out[key] = walk(val);
      }
      return out;
    }
    if (typeof v === "string") return v.length > 512 ? `${v.slice(0, 512)}...` : v;
    return v;
  }
  return walk(input || {});
}

function checkVoiceDiagHeartbeatLimit(sessionId: string): boolean {
  const now = Date.now();
  const last = voiceDiagHeartbeatLimiter.get(sessionId) || 0;
  if (now - last < 60_000) return false;
  voiceDiagHeartbeatLimiter.set(sessionId, now);
  return true;
}

function checkVoiceDiagEventLimit(sessionId: string, max = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (voiceDiagEventLimiter.get(sessionId) || []).filter((ts) => now - ts < windowMs);
  if (arr.length >= max) {
    voiceDiagEventLimiter.set(sessionId, arr);
    return false;
  }
  arr.push(now);
  voiceDiagEventLimiter.set(sessionId, arr);
  return true;
}


function maskUsername(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = String(value);
  if (v.length <= 4) return `${v[0] || "*"}***`;
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

function normalizeTurnUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((x) => String(x || "").trim()).filter((x) => x.length > 0);
}

function validateTurnUrls(urls: string[]): { ok: boolean; error?: string } {
  if (!urls.length) return { ok: false, error: "TURN_URLS_REQUIRED" };
  for (const u of urls) {
    const x = u.toLowerCase();
    if (!x.startsWith("turn:") && !x.startsWith("turns:")) return { ok: false, error: "TURN_URL_MUST_USE_TURN_SCHEME" };
  }
  return { ok: true };
}

function buildTurnConfigPublicView(cfg: any) {
  const urls = normalizeTurnUrls(cfg?.urls || []).map((u) => maskHostOnly(u) || "masked");
  return {
    scope: cfg?.scope || "GLOBAL",
    tenantId: cfg?.tenantId || null,
    urls,
    username: maskUsername(cfg?.username || null),
    hasCredential: !!cfg?.credentialEncrypted,
    updatedAt: cfg?.updatedAt || null
  };
}

function signTurnValidationToken(input: { jobId: string; tokenId: string; tenantId: string; userId: string; expMs: number }): string {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  const sig = createHmac("sha256", turnValidationTokenSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyTurnValidationToken(token: string): null | { jobId: string; tokenId: string; tenantId: string; userId: string; expMs: number } {
  const t = String(token || "").trim();
  const idx = t.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = t.slice(0, idx);
  const sig = t.slice(idx + 1);
  const expected = createHmac("sha256", turnValidationTokenSecret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed?.jobId || !parsed?.tokenId || !parsed?.tenantId || !parsed?.userId || !parsed?.expMs) return null;
    if (Number(parsed.expMs) < Date.now()) return null;
    return {
      jobId: String(parsed.jobId),
      tokenId: String(parsed.tokenId),
      tenantId: String(parsed.tenantId),
      userId: String(parsed.userId),
      expMs: Number(parsed.expMs)
    };
  } catch {
    return null;
  }
}


function hashToken(value: string): string {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function signMobileProvisioningToken(input: { tokenId: string; tenantId: string; userId: string; expMs: number }): string {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  const sig = createHmac("sha256", mobileProvisioningTokenSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyMobileProvisioningToken(token: string): null | { tokenId: string; tenantId: string; userId: string; expMs: number } {
  const t = String(token || "").trim();
  const idx = t.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = t.slice(0, idx);
  const sig = t.slice(idx + 1);
  const expected = createHmac("sha256", mobileProvisioningTokenSecret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed?.tokenId || !parsed?.tenantId || !parsed?.userId || !parsed?.expMs) return null;
    if (Number(parsed.expMs) < Date.now()) return null;
    return {
      tokenId: String(parsed.tokenId),
      tenantId: String(parsed.tenantId),
      userId: String(parsed.userId),
      expMs: Number(parsed.expMs)
    };
  } catch {
    return null;
  }
}

async function issueOneTimeProvisioningForUser(user: JwtUser): Promise<{ sipPassword: string; provisioning: any; pbxExtensionLinkId: string }> {
  const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) throw new Error("PBX_NOT_LINKED");

  const row = await db.pbxExtensionLink.findFirst({
    where: isAdmin ? { tenantId: user.tenantId } : { tenantId: user.tenantId, extension: { ownerUserId: user.sub } },
    include: { extension: true },
    orderBy: { createdAt: "asc" }
  });
  if (!row) throw new Error("EXTENSION_NOT_ASSIGNED");

  let sipPassword = "";
  if (voiceSimulate) {
    sipPassword = `sim-webrtc-${Date.now()}`;
  } else {
    const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
    const out = await getWirePbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }).resetPassword(row.pbxExtensionId);
    sipPassword = out.sipPassword;
  }

  await db.pbxExtensionLink.update({
    where: { id: row.id },
    data: { sipPasswordHash: await bcrypt.hash(sipPassword, 10), sipPasswordIssuedAt: new Date() }
  });

  const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
  return {
    sipPassword,
    provisioning: buildVoiceProvisioningBundle(tenant, link, row.pbxSipUsername, sipPassword),
    pbxExtensionLinkId: row.id
  };
}

async function getEffectiveTurnConfig(tenantId: string): Promise<any | null> {
  const tenantCfg = await db.turnConfig.findFirst({ where: { scope: "TENANT", tenantId } });
  if (tenantCfg) return tenantCfg;
  return db.turnConfig.findFirst({ where: { scope: "GLOBAL" } });
}

function isTurnRecentlyVerified(tenant: any): boolean {
  if (!tenant || tenant.turnValidationStatus !== "VERIFIED" || !tenant.turnValidatedAt) return false;
  return new Date(tenant.turnValidatedAt).getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1000;
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

function checkBillingRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const threshold = now - windowMs;
  const entries = (billingRateLimiter.get(key) || []).filter((x) => x >= threshold);
  if (entries.length >= max) {
    billingRateLimiter.set(key, entries);
    return false;
  }
  entries.push(now);
  billingRateLimiter.set(key, entries);
  return true;
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



type MobilePushPayload =
  | { type: "INCOMING_CALL"; inviteId: string; pbxCallId?: string | null; fromNumber: string; fromDisplay?: string | null; toExtension: string; sipCallTarget?: string | null; pbxSipUsername?: string | null; tenantId: string; timestamp: string }
  | { type: "INVITE_CLAIMED"; inviteId: string; tenantId: string; timestamp: string }
  | { type: "INVITE_CANCELED"; inviteId: string; pbxCallId?: string | null; reason?: string | null; tenantId: string; timestamp: string }
  | { type: "MISSED_CALL"; inviteId: string; fromNumber: string; fromDisplay?: string | null; toExtension: string; tenantId: string; timestamp: string };

async function sendPushToUserDevices(input: {
  tenantId: string;
  userId: string;
  payload: MobilePushPayload;
  excludeDeviceId?: string | null;
}) {
  const devices = await db.mobileDevice.findMany({ where: { tenantId: input.tenantId, userId: input.userId } });
  const filtered = input.excludeDeviceId ? devices.filter((d) => d.id !== input.excludeDeviceId) : devices;
  if (!filtered.length) return { queued: 0, simulated: mobilePushSimulate };

  if (mobilePushSimulate) {
    await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: "MOBILE_PUSH_SIMULATED",
        entityType: "CallInvite",
        entityId: input.payload.inviteId,
        actorUserId: input.userId
      }
    });
    return { queued: filtered.length, simulated: true };
  }

  const title = input.payload.type === "INCOMING_CALL"
    ? "Incoming call"
    : input.payload.type === "INVITE_CLAIMED"
      ? "Call answered on another device"
      : input.payload.type === "INVITE_CANCELED"
        ? "Call ended"
        : "Missed call";
  const body = input.payload.type === "INCOMING_CALL"
    ? `Call from ${input.payload.fromDisplay || input.payload.fromNumber}`
    : input.payload.type === "INVITE_CLAIMED"
      ? "This call was answered on another device."
      : input.payload.type === "INVITE_CANCELED"
        ? "This call has ended."
        : `Missed call from ${input.payload.fromDisplay || input.payload.fromNumber}`;

  const messages = filtered.map((d) => ({
    to: d.expoPushToken,
    sound: "default",
    title,
    body,
    data: input.payload
  }));

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (mobilePushAccessToken) headers.authorization = `Bearer ${mobilePushAccessToken}`;

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages)
  });

  await db.auditLog.create({
    data: {
      tenantId: input.tenantId,
      action: "MOBILE_PUSH_SENT",
      entityType: "CallInvite",
      entityId: input.payload.inviteId,
      actorUserId: input.userId
    }
  });

  return { queued: messages.length, simulated: false };
}

function getRequestSourceIp(req: any): string {
  return String((req.headers["x-forwarded-for"] || req.ip || "")).split(",")[0].trim();
}

function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verifyPbxWebhook(req: any, rawBody: string): { ok: boolean; reason?: string } {
  const mode = pbxWebhookVerifyMode;
  const sourceIp = getRequestSourceIp(req);

  if (mode === "hmac") {
    if (!pbxWebhookSignatureSecret) return { ok: false, reason: "PBX_WEBHOOK_SIGNATURE_SECRET_MISSING" };
    const sigHeader = String(req.headers["x-pbx-signature"] || req.headers["x-wirepbx-signature"] || "").trim();
    if (!sigHeader) return { ok: false, reason: "MISSING_SIGNATURE" };

    const ts = String(req.headers["x-pbx-timestamp"] || req.headers["x-wirepbx-timestamp"] || "").trim();
    const signingPayload = ts ? `${ts}.${rawBody}` : rawBody;
    const expected = createHmac("sha256", pbxWebhookSignatureSecret).update(signingPayload).digest("hex");
    const candidate = sigHeader.replace(/^sha256=/i, "");
    return timingSafeEquals(expected, candidate) ? { ok: true } : { ok: false, reason: "INVALID_SIGNATURE" };
  }

  if (mode === "token") {
    if (!pbxWebhookToken) return { ok: false, reason: "PBX_WEBHOOK_TOKEN_MISSING" };
    const fromHeader = String(req.headers["x-pbx-webhook-token"] || req.headers["x-wirepbx-token"] || "").trim();
    const authHeader = String(req.headers.authorization || "").trim();
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const token = fromHeader || bearer;
    return token && timingSafeEquals(token, pbxWebhookToken) ? { ok: true } : { ok: false, reason: "INVALID_TOKEN" };
  }

  if (mode === "ip_allowlist") {
    if (!pbxWebhookAllowedIps.length) return { ok: false, reason: "PBX_WEBHOOK_ALLOWED_IPS_MISSING" };
    return pbxWebhookAllowedIps.includes(sourceIp) ? { ok: true } : { ok: false, reason: "IP_NOT_ALLOWED" };
  }

  return { ok: false, reason: "UNKNOWN_VERIFY_MODE" };
}

async function resolvePbxEventTarget(evt: NormalizedWirePbxEvent): Promise<{ tenantId: string; userId: string; extensionId: string | null; pbxInstanceId?: string; pbxTenantLinkId?: string; pbxSipUsername?: string | null; sipDomain?: string | null } | null> {
  if (!evt.toExtension && !evt.pbxExtensionId) return null;

  if (evt.pbxTenantId) {
    const tenantLink = await db.tenantPbxLink.findFirst({
      where: { pbxTenantId: evt.pbxTenantId, status: "LINKED" },
      include: { pbxInstance: true }
    });
    if (tenantLink) {
      const extWhere: any = { tenantId: tenantLink.tenantId, extension: { status: "ACTIVE" } };
      if (evt.pbxExtensionId) extWhere.pbxExtensionId = evt.pbxExtensionId;
      const extLink = await db.pbxExtensionLink.findFirst({ where: extWhere, include: { extension: true } });
      let extension = extLink?.extension || null;
      if (!extension && evt.toExtension) {
        extension = await db.extension.findFirst({ where: { tenantId: tenantLink.tenantId, extNumber: evt.toExtension, status: "ACTIVE" } });
      }
      if (!extension?.ownerUserId) return null;
      return { tenantId: tenantLink.tenantId, userId: extension.ownerUserId, extensionId: extension.id, pbxInstanceId: tenantLink.pbxInstanceId, pbxTenantLinkId: tenantLink.id, pbxSipUsername: extLink?.pbxSipUsername || null, sipDomain: tenantLink.pbxDomain || null };
    }
  }

  if (evt.toExtension) {
    const candidates = await db.extension.findMany({
      where: { extNumber: evt.toExtension, status: "ACTIVE", ownerUserId: { not: null } },
      include: {
        pbxLink: true,
        tenant: { include: { pbxTenantLink: true } }
      },
      take: 20
    });

    const matched = candidates.find((c: any) => {
      const tenantLink = c.tenant?.pbxTenantLink;
      if (!tenantLink || tenantLink.status !== "LINKED") return false;
      if (evt.pbxTenantId && tenantLink.pbxTenantId !== evt.pbxTenantId) return false;
      if (evt.pbxExtensionId && c.pbxLink?.pbxExtensionId !== evt.pbxExtensionId) return false;
      return true;
    });

    if (matched?.ownerUserId) {
      return {
        tenantId: matched.tenantId,
        userId: matched.ownerUserId,
        extensionId: matched.id,
        pbxInstanceId: matched.tenant?.pbxTenantLink?.pbxInstanceId,
        pbxTenantLinkId: matched.tenant?.pbxTenantLink?.id,
        pbxSipUsername: matched.pbxLink?.pbxSipUsername || null,
        sipDomain: matched.tenant?.sipDomain || matched.tenant?.pbxTenantLink?.pbxDomain || null
      };
    }
  }

  return null;
}

async function updatePbxWebhookHeartbeat(pbxInstanceId: string | undefined, update: { lastEventAt?: Date; lastError?: string | null; status?: string }) {
  if (!pbxInstanceId) return;
  await db.pbxWebhookRegistration.updateMany({
    where: { pbxInstanceId },
    data: {
      ...(update.lastEventAt ? { lastEventAt: update.lastEventAt } : {}),
      ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
      ...(update.status ? { status: update.status } : {})
    }
  });
}

async function createMissedCallRecordForInvite(invite: any, disposition: "MISSED" | "CANCELED") {
  if (!invite?.pbxCallId) return;
  await db.callRecord.upsert({
    where: { tenantId_pbxCallId: { tenantId: invite.tenantId, pbxCallId: invite.pbxCallId } },
    create: {
      tenantId: invite.tenantId,
      pbxCallId: invite.pbxCallId,
      direction: "INBOUND",
      fromNumber: invite.fromNumber,
      toNumber: invite.toExtension,
      startedAt: invite.createdAt || new Date(),
      durationSec: 0,
      disposition
    },
    update: { disposition }
  });
}

async function resolveInviteByPbxEvent(evt: NormalizedWirePbxEvent, target: { tenantId: string } | null) {
  if (!evt.pbxCallId) return null;

  if (target?.tenantId) {
    const byTarget = await db.callInvite.findFirst({ where: { tenantId: target.tenantId, pbxCallId: evt.pbxCallId }, orderBy: { createdAt: "desc" } });
    if (byTarget) return byTarget;
  }

  if (evt.pbxTenantId) {
    const tenantLink = await db.tenantPbxLink.findFirst({ where: { pbxTenantId: evt.pbxTenantId, status: "LINKED" } });
    if (tenantLink) {
      const byTenantLink = await db.callInvite.findFirst({ where: { tenantId: tenantLink.tenantId, pbxCallId: evt.pbxCallId }, orderBy: { createdAt: "desc" } });
      if (byTenantLink) return byTenantLink;
    }
  }

  const maybe = await db.callInvite.findMany({ where: { pbxCallId: evt.pbxCallId }, orderBy: { createdAt: "desc" }, take: 2 });
  if (maybe.length === 1) return maybe[0];
  return null;
}

async function upsertInviteFromPbxEvent(evt: NormalizedWirePbxEvent, source: "WEBHOOK" | "POLL") {
  const target = await resolvePbxEventTarget(evt);

  if (target?.pbxInstanceId) {
    await updatePbxWebhookHeartbeat(target.pbxInstanceId, { lastEventAt: new Date(), lastError: null, status: "REGISTERED" });
  }

  if (evt.state === "RINGING") {
    if (!evt.pbxCallId) return { ok: false, reason: "MISSING_CALL_ID" };
    if (!target) {
      app.log.warn({ eventType: evt.eventType, pbxCallId: evt.pbxCallId, toExtension: evt.toExtension }, "pbx event target not found");
      return { ok: false, reason: "TARGET_NOT_FOUND" };
    }

    const existing = await db.callInvite.findFirst({ where: { tenantId: target.tenantId, pbxCallId: evt.pbxCallId }, orderBy: { createdAt: "desc" } });
    if (existing && existing.status === "PENDING" && existing.expiresAt > new Date()) {
      return { ok: true, deduped: true, inviteId: existing.id };
    }

    const invite = existing
      ? await db.callInvite.update({
          where: { id: existing.id },
          data: {
            userId: target.userId,
            extensionId: target.extensionId,
            fromNumber: evt.fromNumber,
            fromDisplay: evt.fromDisplay || null,
            toExtension: evt.toExtension,
            pbxSipUsername: target.pbxSipUsername || null,
            sipCallTarget: evt.sipCallTarget || ((target.pbxSipUsername && target.sipDomain) ? `sip:${target.pbxSipUsername}@${target.sipDomain}` : (evt.toExtension && target.sipDomain ? `sip:${evt.toExtension}@${target.sipDomain}` : null)),
            createdByEventId: evt.eventId || null,
            status: "PENDING",
            expiresAt: new Date(Date.now() + 45_000),
            acceptedAt: null,
            declinedAt: null,
            canceledAt: null,
            acceptedByDeviceId: null
          }
        })
      : await db.callInvite.create({
          data: {
            tenantId: target.tenantId,
            userId: target.userId,
            extensionId: target.extensionId,
            pbxCallId: evt.pbxCallId,
            fromNumber: evt.fromNumber,
            fromDisplay: evt.fromDisplay || null,
            toExtension: evt.toExtension,
            pbxSipUsername: target.pbxSipUsername || null,
            sipCallTarget: evt.sipCallTarget || ((target.pbxSipUsername && target.sipDomain) ? `sip:${target.pbxSipUsername}@${target.sipDomain}` : (evt.toExtension && target.sipDomain ? `sip:${evt.toExtension}@${target.sipDomain}` : null)),
            createdByEventId: evt.eventId || null,
            status: "PENDING",
            expiresAt: new Date(Date.now() + 45_000)
          }
        });

    const push = await sendPushToUserDevices({
      tenantId: target.tenantId,
      userId: target.userId,
      payload: {
        type: "INCOMING_CALL",
        inviteId: invite.id,
        fromNumber: invite.fromNumber,
        fromDisplay: invite.fromDisplay,
        toExtension: invite.toExtension,
        pbxCallId: invite.pbxCallId,
        sipCallTarget: invite.sipCallTarget,
        pbxSipUsername: invite.pbxSipUsername,
        tenantId: target.tenantId,
        timestamp: new Date().toISOString()
      }
    });

    await audit({ tenantId: target.tenantId, action: `PBX_CALL_INVITE_${source}`, entityType: "CallInvite", entityId: invite.id, actorUserId: target.userId });
    app.log.info({ eventType: evt.eventType, tenantId: target.tenantId, extensionId: target.extensionId, pbxCallId: evt.pbxCallId, result: "INVITE_CREATED", source }, "pbx event processed");
    return { ok: true, inviteId: invite.id, push };
  }

  if (!evt.pbxCallId || (evt.state !== "ANSWERED" && evt.state !== "HANGUP" && evt.state !== "CANCELED")) {
    return { ok: true, skipped: true };
  }

  const invite = await resolveInviteByPbxEvent(evt, target);
  if (!invite) return { ok: true, skipped: true };

  if (evt.state === "ANSWERED") {
    if (invite.status !== "PENDING") return { ok: true, inviteId: invite.id, status: invite.status, skipped: true };

    const now = new Date();
    await db.callInvite.update({
      where: { id: invite.id },
      data: {
        status: "ACCEPTED",
        acceptedAt: invite.acceptedAt || now
      }
    });
    await audit({ tenantId: invite.tenantId, action: "CALL_INVITE_ACCEPTED_BY_PBX", entityType: "CallInvite", entityId: invite.id, actorUserId: invite.userId });
    return { ok: true, inviteId: invite.id, status: "ACCEPTED" };
  }

  if (invite.status !== "PENDING") return { ok: true, inviteId: invite.id, status: invite.status, skipped: true };

  const now = new Date();
  const nextStatus = invite.expiresAt < now ? "EXPIRED" : "CANCELED";
  await db.callInvite.update({
    where: { id: invite.id },
    data: {
      status: nextStatus,
      canceledAt: now
    }
  });

  if (nextStatus === "EXPIRED") {
    await createMissedCallRecordForInvite(invite, "MISSED").catch(() => undefined);
  } else {
    await createMissedCallRecordForInvite(invite, "CANCELED").catch(() => undefined);
    await sendPushToUserDevices({
      tenantId: invite.tenantId,
      userId: invite.userId,
      payload: {
        type: "INVITE_CANCELED",
        inviteId: invite.id,
        pbxCallId: invite.pbxCallId,
        reason: evt.cause || evt.state,
        tenantId: invite.tenantId,
        timestamp: new Date().toISOString()
      }
    }).catch(() => undefined);
  }

  await audit({
    tenantId: invite.tenantId,
    action: "CALL_INVITE_CANCELED_BY_PBX",
    entityType: "CallInvite",
    entityId: invite.id,
    actorUserId: invite.userId
  });

  return { ok: true, inviteId: invite.id, status: nextStatus };
}

async function tcpProbe(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function udpProbe(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let settled = false;
    const payload = Buffer.from("ping");

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => done(true), timeoutMs);
    sock.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
    sock.send(payload, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        done(false);
      }
    });
  });
}

async function dockerContainerRunning(name: string): Promise<boolean | null> {
  try {
    const out = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeout: 1500 });
    const v = String(out.stdout || "").trim().toLowerCase();
    return v === "true";
  } catch {
    return null;
  }
}

function buildSipOptionsMessage(input: { targetHost: string; targetPort: number; viaHost: string; viaPort: number }): string {
  const branch = `z9hG4bK-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const callId = `sbc-status-${Date.now()}-${Math.floor(Math.random() * 100000)}@${input.viaHost}`;
  return [
    `OPTIONS sip:health@${input.targetHost}:${input.targetPort} SIP/2.0`,
    `Via: SIP/2.0/UDP ${input.viaHost}:${input.viaPort};branch=${branch};rport`,
    "Max-Forwards: 5",
    `From: <sip:sbc-status@${input.viaHost}>;tag=${Math.floor(Math.random() * 100000)}`,
    `To: <sip:health@${input.targetHost}:${input.targetPort}>`,
    `Call-ID: ${callId}`,
    "CSeq: 1 OPTIONS",
    `Contact: <sip:sbc-status@${input.viaHost}:${input.viaPort}>`,
    "Content-Length: 0",
    "",
    ""
  ].join("\r\n");
}

async function sipOptionsViaKamailio(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let settled = false;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => done(false), 2000);
    sock.once("error", () => {
      clearTimeout(timer);
      done(false);
    });

    sock.once("message", (msg) => {
      clearTimeout(timer);
      const text = String(msg || "");
      const m = text.match(/^SIP\/2\.0\s+(\d{3})/m);
      const status = m ? Number(m[1]) : 0;
      const ok = status >= 200 && status < 500 && status !== 408;
      done(ok);
    });

    const payload = buildSipOptionsMessage({
      targetHost: sbcPbxHost,
      targetPort: sbcPbxPort,
      viaHost: "connect-api",
      viaPort: 5099
    });

    sock.send(Buffer.from(payload), sbcKamailioSipPort, sbcKamailioHost, (err) => {
      if (err) {
        clearTimeout(timer);
        done(false);
      }
    });
  });
}

async function probeSbcStatus(): Promise<{ kamailio: "UP" | "DOWN"; rtpengine: "UP" | "DOWN"; pbx_via_sbc: "OK" | "FAIL" }> {
  const kamailioByDocker = await dockerContainerRunning(sbcKamailioContainer);
  const rtpengineByDocker = await dockerContainerRunning(sbcRtpengineContainer);

  const kamailioUp = kamailioByDocker !== null
    ? kamailioByDocker
    : await tcpProbe(sbcKamailioHost, sbcKamailioTcpPort);

  const rtpengineUp = rtpengineByDocker !== null
    ? rtpengineByDocker
    : await udpProbe(sbcRtpengineHost, sbcRtpengineCtrlPort);

  const pbxViaSbcOk = kamailioUp ? await sipOptionsViaKamailio() : false;

  return {
    kamailio: kamailioUp ? "UP" : "DOWN",
    rtpengine: rtpengineUp ? "UP" : "DOWN",
    pbx_via_sbc: pbxViaSbcOk ? "OK" : "FAIL"
  };
}

app.get("/admin/sbc/status", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  return probeSbcStatus();
});

app.get("/voice/sbc/status", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const status = await probeSbcStatus();
  return {
    ok: true,
    route: { publicPath: "/sip", publicSipWsUrl: "wss://app.connectcomunications.com/sip" },
    services: {
      kamailio: status.kamailio,
      rtpengine: status.rtpengine,
      pbxViaSbc: status.pbx_via_sbc
    },
    targets: {
      kamailioHost: maskHostLabel(sbcKamailioHost),
      rtpengineHost: maskHostLabel(sbcRtpengineHost),
      pbxHost: maskHostLabel(sbcPbxHost),
      pbxPort: sbcPbxPort
    }
  };
});

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
  const path = req.url.split("?")[0];
  if (path.includes("/webhooks/pbx") || ["/health", "/auth/signup", "/auth/login", "/webhooks/twilio/sms-status", "/webhooks/sola-cardknox"].includes(path)) return;
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

    const billingReady = await enforceBillingForLive(admin.tenantId);
    if (!billingReady) {
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SMS_SEND_MODE_CHANGE_REJECTED", entityType: "Tenant", entityId: admin.tenantId });
      return reply.status(400).send({ error: "SUBSCRIPTION_REQUIRED", message: "Active SMS subscription is required before enabling LIVE mode." });
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


app.get("/pbx/status", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: admin.tenantId }, include: { pbxInstance: true } });
  const pendingJobs = await db.pbxJob.count({ where: { tenantId: admin.tenantId, status: { in: ["QUEUED", "RUNNING"] } } });
  return {
    linked: !!link,
    status: link?.status || "UNLINKED",
    pbxInstanceId: link?.pbxInstanceId || null,
    pbxInstanceName: link?.pbxInstance?.name || null,
    pbxDomain: link?.pbxDomain || null,
    pbxTenantId: link?.pbxTenantId || null,
    lastSyncAt: link?.lastSyncAt || null,
    lastError: link?.lastError || null,
    pendingJobs
  };
});

app.post("/pbx/link", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const input = z.object({ pbxInstanceId: z.string(), pbxTenantId: z.string().optional(), pbxDomain: z.string().optional() }).parse(req.body || {});

  const instance = await db.pbxInstance.findUnique({ where: { id: input.pbxInstanceId } });
  if (!instance || !instance.isEnabled) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });

  const linked = await db.tenantPbxLink.upsert({
    where: { tenantId: admin.tenantId },
    create: {
      tenantId: admin.tenantId,
      pbxInstanceId: input.pbxInstanceId,
      pbxTenantId: input.pbxTenantId || null,
      pbxDomain: input.pbxDomain || null,
      status: "LINKED"
    },
    update: {
      pbxInstanceId: input.pbxInstanceId,
      pbxTenantId: input.pbxTenantId || null,
      pbxDomain: input.pbxDomain || null,
      status: "LINKED",
      lastError: null
    }
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_LINKED", entityType: "TenantPbxLink", entityId: linked.id });
  return linked;
});

app.post("/pbx/unlink", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const linked = await db.tenantPbxLink.findUnique({ where: { tenantId: admin.tenantId } });
  if (!linked) return { ok: true };
  const updated = await db.tenantPbxLink.update({ where: { id: linked.id }, data: { status: "UNLINKED" } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_UNLINKED", entityType: "TenantPbxLink", entityId: updated.id });
  return { ok: true, status: updated.status };
});

app.get("/pbx/extensions", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const rows = await db.pbxExtensionLink.findMany({ where: { tenantId: admin.tenantId }, include: { extension: true }, orderBy: { createdAt: "desc" } });
  return rows;
});

app.post("/pbx/extensions", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  if (!checkBillingRateLimit(`pbx-ext-create:${admin.tenantId}`, 30, 60 * 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const input = z.object({ extensionNumber: z.string().min(2), displayName: z.string().min(2), enableWebrtc: z.boolean().default(true), enableMobile: z.boolean().default(true) }).parse(req.body || {});
  const link = await getTenantPbxLinkOrThrow(admin.tenantId).catch(() => null);
  if (!link) return reply.status(400).send({ error: "PBX_NOT_LINKED" });

  const ext = await db.extension.create({ data: { tenantId: admin.tenantId, extNumber: input.extensionNumber, displayName: input.displayName, ownerUserId: admin.sub } });

  const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  const pbx = getWirePbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret });

  try {
    const created = await pbx.createExtension({ pbxTenantId: link.pbxTenantId || undefined, extensionNumber: input.extensionNumber, displayName: input.displayName });
    const dev = await pbx.createSipDevice({ pbxExtensionId: created.pbxExtensionId, enableWebrtc: input.enableWebrtc, enableMobile: input.enableMobile });

    const tenantCfg = await db.tenant.findUnique({ where: { id: admin.tenantId } });
    const saved = await db.pbxExtensionLink.create({
      data: {
        tenantId: admin.tenantId,
        extensionId: ext.id,
        pbxExtensionId: created.pbxExtensionId,
        pbxSipUsername: dev.sipUsername || created.sipUsername,
        sipPasswordHash: dev.sipPassword ? await bcrypt.hash(dev.sipPassword, 10) : null,
        sipPasswordIssuedAt: dev.sipPassword ? new Date() : null,
        pbxDeviceId: dev.pbxDeviceId || null,
        isSuspended: false
      }
    });

    const provisioning = buildVoiceProvisioningBundle(tenantCfg, link, saved.pbxSipUsername, dev.sipPassword || null);

    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_EXTENSION_CREATED", entityType: "PbxExtensionLink", entityId: saved.id });
    return { extension: ext, pbxLink: saved, provisioning };
  } catch (e: any) {
    await queuePbxJob({ tenantId: admin.tenantId, pbxInstanceId: link.pbxInstanceId, type: "CREATE_EXTENSION", payload: { extensionId: ext.id, extensionNumber: input.extensionNumber, displayName: input.displayName, enableWebrtc: input.enableWebrtc, enableMobile: input.enableMobile }, lastError: String(e?.code || e?.message || "PBX_UNAVAILABLE") });
    await db.tenantPbxLink.update({ where: { id: link.id }, data: { status: "ERROR", lastError: String(e?.code || e?.message || "PBX_UNAVAILABLE") } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_EXTENSION_QUEUED", entityType: "Extension", entityId: ext.id });
    return reply.status(202).send({ queued: true, error: "PBX_UNAVAILABLE", extensionId: ext.id });
  }
});

app.post("/pbx/extensions/:id/suspend", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const row = await db.pbxExtensionLink.findFirst({ where: { id, tenantId: admin.tenantId }, include: { extension: true, tenant: { include: { pbxTenantLink: { include: { pbxInstance: true } } } } } as any });
  if (!row) return reply.status(404).send({ error: "extension_not_found" });

  const link = await getTenantPbxLinkOrThrow(admin.tenantId).catch(() => null);
  if (!link) return reply.status(400).send({ error: "PBX_NOT_LINKED" });

  try {
    const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
    await getWirePbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }).suspendExtension(row.pbxExtensionId, true);
    await db.pbxExtensionLink.update({ where: { id: row.id }, data: { isSuspended: true } });
    await db.extension.update({ where: { id: row.extensionId }, data: { status: "SUSPENDED" } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_EXTENSION_SUSPENDED", entityType: "PbxExtensionLink", entityId: row.id });
    return { ok: true };
  } catch (e: any) {
    await queuePbxJob({ tenantId: admin.tenantId, pbxInstanceId: link.pbxInstanceId, type: "SUSPEND_EXTENSION", payload: { pbxExtensionId: row.pbxExtensionId, pbxExtensionLinkId: row.id }, lastError: String(e?.code || e?.message || "PBX_UNAVAILABLE") });
    return reply.status(202).send({ queued: true });
  }
});

app.post("/pbx/extensions/:id/unsuspend", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const row = await db.pbxExtensionLink.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!row) return reply.status(404).send({ error: "extension_not_found" });
  const link = await getTenantPbxLinkOrThrow(admin.tenantId).catch(() => null);
  if (!link) return reply.status(400).send({ error: "PBX_NOT_LINKED" });

  try {
    const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
    await getWirePbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }).suspendExtension(row.pbxExtensionId, false);
    await db.pbxExtensionLink.update({ where: { id: row.id }, data: { isSuspended: false } });
    await db.extension.update({ where: { id: row.extensionId }, data: { status: "ACTIVE" } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_EXTENSION_UNSUSPENDED", entityType: "PbxExtensionLink", entityId: row.id });
    return { ok: true };
  } catch {
    await queuePbxJob({ tenantId: admin.tenantId, pbxInstanceId: link.pbxInstanceId, type: "UNSUSPEND_EXTENSION", payload: { pbxExtensionId: row.pbxExtensionId, pbxExtensionLinkId: row.id } });
    return reply.status(202).send({ queued: true });
  }
});

app.post("/pbx/extensions/:id/reset-sip-password", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const row = await db.pbxExtensionLink.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!row) return reply.status(404).send({ error: "extension_not_found" });
  const link = await getTenantPbxLinkOrThrow(admin.tenantId).catch(() => null);
  if (!link) return reply.status(400).send({ error: "PBX_NOT_LINKED" });

  let sipPassword = "";
  if (voiceSimulate) {
    sipPassword = `sim-webrtc-${Date.now()}`;
  } else {
    const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
    const out = await getWirePbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }).resetPassword(row.pbxExtensionId);
    sipPassword = out.sipPassword;
  }

  await db.pbxExtensionLink.update({ where: { id: row.id }, data: { sipPasswordHash: await bcrypt.hash(sipPassword, 10), sipPasswordIssuedAt: new Date() } });
  const tenantCfg = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_EXTENSION_SIP_PASSWORD_RESET", entityType: "PbxExtensionLink", entityId: row.id });
  return { sipPassword, provisioning: buildVoiceProvisioningBundle(tenantCfg, link, row.pbxSipUsername, sipPassword) };
});

app.get("/pbx/dids", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  return db.pbxDidLink.findMany({ where: { tenantId: admin.tenantId }, include: { phoneNumber: true }, orderBy: { createdAt: "desc" } });
});

app.post("/pbx/dids/assign", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const input = z.object({ phoneNumberId: z.string(), routeType: z.enum(["MAIN_IVR", "RING_GROUP", "QUEUE", "EXTENSION", "CUSTOM"]), routeTarget: z.string().min(1) }).parse(req.body || {});
  const number = await db.phoneNumber.findFirst({ where: { id: input.phoneNumberId, tenantId: admin.tenantId } });
  if (!number) return reply.status(404).send({ error: "number_not_found" });

  const link = await getTenantPbxLinkOrThrow(admin.tenantId).catch(() => null);
  if (!link) return reply.status(400).send({ error: "PBX_NOT_LINKED" });

  try {
    const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
    const created = await getWirePbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }).createDidRoute({ pbxTenantId: link.pbxTenantId || undefined, did: number.phoneNumber, routeType: input.routeType, routeTarget: input.routeTarget });
    const did = await db.pbxDidLink.upsert({
      where: { tenantId_phoneNumberId: { tenantId: admin.tenantId, phoneNumberId: number.id } },
      create: { tenantId: admin.tenantId, phoneNumberId: number.id, pbxDidId: created.pbxDidId, routeType: input.routeType, routeTarget: input.routeTarget },
      update: { pbxDidId: created.pbxDidId, routeType: input.routeType, routeTarget: input.routeTarget }
    });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_DID_ASSIGNED", entityType: "PbxDidLink", entityId: did.id });
    return did;
  } catch (e: any) {
    await queuePbxJob({ tenantId: admin.tenantId, pbxInstanceId: link.pbxInstanceId, type: "ASSIGN_DID", payload: { phoneNumberId: number.id, routeType: input.routeType, routeTarget: input.routeTarget }, lastError: String(e?.code || e?.message || "PBX_UNAVAILABLE") });
    return reply.status(202).send({ queued: true, error: "PBX_UNAVAILABLE" });
  }
});

app.post("/pbx/dids/unassign", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const input = z.object({ phoneNumberId: z.string() }).parse(req.body || {});
  const row = await db.pbxDidLink.findFirst({ where: { tenantId: admin.tenantId, phoneNumberId: input.phoneNumberId } });
  if (!row) return { ok: true };
  await db.pbxDidLink.delete({ where: { id: row.id } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_DID_UNASSIGNED", entityType: "PbxDidLink", entityId: row.id });
  return { ok: true };
});

const iceServerSchema = z.object({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional()
});

app.get("/voice/webrtc/settings", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const [tenant, link] = await Promise.all([
    db.tenant.findUnique({
      where: { id: admin.tenantId },
      select: {
        webrtcEnabled: true,
        webrtcRouteViaSbc: true,
        sipWsUrl: true,
        sipDomain: true,
        outboundProxy: true,
        iceServers: true,
        dtmfMode: true
      }
    }),
    db.tenantPbxLink.findUnique({ where: { tenantId: admin.tenantId }, include: { pbxInstance: true } })
  ]);

  if (!tenant) return reply.status(404).send({ error: "TENANT_NOT_FOUND" });

  const cfg = resolveWebrtcConfig(tenant, link);
  return {
    ok: true,
    webrtcEnabled: cfg.webrtcEnabled,
    webrtcRouteViaSbc: cfg.webrtcRouteViaSbc,
    configuredSipWsUrl: tenant.sipWsUrl || null,
    effectiveSipWsUrl: cfg.sipWsUrl,
    effectiveSipDomain: cfg.sipDomain,
    outboundProxy: cfg.outboundProxy,
    dtmfMode: cfg.dtmfMode,
    iceServerCount: Array.isArray(cfg.iceServers) ? cfg.iceServers.length : 0
  };
});

app.put("/voice/webrtc/settings", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({ webrtcRouteViaSbc: z.boolean() }).parse(req.body || {});
  const updated = await db.tenant.update({
    where: { id: admin.tenantId },
    data: { webrtcRouteViaSbc: input.webrtcRouteViaSbc }
  });

  await audit({
    tenantId: admin.tenantId,
    actorUserId: admin.sub,
    action: input.webrtcRouteViaSbc ? "VOICE_WEBRTC_ROUTE_SBC_ENABLED" : "VOICE_WEBRTC_ROUTE_SBC_DISABLED",
    entityType: "Tenant",
    entityId: admin.tenantId
  });

  return { ok: true, webrtcRouteViaSbc: !!updated.webrtcRouteViaSbc };
});

app.get("/voice/me/extension", async (req, reply) => {
  const user = getUser(req);
  const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "TENANT_NOT_FOUND" });

  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) return reply.status(400).send({ error: "PBX_NOT_LINKED" });

  const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
  const row = await db.pbxExtensionLink.findFirst({
    where: isAdmin ? { tenantId: user.tenantId } : { tenantId: user.tenantId, extension: { ownerUserId: user.sub } },
    include: { extension: true },
    orderBy: { createdAt: "asc" }
  });
  if (!row) return reply.status(404).send({ error: "EXTENSION_NOT_ASSIGNED" });

  const cfg = resolveWebrtcConfig(tenant, link);
  return {
    extensionId: row.extension.id,
    pbxExtensionLinkId: row.id,
    extensionNumber: row.extension.extNumber,
    displayName: row.extension.displayName,
    sipUsername: row.pbxSipUsername,
    hasSipPassword: !!row.sipPasswordIssuedAt,
    webrtcEnabled: cfg.webrtcEnabled,
    webrtcRouteViaSbc: cfg.webrtcRouteViaSbc,
    sipWsUrl: cfg.sipWsUrl,
    sipDomain: cfg.sipDomain,
    outboundProxy: cfg.outboundProxy,
    iceServers: cfg.iceServers,
    dtmfMode: cfg.dtmfMode
  };
});

app.post("/voice/me/reset-sip-password", async (req, reply) => {
  const user = getUser(req);
  try {
    const out = await issueOneTimeProvisioningForUser(user);
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "VOICE_ME_SIP_PASSWORD_RESET", entityType: "PbxExtensionLink", entityId: out.pbxExtensionLinkId });
    return { sipPassword: out.sipPassword, provisioning: out.provisioning };
  } catch (e: any) {
    const code = String(e?.message || "VOICE_PROVISIONING_FAILED");
    if (code === "PBX_NOT_LINKED") return reply.status(400).send({ error: code });
    if (code === "EXTENSION_NOT_ASSIGNED") return reply.status(404).send({ error: code });
    return reply.status(400).send({ error: code });
  }
});


app.post("/voice/mobile-provisioning/token", async (req, reply) => {
  const user = getUser(req);

  if (!checkBillingRateLimit(`mobile-provisioning-token:${user.sub}`, 20, 60 * 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  // Ensure user can actually redeem a provisioning bundle before issuing token.
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId } });
  if (!link) return reply.status(400).send({ error: "PBX_NOT_LINKED" });

  const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
  const row = await db.pbxExtensionLink.findFirst({
    where: isAdmin ? { tenantId: user.tenantId } : { tenantId: user.tenantId, extension: { ownerUserId: user.sub } },
    orderBy: { createdAt: "asc" }
  });
  if (!row) return reply.status(404).send({ error: "EXTENSION_NOT_ASSIGNED" });

  const tokenId = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
  const token = signMobileProvisioningToken({ tokenId, tenantId: user.tenantId, userId: user.sub, expMs: expiresAt.getTime() });
  const tokenHash = hashToken(token);

  await db.mobileProvisioningToken.create({
    data: {
      tenantId: user.tenantId,
      userId: user.sub,
      tokenHash,
      expiresAt
    }
  });

  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "MOBILE_PROVISIONING_TOKEN_ISSUED", entityType: "MobileProvisioningToken", entityId: tokenId });
  return { token, expiresAt };
});

app.post("/voice/mobile-provisioning/redeem", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({ token: z.string().min(12), deviceInfo: z.any().optional() }).parse(req.body || {});

  if (!checkBillingRateLimit(`mobile-provisioning-redeem:${user.sub}`, 5, 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const verified = verifyMobileProvisioningToken(input.token);
  if (!verified) return reply.status(400).send({ error: "TOKEN_INVALID" });
  if (verified.tenantId !== user.tenantId || verified.userId !== user.sub) return reply.status(403).send({ error: "forbidden" });

  const tokenHash = hashToken(input.token);
  const now = new Date();

  const tokenRow = await db.mobileProvisioningToken.findFirst({
    where: { tokenHash, tenantId: user.tenantId, userId: user.sub }
  });
  if (!tokenRow) return reply.status(400).send({ error: "TOKEN_INVALID" });
  if (tokenRow.usedAt) return reply.status(400).send({ error: "TOKEN_ALREADY_USED" });
  if (tokenRow.expiresAt < now) return reply.status(400).send({ error: "TOKEN_EXPIRED" });

  const consume = await db.mobileProvisioningToken.updateMany({
    where: { id: tokenRow.id, usedAt: null, expiresAt: { gte: now } },
    data: { usedAt: now }
  });
  if (consume.count === 0) {
    const latest = await db.mobileProvisioningToken.findUnique({ where: { id: tokenRow.id } });
    if (latest?.usedAt) return reply.status(400).send({ error: "TOKEN_ALREADY_USED" });
    return reply.status(400).send({ error: "TOKEN_EXPIRED" });
  }

  try {
    const out = await issueOneTimeProvisioningForUser(user);
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "MOBILE_PROVISIONING_TOKEN_REDEEMED", entityType: "MobileProvisioningToken", entityId: tokenRow.id });
    return { sipPassword: out.sipPassword, provisioning: out.provisioning };
  } catch (e: any) {
    const code = String(e?.message || "VOICE_PROVISIONING_FAILED");
    return reply.status(code === "EXTENSION_NOT_ASSIGNED" ? 404 : 400).send({ error: code });
  }
});

app.post("/voice/webrtc/test-config", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({
    sipWsUrl: z.string().url().refine((v) => v.startsWith("wss://") || v.startsWith("ws://"), "sipWsUrl must use ws:// or wss://"),
    sipDomain: z.string().min(1).regex(/^[a-zA-Z0-9.-]+$/),
    outboundProxy: z.string().optional(),
    dtmfMode: z.enum(["RFC2833", "SIP_INFO"]).default("RFC2833"),
    requireTurn: z.boolean().default(false),
    iceServers: z.array(iceServerSchema).default([])
  }).safeParse(req.body || {});

  if (!input.success) {
    return reply.status(400).send({ error: "INVALID_WEBRTC_CONFIG", details: input.error.flatten() });
  }

  if (input.data.requireTurn) {
    const hasTurn = input.data.iceServers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => String(u).toLowerCase().startsWith("turn:"));
    });
    if (!hasTurn) {
      return reply.status(400).send({ error: "TURN_REQUIRED_BUT_NOT_CONFIGURED" });
    }
  }

  return { ok: true, normalized: input.data };
});

app.get("/voice/calls", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  return db.callRecord.findMany({ where: { tenantId: admin.tenantId }, orderBy: { startedAt: "desc" }, take: 200 });
});

app.get("/voice/provisioning", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  return db.pbxExtensionLink.findMany({ where: { tenantId: admin.tenantId }, include: { extension: true }, orderBy: { createdAt: "desc" } });
});

app.get("/voice/pending-jobs", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  return db.pbxJob.findMany({ where: { tenantId: admin.tenantId, status: { in: ["QUEUED", "RUNNING", "FAILED"] } }, orderBy: { createdAt: "desc" }, take: 100 });
});


app.post("/voice/diag/session/start", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    sessionId: z.string().optional(),
    platform: z.enum(["WEB", "IOS", "ANDROID"]),
    deviceId: z.string().optional(),
    appVersion: z.string().max(64).optional(),
    sipWsUrl: z.string().optional(),
    sipDomain: z.string().optional(),
    iceHasTurn: z.boolean().optional(),
    lastRegState: z.string().optional(),
    lastCallState: z.string().optional(),
    lastErrorCode: z.string().max(120).optional()
  }).parse(req.body || {});

  const device = input.deviceId
    ? await db.mobileDevice.findFirst({ where: { id: input.deviceId, tenantId: user.tenantId, userId: user.sub } })
    : null;

  const baseData: any = {
    platform: input.platform,
    deviceId: device?.id || null,
    appVersion: input.appVersion || null,
    sipWsUrl: maskHostOnly(input.sipWsUrl),
    sipDomain: maskHostOnly(input.sipDomain),
    iceHasTurn: !!input.iceHasTurn,
    lastRegState: normalizeVoiceRegState(input.lastRegState),
    lastCallState: normalizeVoiceCallState(input.lastCallState),
    lastSeenAt: new Date(),
    ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode, lastErrorAt: new Date() } : {})
  };

  let session: any = null;
  if (input.sessionId) {
    const updated = await db.voiceClientSession.updateMany({
      where: { id: input.sessionId, tenantId: user.tenantId, userId: user.sub },
      data: baseData
    });
    if (updated.count > 0) {
      session = await db.voiceClientSession.findUnique({ where: { id: input.sessionId } });
    }
  }

  if (!session) {
    session = await db.voiceClientSession.create({
      data: {
        tenantId: user.tenantId,
        userId: user.sub,
        startedAt: new Date(),
        ...baseData
      }
    });
  }

  await db.voiceDiagEvent.create({
    data: {
      tenantId: user.tenantId,
      userId: user.sub,
      sessionId: session.id,
      type: "SESSION_START",
      payload: sanitizeDiagPayload({ platform: session.platform, appVersion: session.appVersion, iceHasTurn: session.iceHasTurn }) as any
    }
  }).catch(() => undefined);

  return { ok: true, sessionId: session.id, startedAt: session.startedAt, lastSeenAt: session.lastSeenAt };
});

app.post("/voice/diag/session/heartbeat", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    sessionId: z.string(),
    lastRegState: z.string().optional(),
    lastCallState: z.string().optional(),
    lastErrorCode: z.string().max(120).optional(),
    iceHasTurn: z.boolean().optional(),
    sipWsUrl: z.string().optional(),
    sipDomain: z.string().optional()
  }).parse(req.body || {});

  const session = await db.voiceClientSession.findFirst({ where: { id: input.sessionId, tenantId: user.tenantId, userId: user.sub } });
  if (!session) return reply.status(404).send({ error: "SESSION_NOT_FOUND" });

  if (!checkVoiceDiagHeartbeatLimit(session.id)) {
    return { ok: true, throttled: true, sessionId: session.id };
  }

  const now = new Date();
  const updated = await db.voiceClientSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: now,
      ...(input.lastRegState ? { lastRegState: normalizeVoiceRegState(input.lastRegState) } : {}),
      ...(input.lastCallState ? { lastCallState: normalizeVoiceCallState(input.lastCallState) } : {}),
      ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode, lastErrorAt: now } : {}),
      ...(input.iceHasTurn !== undefined ? { iceHasTurn: !!input.iceHasTurn } : {}),
      ...(input.sipWsUrl ? { sipWsUrl: maskHostOnly(input.sipWsUrl) } : {}),
      ...(input.sipDomain ? { sipDomain: maskHostOnly(input.sipDomain) } : {})
    }
  });

  await db.voiceDiagEvent.create({
    data: {
      tenantId: user.tenantId,
      userId: user.sub,
      sessionId: session.id,
      type: "SESSION_HEARTBEAT",
      payload: sanitizeDiagPayload({ lastRegState: updated.lastRegState, lastCallState: updated.lastCallState, iceHasTurn: updated.iceHasTurn }) as any
    }
  }).catch(() => undefined);

  return { ok: true, sessionId: session.id, lastSeenAt: updated.lastSeenAt };
});

app.post("/voice/diag/event", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    sessionId: z.string(),
    type: z.enum(["SESSION_START", "SESSION_HEARTBEAT", "SIP_REGISTER", "SIP_UNREGISTER", "WS_CONNECTED", "WS_DISCONNECTED", "WS_RECONNECT", "ICE_GATHERING", "ICE_SELECTED_PAIR", "TURN_TEST_RESULT", "INCOMING_INVITE", "ANSWER_TAPPED", "CALL_CONNECTED", "CALL_ENDED", "ERROR"]),
    payload: z.any().optional()
  }).parse(req.body || {});

  const session = await db.voiceClientSession.findFirst({ where: { id: input.sessionId, tenantId: user.tenantId, userId: user.sub } });
  if (!session) return reply.status(404).send({ error: "SESSION_NOT_FOUND" });

  if (!checkVoiceDiagEventLimit(session.id, 60, 60_000)) {
    return reply.status(429).send({ error: "VOICE_DIAG_RATE_LIMITED" });
  }

  const payload = sanitizeDiagPayload(input.payload || {});
  const event = await db.voiceDiagEvent.create({
    data: {
      tenantId: user.tenantId,
      userId: user.sub,
      sessionId: session.id,
      type: input.type,
      payload: payload as any
    }
  });

  const now = new Date();
  const updateData: any = { lastSeenAt: now };
  if (input.type === "SIP_REGISTER") updateData.lastRegState = "REGISTERED";
  if (input.type === "SIP_UNREGISTER") updateData.lastRegState = "IDLE";
  if (input.type === "CALL_CONNECTED") updateData.lastCallState = "CONNECTED";
  if (input.type === "CALL_ENDED") updateData.lastCallState = "ENDED";
  if (input.type === "ERROR") {
    updateData.lastErrorCode = String((payload as any)?.code || "UNKNOWN");
    updateData.lastErrorAt = now;
  }
  await db.voiceClientSession.update({ where: { id: session.id }, data: updateData });

  if (input.type === "ERROR" || input.type === "WS_DISCONNECTED" || input.type === "SIP_UNREGISTER") {
    const p: any = payload || {};
    app.log.warn({
      tenantId: user.tenantId,
      userId: user.sub,
      sessionId: session.id,
      type: input.type,
      code: String(p.code || p.reason || "UNKNOWN").slice(0, 120),
      sipWsUrl: maskHostOnly(p.sipWsUrl) || session.sipWsUrl || null,
      sipDomain: maskHostOnly(p.sipDomain) || session.sipDomain || null
    }, "VOICE_DIAG_SIGNAL");
  }

  return { ok: true, eventId: event.id };
});

app.get("/voice/diag/sessions", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const sessions = await db.voiceClientSession.findMany({
    where: { tenantId: admin.tenantId },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
    include: { _count: { select: { events: true } } }
  });
  return sessions;
});

app.get("/voice/diag/recent-errors", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const events = await db.voiceDiagEvent.findMany({
    where: { tenantId: admin.tenantId, type: { in: ["ERROR", "WS_DISCONNECTED", "SIP_UNREGISTER"] } },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  return events.map((e: any) => {
    const payload = (e.payload || {}) as any;
    return {
      id: e.id,
      sessionId: e.sessionId,
      type: e.type,
      createdAt: e.createdAt,
      code: String(payload.code || payload.reason || e.type).slice(0, 120),
      sipWsUrl: maskHostOnly(payload.sipWsUrl),
      sipDomain: maskHostOnly(payload.sipDomain)
    };
  });
});

app.get("/voice/diag/sessions/:id/events", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const session = await db.voiceClientSession.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!session) return reply.status(404).send({ error: "SESSION_NOT_FOUND" });
  return db.voiceDiagEvent.findMany({ where: { tenantId: admin.tenantId, sessionId: id }, orderBy: { createdAt: "desc" }, take: 500 });
});


app.get("/voice/turn", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const [tenant, effective] = await Promise.all([
    db.tenant.findUnique({
      where: { id: admin.tenantId },
      select: {
        turnRequiredForMobile: true,
        turnValidationStatus: true,
        turnValidatedAt: true,
        turnLastErrorCode: true,
        turnLastErrorAt: true
      }
    }),
    getEffectiveTurnConfig(admin.tenantId)
  ]);

  return {
    ok: true,
    effective: effective ? buildTurnConfigPublicView(effective) : null,
    turnRequiredForMobile: !!tenant?.turnRequiredForMobile,
    status: tenant?.turnValidationStatus || "UNKNOWN",
    validatedAt: tenant?.turnValidatedAt || null,
    lastErrorCode: tenant?.turnLastErrorCode || null,
    lastErrorAt: tenant?.turnLastErrorAt || null
  };
});

app.put("/voice/turn", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({
    urls: z.array(z.string().min(1)).optional(),
    username: z.string().max(200).optional(),
    credential: z.string().max(2000).optional(),
    turnRequiredForMobile: z.boolean().optional(),
    clearOverride: z.boolean().optional()
  }).parse(req.body || {});

  if (input.clearOverride) {
    await db.turnConfig.deleteMany({ where: { scope: "TENANT", tenantId: admin.tenantId } });
  } else if (input.urls || input.username !== undefined || input.credential !== undefined) {
    const existing = await db.turnConfig.findFirst({ where: { scope: "TENANT", tenantId: admin.tenantId } });
    const urls = input.urls || normalizeTurnUrls(existing?.urls || []);
    const val = validateTurnUrls(urls);
    if (!val.ok) return reply.status(400).send({ error: val.error });

    const nextCredentialEncrypted = input.credential === undefined
      ? existing?.credentialEncrypted || null
      : (input.credential ? encryptJson({ credential: input.credential }) : null);

    if (existing) {
      await db.turnConfig.update({
        where: { id: existing.id },
        data: {
          urls: urls as any,
          username: input.username !== undefined ? (input.username || null) : existing.username,
          credentialEncrypted: nextCredentialEncrypted,
          credentialKeyId: nextCredentialEncrypted ? "v1" : null
        }
      });
    } else {
      await db.turnConfig.create({
        data: {
          scope: "TENANT",
          tenantId: admin.tenantId,
          urls: urls as any,
          username: input.username || null,
          credentialEncrypted: nextCredentialEncrypted,
          credentialKeyId: nextCredentialEncrypted ? "v1" : null
        }
      });
    }
  }

  if (input.turnRequiredForMobile !== undefined) {
    await db.tenant.update({ where: { id: admin.tenantId }, data: { turnRequiredForMobile: !!input.turnRequiredForMobile } });
  }

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "VOICE_TURN_CONFIG_UPDATED", entityType: "Tenant", entityId: admin.tenantId });

  const tenant = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  const effective = await getEffectiveTurnConfig(admin.tenantId);
  return {
    ok: true,
    effective: effective ? buildTurnConfigPublicView(effective) : null,
    turnRequiredForMobile: !!tenant?.turnRequiredForMobile,
    status: tenant?.turnValidationStatus || "UNKNOWN",
    validatedAt: tenant?.turnValidatedAt || null,
    lastErrorCode: tenant?.turnLastErrorCode || null,
    lastErrorAt: tenant?.turnLastErrorAt || null
  };
});

app.post("/voice/turn/validate", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  if (!checkBillingRateLimit(`voice-turn-validate:${admin.tenantId}`, 20, 60 * 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const effective = await getEffectiveTurnConfig(admin.tenantId);
  if (!effective) return reply.status(400).send({ error: "TURN_CONFIG_MISSING" });

  const urls = normalizeTurnUrls(effective.urls || []);
  const val = validateTurnUrls(urls);
  if (!val.ok) return reply.status(400).send({ error: val.error });

  const tokenId = createHmac("sha256", turnValidationTokenSecret).update(`${admin.tenantId}:${admin.sub}:${Date.now()}:${Math.random()}`).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const job = await db.turnValidationJob.create({
    data: {
      tenantId: admin.tenantId,
      requestedByUserId: admin.sub,
      status: "RUNNING",
      tokenId,
      expiresAt,
      startedAt: new Date()
    }
  });

  const token = signTurnValidationToken({
    jobId: job.id,
    tokenId,
    tenantId: admin.tenantId,
    userId: admin.sub,
    expMs: expiresAt.getTime()
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "VOICE_TURN_VALIDATE_REQUESTED", entityType: "TurnValidationJob", entityId: job.id });
  return { ok: true, jobId: job.id, token, expiresAt, effective: buildTurnConfigPublicView(effective) };
});

app.post("/voice/turn/validate/report", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    token: z.string().min(10),
    hasRelay: z.boolean(),
    durationMs: z.number().int().min(0).max(120000).optional(),
    platform: z.enum(["WEB", "IOS", "ANDROID"]).optional(),
    errorCode: z.string().max(120).optional()
  }).parse(req.body || {});

  const verified = verifyTurnValidationToken(input.token);
  if (!verified) return reply.status(400).send({ error: "INVALID_TURN_VALIDATION_TOKEN" });
  if (verified.tenantId !== user.tenantId) return reply.status(403).send({ error: "forbidden" });

  const job = await db.turnValidationJob.findFirst({ where: { id: verified.jobId, tokenId: verified.tokenId, tenantId: user.tenantId } });
  if (!job) return reply.status(404).send({ error: "TURN_VALIDATION_JOB_NOT_FOUND" });
  if (job.finishedAt) return { ok: true, jobId: job.id, status: job.status };
  if (job.expiresAt.getTime() < Date.now()) {
    await db.turnValidationJob.update({ where: { id: job.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode: "EXPIRED" } });
    return reply.status(400).send({ error: "TURN_VALIDATION_JOB_EXPIRED" });
  }

  const now = new Date();
  const success = !!input.hasRelay;

  await db.turnValidationJob.update({
    where: { id: job.id },
    data: {
      status: success ? "SUCCEEDED" : "FAILED",
      finishedAt: now,
      hasRelay: success,
      durationMs: input.durationMs || null,
      platform: input.platform || null,
      errorCode: success ? null : (input.errorCode || "NO_RELAY_CANDIDATE")
    }
  });

  await db.tenant.update({
    where: { id: user.tenantId },
    data: success
      ? { turnValidationStatus: "VERIFIED", turnValidatedAt: now, turnLastErrorCode: null, turnLastErrorAt: null }
      : { turnValidationStatus: "FAILED", turnLastErrorCode: input.errorCode || "NO_RELAY_CANDIDATE", turnLastErrorAt: now }
  });

  await db.alert.create({
    data: {
      tenantId: user.tenantId,
      severity: success ? "INFO" : "MEDIUM",
      category: "VOICE_TURN",
      message: success ? "TURN validation succeeded" : "TURN validation failed",
      metadata: { platform: input.platform || null, hasRelay: success, durationMs: input.durationMs || null, errorCode: success ? null : (input.errorCode || "NO_RELAY_CANDIDATE") } as any
    }
  }).catch(() => undefined);

  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: success ? "VOICE_TURN_VALIDATED" : "VOICE_TURN_VALIDATION_FAILED", entityType: "TurnValidationJob", entityId: job.id });

  return { ok: true, jobId: job.id, status: success ? "VERIFIED" : "FAILED" };
});

app.get("/admin/voice/turn/global", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const cfg = await db.turnConfig.findFirst({ where: { scope: "GLOBAL" } });
  return { ok: true, config: cfg ? buildTurnConfigPublicView(cfg) : null };
});

app.put("/admin/voice/turn/global", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({
    urls: z.array(z.string().min(1)).min(1),
    username: z.string().max(200).optional(),
    credential: z.string().max(2000).optional()
  }).parse(req.body || {});

  const val = validateTurnUrls(input.urls);
  if (!val.ok) return reply.status(400).send({ error: val.error });

  const existing = await db.turnConfig.findFirst({ where: { scope: "GLOBAL" } });
  const credentialEncrypted = input.credential !== undefined
    ? (input.credential ? encryptJson({ credential: input.credential }) : null)
    : existing?.credentialEncrypted || null;

  let row: any;
  if (existing) {
    row = await db.turnConfig.update({
      where: { id: existing.id },
      data: {
        urls: input.urls as any,
        username: input.username !== undefined ? (input.username || null) : existing.username,
        credentialEncrypted,
        credentialKeyId: credentialEncrypted ? "v1" : null
      }
    });
  } else {
    row = await db.turnConfig.create({
      data: {
        scope: "GLOBAL",
        urls: input.urls as any,
        username: input.username || null,
        credentialEncrypted,
        credentialKeyId: credentialEncrypted ? "v1" : null
      }
    });
  }

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "VOICE_TURN_GLOBAL_CONFIG_UPDATED", entityType: "TurnConfig", entityId: row.id });
  return { ok: true, config: buildTurnConfigPublicView(row) };
});

app.get("/admin/voice/turn/tenants", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const q = z.object({
    requiredOnly: z.union([z.string(), z.boolean()]).optional(),
    failedRequiredOnly: z.union([z.string(), z.boolean()]).optional()
  }).parse(req.query || {});
  const requiredOnly = String(q.requiredOnly || "").toLowerCase() === "true";
  const failedRequiredOnly = String(q.failedRequiredOnly || "").toLowerCase() === "true";

  const where: any = {};
  if (requiredOnly || failedRequiredOnly) where.turnRequiredForMobile = true;
  if (failedRequiredOnly) where.turnValidationStatus = { in: ["FAILED", "STALE", "UNKNOWN"] };

  const rows = await db.tenant.findMany({
    where,
    select: {
      id: true,
      name: true,
      turnRequiredForMobile: true,
      turnValidationStatus: true,
      turnValidatedAt: true,
      turnLastErrorCode: true,
      turnLastErrorAt: true
    },
    orderBy: { createdAt: "desc" },
    take: 300
  });

  return rows;
});

app.get("/admin/voice/diag/summary", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [sessions24h, wsDisc1h, answered1h, connected1h, sessionsNoTurn24h, events24h] = await Promise.all([
    db.voiceClientSession.count({ where: { startedAt: { gte: since24h } } }),
    db.voiceDiagEvent.count({ where: { createdAt: { gte: since1h }, type: "WS_DISCONNECTED" } }),
    db.voiceDiagEvent.count({ where: { createdAt: { gte: since1h }, type: "ANSWER_TAPPED" } }),
    db.voiceDiagEvent.count({ where: { createdAt: { gte: since1h }, type: "CALL_CONNECTED" } }),
    db.voiceClientSession.count({ where: { startedAt: { gte: since24h }, iceHasTurn: false } }),
    db.voiceDiagEvent.findMany({ where: { createdAt: { gte: since24h }, type: { in: ["INCOMING_INVITE", "CALL_CONNECTED"] } }, orderBy: { createdAt: "asc" }, select: { sessionId: true, type: true, createdAt: true } })
  ]);

  const inviteAt = new Map<string, number>();
  const latencies: number[] = [];
  for (const e of events24h) {
    if (e.type === "INCOMING_INVITE") inviteAt.set(e.sessionId, new Date(e.createdAt).getTime());
    if (e.type === "CALL_CONNECTED" && inviteAt.has(e.sessionId)) {
      latencies.push(new Date(e.createdAt).getTime() - (inviteAt.get(e.sessionId) || 0));
      inviteAt.delete(e.sessionId);
    }
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;

  return {
    window: { oneHourSince: since1h, daySince: since24h },
    sessions24h,
    wsDisconnectRatePerSession1h: sessions24h ? Number((wsDisc1h / sessions24h).toFixed(4)) : 0,
    answerToConnectRatio1h: answered1h ? Number((connected1h / answered1h).toFixed(4)) : 0,
    percentSessionsWithoutTurn24h: sessions24h ? Number(((sessionsNoTurn24h / sessions24h) * 100).toFixed(2)) : 0,
    inviteToConnectLatencyP95Ms24h: p95
  };
});

app.get("/admin/voice/diag/tenants", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const grouped = await db.voiceDiagEvent.groupBy({
    by: ["tenantId"],
    where: { createdAt: { gte: since24h }, type: { in: ["ERROR", "WS_DISCONNECTED"] } },
    _count: { _all: true },
    orderBy: { _count: { tenantId: "desc" } },
    take: 20
  } as any);

  const tenantIds = grouped.map((g: any) => g.tenantId);
  const tenants = tenantIds.length ? await db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }) : [];
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));

  return grouped.map((g: any) => ({
    tenantId: g.tenantId,
    tenantName: nameById.get(g.tenantId) || g.tenantId,
    failureEvents24h: g._count?._all || 0
  }));
});


app.post("/mobile/devices/register", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    platform: z.enum(["IOS", "ANDROID"]),
    expoPushToken: z.string().min(8),
    voipPushToken: z.string().optional(),
    deviceName: z.string().max(120).optional()
  }).parse(req.body || {});

  const saved = await db.mobileDevice.upsert({
    where: { expoPushToken: input.expoPushToken },
    create: {
      tenantId: user.tenantId,
      userId: user.sub,
      platform: input.platform,
      expoPushToken: input.expoPushToken,
      voipPushToken: input.voipPushToken || null,
      deviceName: input.deviceName || null,
      lastSeenAt: new Date()
    },
    update: {
      tenantId: user.tenantId,
      userId: user.sub,
      platform: input.platform,
      voipPushToken: input.voipPushToken || null,
      deviceName: input.deviceName || null,
      lastSeenAt: new Date()
    }
  });

  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "MOBILE_DEVICE_REGISTERED", entityType: "MobileDevice", entityId: saved.id });
  return { ok: true, id: saved.id, platform: saved.platform, lastSeenAt: saved.lastSeenAt };
});

app.post("/mobile/devices/unregister", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({ expoPushToken: z.string().min(8).optional() }).parse(req.body || {});

  const out = await db.mobileDevice.deleteMany({
    where: {
      tenantId: user.tenantId,
      userId: user.sub,
      ...(input.expoPushToken ? { expoPushToken: input.expoPushToken } : {})
    }
  });
  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "MOBILE_DEVICE_UNREGISTERED", entityType: "MobileDevice", entityId: user.sub });
  return { ok: true, removed: out.count };
});

app.get("/mobile/call-invites/pending", async (req, reply) => {
  const user = getUser(req);
  await db.callInvite.updateMany({ where: { tenantId: user.tenantId, userId: user.sub, status: "PENDING", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
  return db.callInvite.findMany({ where: { tenantId: user.tenantId, userId: user.sub, status: "PENDING", expiresAt: { gte: new Date() } }, orderBy: { createdAt: "desc" }, take: 20 });
});

app.post("/mobile/call-invites/:id/respond", async (req, reply) => {
  const user = getUser(req);
  const { id } = req.params as { id: string };
  const input = z.object({ action: z.enum(["ACCEPT", "DECLINE", "ACCEPTED", "DECLINED"]) }).parse(req.body || {});
  const action = input.action === "ACCEPT" || input.action === "ACCEPTED" ? "ACCEPT" : "DECLINE";
  const now = new Date();

  const deviceIdHeader = String(req.headers["x-mobile-device-id"] || "").trim();
  const activeDevice = deviceIdHeader
    ? await db.mobileDevice.findFirst({ where: { id: deviceIdHeader, tenantId: user.tenantId, userId: user.sub } })
    : null;

  const existing = await db.callInvite.findFirst({ where: { id, tenantId: user.tenantId, userId: user.sub } });
  if (!existing) {
    return { ok: false, code: "INVITE_ALREADY_HANDLED", status: "UNKNOWN" };
  }

  if (existing.status !== "PENDING") {
    return { ok: false, code: "INVITE_ALREADY_HANDLED", status: existing.status, inviteId: existing.id };
  }

  if (existing.expiresAt < now) {
    await db.callInvite.updateMany({ where: { id: existing.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    return { ok: false, code: "INVITE_EXPIRED", status: "EXPIRED", inviteId: existing.id };
  }

  if (action === "ACCEPT") {
    const tenant = await db.tenant.findUnique({
      where: { id: user.tenantId },
      select: { turnRequiredForMobile: true, turnValidationStatus: true, turnValidatedAt: true }
    });
    if (tenant?.turnRequiredForMobile && !isTurnRecentlyVerified(tenant)) {
      return {
        ok: false,
        code: "TURN_REQUIRED_NOT_VERIFIED",
        status: existing.status,
        inviteId: existing.id,
        turnValidationStatus: tenant.turnValidationStatus,
        turnValidatedAt: tenant.turnValidatedAt || null
      };
    }
    const claimed = await db.$transaction(async (tx) => {
      const updated = await tx.callInvite.updateMany({
        where: { id: existing.id, tenantId: user.tenantId, userId: user.sub, status: "PENDING", expiresAt: { gte: now } },
        data: { status: "ACCEPTED", acceptedAt: now, acceptedByDeviceId: activeDevice?.id || null }
      });
      const latest = await tx.callInvite.findUnique({ where: { id: existing.id } });
      return { updated: updated.count, latest };
    });

    if (claimed.updated === 0 || !claimed.latest) {
      const latestStatus = claimed.latest?.status || "UNKNOWN";
      const code = latestStatus === "EXPIRED" ? "INVITE_EXPIRED" : "INVITE_ALREADY_HANDLED";
      return { ok: false, code, status: latestStatus, inviteId: existing.id };
    }

    await sendPushToUserDevices({
      tenantId: user.tenantId,
      userId: user.sub,
      excludeDeviceId: activeDevice?.id || null,
      payload: {
        type: "INVITE_CLAIMED",
        inviteId: existing.id,
        tenantId: user.tenantId,
        timestamp: now.toISOString()
      }
    }).catch(() => undefined);

    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "MOBILE_CALL_INVITE_ACCEPT", entityType: "CallInvite", entityId: existing.id });
    return { ok: true, code: "INVITE_CLAIMED_OK", status: "ACCEPTED", inviteId: existing.id, acceptedByDeviceId: activeDevice?.id || null };
  }

  const declined = await db.callInvite.updateMany({
    where: { id: existing.id, tenantId: user.tenantId, userId: user.sub, status: "PENDING", expiresAt: { gte: now } },
    data: { status: "DECLINED", declinedAt: now }
  });

  if (declined.count === 0) {
    const latest = await db.callInvite.findUnique({ where: { id: existing.id } });
    const latestStatus = latest?.status || "UNKNOWN";
    const code = latestStatus === "EXPIRED" ? "INVITE_EXPIRED" : "INVITE_ALREADY_HANDLED";
    return { ok: false, code, status: latestStatus, inviteId: existing.id };
  }

  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "MOBILE_CALL_INVITE_DECLINE", entityType: "CallInvite", entityId: existing.id });
  return { ok: true, code: "INVITE_DECLINED_OK", status: "DECLINED", inviteId: existing.id };
});

app.post("/mobile/call-invites/test", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  if (!checkBillingRateLimit(`mobile-invite-test:${admin.tenantId}`, 20, 60 * 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const input = z.object({
    userId: z.string().optional(),
    userEmail: z.string().email().optional(),
    fromNumber: z.string().min(2),
    toExtension: z.string().min(1),
    expiresSec: z.number().int().min(15).max(120).default(45)
  }).parse(req.body || {});

  const target = input.userId
    ? await db.user.findFirst({ where: { id: input.userId, tenantId: admin.tenantId } })
    : await db.user.findFirst({ where: { email: input.userEmail || "", tenantId: admin.tenantId } });
  if (!target) return reply.status(404).send({ error: "TARGET_USER_NOT_FOUND" });

  const ext = await db.extension.findFirst({ where: { tenantId: admin.tenantId, ownerUserId: target.id }, orderBy: { createdAt: "asc" } });
  const tenantCfg = await db.tenant.findUnique({ where: { id: admin.tenantId } });
  const invite = await db.callInvite.create({
    data: {
      tenantId: admin.tenantId,
      userId: target.id,
      extensionId: ext?.id || null,
      fromNumber: input.fromNumber,
      fromDisplay: "Test Invite",
      toExtension: input.toExtension,
      pbxSipUsername: ext?.extNumber || null,
      sipCallTarget: ext?.extNumber && tenantCfg?.sipDomain ? `sip:${ext.extNumber}@${tenantCfg.sipDomain}` : null,
      createdByEventId: `test-${Date.now()}`,
      expiresAt: new Date(Date.now() + input.expiresSec * 1000),
      status: "PENDING"
    }
  });

  const push = await sendPushToUserDevices({
    tenantId: admin.tenantId,
    userId: target.id,
    payload: {
      type: "INCOMING_CALL",
      inviteId: invite.id,
      fromNumber: invite.fromNumber,
      fromDisplay: invite.fromDisplay,
      toExtension: invite.toExtension,
      pbxCallId: invite.pbxCallId,
      sipCallTarget: invite.sipCallTarget,
      pbxSipUsername: invite.pbxSipUsername,
      tenantId: admin.tenantId,
      timestamp: new Date().toISOString()
    }
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "MOBILE_CALL_INVITE_CREATED", entityType: "CallInvite", entityId: invite.id });
  return { ok: true, inviteId: invite.id, expiresAt: invite.expiresAt, push };
});

app.post("/webhooks/pbx", async (req, reply) => {
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  const verified = verifyPbxWebhook(req, rawBody);
  if (!verified.ok) {
    app.log.warn({ reason: verified.reason, sourceIp: getRequestSourceIp(req) }, "pbx webhook verification failed");
    return reply.status(403).send({ error: "INVALID_PBX_WEBHOOK", reason: verified.reason });
  }

  const normalized = normalizeWirePbxEvent(req.body || {});
  if (!normalized.pbxCallId || (normalized.state === "RINGING" && !normalized.toExtension)) {
    return reply.status(400).send({ error: "INVALID_EVENT_PAYLOAD" });
  }

  const result = await upsertInviteFromPbxEvent(normalized, "WEBHOOK");
  return { ok: true, eventType: normalized.eventType, state: normalized.state, result };
});

app.post("/admin/pbx/events/register", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ pbxInstanceId: z.string().min(1), callbackUrl: z.string().url().optional() }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.pbxInstanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });

  const configuredCallbackUrl = (process.env.PBX_WEBHOOK_CALLBACK_URL || "").trim();
  const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_URL || "").trim();
  const defaultCallbackUrl = configuredCallbackUrl
    || (publicApiBaseUrl ? `${publicApiBaseUrl.replace(/\/$/, "")}/webhooks/pbx` : "https://app.connectcomunications.com/api/webhooks/pbx");
  const callbackUrl = input.callbackUrl || defaultCallbackUrl;

  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const client = getWirePbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret });
  const caps = client.capabilities();
  if (!caps.supportsWebhooks) return reply.status(400).send({ error: "PBX_WEBHOOK_NOT_SUPPORTED", capabilities: caps });

  try {
    const out = await client.registerWebhook(callbackUrl);
    const reg = await db.pbxWebhookRegistration.upsert({
      where: { pbxInstanceId: instance.id },
      create: { pbxInstanceId: instance.id, webhookId: out.webhookId, callbackUrl, status: "REGISTERED" },
      update: { webhookId: out.webhookId, callbackUrl, status: "REGISTERED", lastError: null }
    });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_WEBHOOK_REGISTERED", entityType: "PbxWebhookRegistration", entityId: reg.id });
    return { ok: true, registration: reg, capabilities: caps };
  } catch (e: any) {
    await db.pbxWebhookRegistration.upsert({
      where: { pbxInstanceId: instance.id },
      create: { pbxInstanceId: instance.id, webhookId: "pending", callbackUrl, status: "ERROR", lastError: String(e?.code || e?.message || "PBX_WEBHOOK_REGISTER_FAILED") },
      update: { status: "ERROR", lastError: String(e?.code || e?.message || "PBX_WEBHOOK_REGISTER_FAILED") }
    });
    return reply.status(400).send({ error: String(e?.code || "PBX_WEBHOOK_REGISTER_FAILED") });
  }
});

app.post("/admin/pbx/events/unregister", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ pbxInstanceId: z.string().min(1) }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.pbxInstanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });

  const reg = await db.pbxWebhookRegistration.findUnique({ where: { pbxInstanceId: instance.id } });
  if (!reg) return { ok: true, removed: false };

  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const client = getWirePbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret });
  try {
    if (reg.webhookId && reg.webhookId !== "pending") {
      await client.deleteWebhook(reg.webhookId);
    }
  } catch (e: any) {
    await db.pbxWebhookRegistration.update({ where: { id: reg.id }, data: { status: "ERROR", lastError: String(e?.code || e?.message || "PBX_WEBHOOK_DELETE_FAILED") } });
    return reply.status(400).send({ error: String(e?.code || "PBX_WEBHOOK_DELETE_FAILED") });
  }

  const updated = await db.pbxWebhookRegistration.update({ where: { id: reg.id }, data: { status: "UNREGISTERED", lastError: null } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_WEBHOOK_UNREGISTERED", entityType: "PbxWebhookRegistration", entityId: reg.id });
  return { ok: true, registration: updated };
});

app.get("/admin/pbx/events/status", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const rows = await db.pbxInstance.findMany({
    orderBy: { createdAt: "desc" },
    include: { webhookRegistration: true }
  });

  const out = rows.map((r) => {
    let capabilities: any = { supportsWebhooks: false, supportsActiveCallPolling: false, webhookSignatureMode: "TOKEN" };
    try {
      const auth = decryptJson<{ token: string; secret?: string }>(r.apiAuthEncrypted);
      capabilities = getWirePbxClient({ baseUrl: r.baseUrl, token: auth.token, secret: auth.secret }).capabilities();
    } catch {
      // keep fallback capabilities
    }

    return {
      pbxInstanceId: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      isEnabled: r.isEnabled,
      capabilities,
      registration: r.webhookRegistration
        ? {
            webhookId: r.webhookRegistration.webhookId,
            callbackUrl: r.webhookRegistration.callbackUrl,
            status: r.webhookRegistration.status,
            lastEventAt: r.webhookRegistration.lastEventAt,
            lastError: r.webhookRegistration.lastError,
            updatedAt: r.webhookRegistration.updatedAt
          }
        : null
    };
  });

  return out;
});

app.post("/admin/pbx/events/parse-test", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const input = z.object({ event: z.record(z.any()) }).parse(req.body || {});
  const normalized = normalizeWirePbxEvent(input.event);
  const target = await resolvePbxEventTarget(normalized);
  return {
    ok: true,
    normalized,
    mapping: target
      ? { tenantId: target.tenantId, userId: target.userId, extensionId: target.extensionId, pbxInstanceId: target.pbxInstanceId }
      : null
  };
});

app.post("/admin/pbx/instances", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ name: z.string().min(2), baseUrl: z.string().url(), token: z.string().min(4), secret: z.string().optional(), isEnabled: z.boolean().default(true) }).parse(req.body || {});
  const created = await db.pbxInstance.create({ data: { name: input.name, baseUrl: input.baseUrl, isEnabled: input.isEnabled, apiAuthEncrypted: encryptJson({ token: input.token, secret: input.secret || null }) } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_INSTANCE_CREATED", entityType: "PbxInstance", entityId: created.id });
  return { id: created.id, name: created.name, baseUrl: created.baseUrl, isEnabled: created.isEnabled, createdAt: created.createdAt };
});

app.get("/admin/pbx/instances", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  return db.pbxInstance.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, baseUrl: true, isEnabled: true, createdAt: true, updatedAt: true } });
});

app.patch("/admin/pbx/instances/:id", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const { id } = req.params as { id: string };
  const input = z.object({ name: z.string().min(2).optional(), baseUrl: z.string().url().optional(), token: z.string().min(4).optional(), secret: z.string().optional(), isEnabled: z.boolean().optional() }).parse(req.body || {});
  const curr = await db.pbxInstance.findUnique({ where: { id } });
  if (!curr) return reply.status(404).send({ error: "not_found" });

  let apiAuthEncrypted = curr.apiAuthEncrypted;
  if (input.token || input.secret) {
    const existing = decryptJson<{ token: string; secret?: string | null }>(curr.apiAuthEncrypted);
    apiAuthEncrypted = encryptJson({ token: input.token || existing.token, secret: input.secret !== undefined ? input.secret : existing.secret || null });
  }

  const updated = await db.pbxInstance.update({ where: { id }, data: { name: input.name, baseUrl: input.baseUrl, isEnabled: input.isEnabled, apiAuthEncrypted } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_INSTANCE_UPDATED", entityType: "PbxInstance", entityId: updated.id });
  return { id: updated.id, name: updated.name, baseUrl: updated.baseUrl, isEnabled: updated.isEnabled, updatedAt: updated.updatedAt };
});

app.post("/admin/pbx/instances/:id/test", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const { id } = req.params as { id: string };
  const instance = await db.pbxInstance.findUnique({ where: { id } });
  if (!instance) return reply.status(404).send({ error: "not_found" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);

  try {
    await getWirePbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }).healthCheck();
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_INSTANCE_TEST_OK", entityType: "PbxInstance", entityId: instance.id });
    return { ok: true };
  } catch (e: any) {
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_INSTANCE_TEST_FAILED", entityType: "PbxInstance", entityId: instance.id });
    return reply.status(400).send({ error: String(e?.code || "PBX_UNAVAILABLE") });
  }
});

app.get("/billing/subscription", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const sub = await getOrCreateSubscription(admin.tenantId);
  return {
    planCode: sub.planCode,
    priceCents: sub.priceCents,
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    providerSubscriptionId: sub.providerSubscriptionId,
    lastPaymentStatus: sub.lastPaymentStatus,
    lastPaymentAt: sub.lastPaymentAt,
    checkoutState: sub.status === "PENDING" ? "PENDING_FINALIZATION" : null
  };
});

app.get("/billing/receipts", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  return db.receipt.findMany({ where: { tenantId: admin.tenantId }, orderBy: { createdAt: "desc" } });
});

app.post("/billing/subscription/hosted-session", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  if (!checkBillingRateLimit(`hosted:${admin.tenantId}`, 10, 60 * 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const input = z.object({ billingEmail: z.string().email() }).parse(req.body || {});
  const sub = await getOrCreateSubscription(admin.tenantId);
  if (sub.status === "ACTIVE") return reply.status(400).send({ error: "ALREADY_ACTIVE" });

  const adapter = getSolaAdapter();
  const hosted = await adapter.createHostedSession({
    tenantId: admin.tenantId,
    subscriptionId: sub.id,
    planCode: BILLING_PLAN_CODE,
    amountCents: BILLING_PLAN_PRICE_CENTS,
    successUrl: "https://app.connectcomunications.com/dashboard/billing?checkout=success",
    cancelUrl: "https://app.connectcomunications.com/dashboard/billing?checkout=cancel"
  });

  await db.subscription.update({ where: { id: sub.id }, data: { status: "PENDING", billingEmail: input.billingEmail, providerSubscriptionId: hosted.providerSessionId || sub.providerSubscriptionId || sub.id } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "BILLING_HOSTED_SESSION_CREATED", entityType: "Subscription", entityId: sub.id });

  return { redirectUrl: hosted.redirectUrl };
});

app.get("/billing/subscription/checkout-return", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const q = z.object({ checkout: z.string().optional() }).parse(req.query || {});
  const sub = await getOrCreateSubscription(admin.tenantId);
  return { message: "Payment received. Finalizing subscription...", checkout: q.checkout || null, status: sub.status };
});

app.post("/billing/subscription/cancel", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({ cancelAtPeriodEnd: z.boolean().default(true) }).parse(req.body);
  const sub = await getOrCreateSubscription(admin.tenantId);
  if (sub.providerSubscriptionId) {
    try { await getSolaAdapter().cancelSubscription(sub.providerSubscriptionId, input.cancelAtPeriodEnd); } catch {}
  }
  const nextStatus = input.cancelAtPeriodEnd ? sub.status : "CANCELED";
  const updated = await db.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: input.cancelAtPeriodEnd, status: nextStatus } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "BILLING_SUBSCRIPTION_CANCELED", entityType: "Subscription", entityId: updated.id });
  return { success: true, status: updated.status, cancelAtPeriodEnd: updated.cancelAtPeriodEnd };
});

app.get("/admin/billing/tenants", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const rows = await db.tenant.findMany({ include: { subscription: true }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    tenantId: r.id,
    tenantName: r.name,
    smsBillingEnforced: r.smsBillingEnforced,
    smsSubscriptionRequired: r.smsSubscriptionRequired,
    smsSuspended: r.smsSuspended,
    subscription: r.subscription
      ? {
          status: r.subscription.status,
          planCode: r.subscription.planCode,
          currentPeriodEnd: r.subscription.currentPeriodEnd,
          lastPaymentStatus: r.subscription.lastPaymentStatus,
          lastFailureReason: r.subscription.lastFailureReason,
          retryCount: r.subscription.retryCount,
          nextRetryAt: r.subscription.nextRetryAt
        }
      : null
  }));
});

app.get("/admin/billing/tenants/:id", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };

  const tenant = await db.tenant.findUnique({ where: { id }, include: { subscription: true } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const recentEvents = await db.paymentEvent.findMany({ where: { tenantId: id }, orderBy: { receivedAt: "desc" }, take: 20 });
  return { tenantId: tenant.id, tenantName: tenant.name, smsSuspended: tenant.smsSuspended, subscription: tenant.subscription, events: recentEvents };
});

app.post("/admin/billing/tenants/:id/override-status", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ status: z.enum(["NONE", "PENDING", "TRIALING", "ACTIVE", "PAST_DUE", "CANCELED"]), reason: z.string().min(3) }).parse(req.body);

  const sub = await getOrCreateSubscription(id);
  const updated = await db.subscription.update({ where: { id: sub.id }, data: { status: input.status, lastFailureReason: input.reason } });
  await db.tenant.update({
    where: { id },
    data: input.status === "ACTIVE" ? { smsSuspended: false, smsSuspendedReason: null, smsSuspendedAt: null } : { smsSuspended: true, smsSuspendedReason: "BILLING_OVERRIDE", smsSuspendedAt: new Date() }
  });
  await audit({ tenantId: id, actorUserId: admin.sub, action: "BILLING_OVERRIDE_STATUS", entityType: "Subscription", entityId: updated.id });
  return { success: true };
});

app.post("/webhooks/sola-cardknox", async (req, reply) => {
  const ip = String((req.headers["x-forwarded-for"] || req.ip || "")).split(",")[0].trim();
  if (!checkBillingRateLimit(`webhook:${ip}`, 240, 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  const adapter = getSolaAdapter();
  if (!adapter.verifyWebhook(req.headers as any, rawBody)) {
    return reply.status(403).send({ error: "invalid_signature" });
  }

  const event = adapter.parseWebhookEvent(rawBody);
  if (!event.eventId) return reply.status(400).send({ error: "missing_event_id" });

  const seen = await db.paymentEvent.findFirst({ where: { provider: "SOLA_CARDKNOX", providerEventId: event.eventId } });
  if (seen) return { ok: true, deduped: true };

  const sub = await db.subscription.findFirst({
    where: {
      OR: [
        event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : undefined,
        event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : undefined
      ].filter(Boolean) as any
    }
  });
  if (!sub) return { ok: true, unmatched: true };

  await db.paymentEvent.create({
    data: {
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      provider: "SOLA_CARDKNOX",
      providerEventId: event.eventId,
      type: event.type,
      status: event.status,
      amountCents: event.amountCents || null,
      currency: event.currency || "USD",
      payload: event.payload as any
    }
  });

  if (event.status === "SUCCEEDED") {
    const periodStart = new Date();
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const amount = event.amountCents || BILLING_PLAN_PRICE_CENTS;

    await db.subscription.update({
      where: { id: sub.id },
      data: {
        status: "ACTIVE",
        lastPaymentStatus: "SUCCEEDED",
        lastPaymentAt: periodStart,
        lastFailureReason: null,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        pastDueSince: null,
        retryCount: 0,
        nextRetryAt: null
      }
    });

    await db.usageLedger.create({ data: { tenantId: sub.tenantId, type: "SMS_SUBSCRIPTION_MONTHLY", quantity: 1, unitPriceCents: amount, totalCents: amount, referenceId: sub.id } });
    const receipt = await db.receipt.create({ data: { tenantId: sub.tenantId, subscriptionId: sub.id, amountCents: amount, periodStart, periodEnd } });

    await db.tenant.update({ where: { id: sub.tenantId }, data: { smsSuspended: false, smsSuspendedReason: null, smsSuspendedAt: null } });
    await audit({ tenantId: sub.tenantId, action: "SMS_TENANT_UNSUSPENDED", entityType: "Tenant", entityId: sub.tenantId });

    if (sub.billingEmail) {
      await queueReceiptEmail({ tenantId: sub.tenantId, to: sub.billingEmail, amountCents: amount, periodEnd, receiptId: receipt.id });
    }
  }

  if (event.status === "FAILED") {
    const now = new Date();
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        status: "PAST_DUE",
        lastPaymentStatus: "FAILED",
        lastFailureReason: event.type || "payment_failed",
        pastDueSince: sub.pastDueSince || now,
        retryCount: 0,
        nextRetryAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
      }
    });
    await db.tenant.update({ where: { id: sub.tenantId }, data: { smsSuspended: true, smsSuspendedReason: "BILLING_PAST_DUE", smsSuspendedAt: now } });
    await db.alert.create({ data: { tenantId: sub.tenantId, severity: "CRITICAL", category: "BILLING", message: "Subscription payment failed; tenant suspended.", metadata: { providerEventId: event.eventId } as any } });
    await audit({ tenantId: sub.tenantId, action: "SMS_TENANT_SUSPENDED", entityType: "Tenant", entityId: sub.tenantId });
  }

  return { ok: true };
});

const port = Number(process.env.PORT || 3001);
app.listen({ host: "0.0.0.0", port }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
