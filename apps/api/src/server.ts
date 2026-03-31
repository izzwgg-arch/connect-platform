import Fastify from "fastify";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import net from "net";
import dgram from "dgram";
import { promises as fsp } from "fs";
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
  type SolaCardknoxConfig,
  VitalPbxClient,
  inferPbxLiveDirection,
  type VitalPbxPermission,
  WirePbxClient,
  normalizeWirePbxEvent,
  type NormalizedWirePbxEvent
} from "@connect/integrations";
import { assessSmsRisk, normalizeSmsWithStop, tenDlcSubmissionSchema, twilioSettingsSchema } from "./validation";
import { canonicalDirection, cdrCanonicalDirectionSql } from "./cdrDirection";

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

// ── Telephony / WebRTC startup validation ─────────────────────────────────────
// Runs at module load — uses process.env directly (module-level consts declared below).
(function validateTelephonyEnv() {
  const ws = process.env.PBX_WS_ENDPOINT?.trim();
  if (!ws) {
    app.log.warn({ context: "telephony-env" }, "PBX_WS_ENDPOINT is not set — browser/mobile WebRTC provisioning will return sipWsUrl: null");
  } else if (!ws.startsWith("wss://") && !ws.startsWith("ws://")) {
    app.log.warn({ context: "telephony-env", value: ws }, "PBX_WS_ENDPOINT must start with wss:// or ws://");
  } else {
    app.log.info(
      { pbxWsEndpoint: ws, pbxHost: process.env.PBX_HOST || "209.145.60.79", hasTurn: !!process.env.TURN_SERVER },
      "Telephony WebRTC config loaded",
    );
  }
  if (!process.env.TURN_SERVER) {
    app.log.warn({ context: "telephony-env" }, "TURN_SERVER is not set — audio may fail behind strict NAT (acceptable for local-network testing)");
  }
})();

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

type BillingSolaCredentialPayload = {
  apiKey: string;
  apiSecret?: string | null;
  webhookSecret?: string | null;
};

type BillingSolaPathOverrides = {
  customerPath?: string;
  subscriptionPath?: string;
  transactionPath?: string;
  hostedSessionPath?: string;
  chargePath?: string;
  cancelPath?: string;
};

type WhatsAppProviderName = "WHATSAPP_TWILIO" | "WHATSAPP_META";

type WhatsAppTwilioCredentialPayload = {
  accountSid: string;
  authToken: string;
  fromWhatsAppNumber?: string;
  messagingServiceSid?: string;
};

type WhatsAppMetaCredentialPayload = {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  verifyToken: string;
  appSecret?: string | null;
  webhookSecret?: string | null;
};

type EmailProviderCredentialPayload = {
  sendgridApiKey?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPass?: string | null;
  smtpSecure?: boolean | null;
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
const mediaTestTokenSecret = process.env.MEDIA_TEST_TOKEN_SECRET || process.env.JWT_SECRET || "change-me";
const sbcKamailioHost = process.env.SBC_KAMAILIO_HOST || "sbc-kamailio";
const sbcKamailioSipPort = Number(process.env.SBC_KAMAILIO_SIP_PORT || 5060);
const sbcKamailioTcpPort = Number(process.env.SBC_KAMAILIO_TCP_PORT || 5061);
const sbcRtpengineHost = process.env.SBC_RTPENGINE_HOST || "sbc-rtpengine";
const sbcRtpengineCtrlPort = Number(process.env.SBC_RTPENGINE_CTRL_PORT || 2223);
const sbcPbxHost = process.env.SBC_PBX_HOST || "pbx";
const sbcPbxPort = Number(process.env.SBC_PBX_PORT || 5060);
const sbcKamailioContainer = process.env.SBC_KAMAILIO_CONTAINER || "sbc-kamailio";
const sbcRtpengineContainer = process.env.SBC_RTPENGINE_CONTAINER || "sbc-rtpengine";
const nginxConnectcommsSitePath = process.env.NGINX_CONNECTCOMMS_SITE_PATH || "/etc/nginx/sites-available/connectcomms";
const sbcUpstreamConfPath = process.env.SBC_UPSTREAM_CONF_PATH || "/etc/nginx/conf.d/sbc_upstream.conf";

const BILLING_PLAN_CODE = "SMS_MONTHLY_10";
const BILLING_PLAN_PRICE_CENTS = 1000;

// ── WebRTC / telephony env (read once at module load, validated at startup) ────
const pbxWsEndpoint: string | null = process.env.PBX_WS_ENDPOINT?.trim() || null;
const pbxHostEnv: string = (process.env.PBX_HOST || "209.145.60.79").trim();
const stunServerEnv: string = (process.env.STUN_SERVER || "stun:stun.l.google.com:19302").trim();
const turnServerEnv: string | null = process.env.TURN_SERVER?.trim() || null;
const turnUsernameEnv: string | null = process.env.TURN_USERNAME?.trim() || null;
const turnPasswordEnv: string | null = process.env.TURN_PASSWORD?.trim() || null;

// Build the canonical env-sourced ICE server list.
// Tenant DB values override this when present (see resolveWebrtcConfig).
function buildEnvIceServers(): Array<{ urls: string; username?: string; credential?: string }> {
  const servers: Array<{ urls: string; username?: string; credential?: string }> = [
    { urls: stunServerEnv },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ];
  if (turnServerEnv) {
    const turnUrl = (turnServerEnv.startsWith("turn:") || turnServerEnv.startsWith("turns:"))
      ? turnServerEnv
      : `turn:${turnServerEnv}:3478`;
    const entry: { urls: string; username?: string; credential?: string } = { urls: turnUrl };
    if (turnUsernameEnv) entry.username = turnUsernameEnv;
    if (turnPasswordEnv) entry.credential = turnPasswordEnv;
    servers.push(entry);
  }
  return servers;
}

const DEFAULT_ICE_SERVERS = buildEnvIceServers();

function getEnvSolaConfig(): SolaCardknoxConfig {
  return {
    baseUrl: process.env.SOLA_CARDKNOX_API_BASE_URL,
    apiKey: process.env.SOLA_CARDKNOX_API_KEY,
    apiSecret: process.env.SOLA_CARDKNOX_API_SECRET,
    webhookSecret: process.env.SOLA_CARDKNOX_WEBHOOK_SECRET,
    mode: (process.env.SOLA_CARDKNOX_MODE as "sandbox" | "prod" | undefined) || "sandbox",
    simulate: (process.env.SOLA_CARDKNOX_SIMULATE || "false").toLowerCase() === "true",
    authMode: ((process.env.SOLA_CARDKNOX_AUTH_MODE || "xkey_body").toLowerCase() === "authorization_header" ? "authorization_header" : "xkey_body"),
    authHeaderName: process.env.SOLA_CARDKNOX_AUTH_HEADER_NAME || "authorization",
    customerPath: process.env.SOLA_CARDKNOX_CUSTOMER_PATH || undefined,
    subscriptionPath: process.env.SOLA_CARDKNOX_SUBSCRIPTION_PATH || undefined,
    transactionPath: process.env.SOLA_CARDKNOX_TRANSACTION_PATH || undefined,
    hostedSessionPath: process.env.SOLA_CARDKNOX_HOSTED_SESSION_PATH || "/hosted-checkout/sessions",
    chargePath: process.env.SOLA_CARDKNOX_CHARGE_PATH || "/subscriptions/charge",
    cancelPath: process.env.SOLA_CARDKNOX_CANCEL_PATH || "/subscriptions/cancel",
    webhookSignatureHeader: process.env.SOLA_CARDKNOX_WEBHOOK_SIGNATURE_HEADER || "x-sola-signature",
    webhookTimestampHeader: process.env.SOLA_CARDKNOX_WEBHOOK_TIMESTAMP_HEADER || "x-sola-timestamp"
  };
}

function getSolaAdapter(configOverride?: SolaCardknoxConfig): SolaCardknoxAdapter {
  return new SolaCardknoxAdapter(configOverride || getEnvSolaConfig());
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

function getVitalPbxClient(config?: { baseUrl?: string; token?: string; secret?: string; ariBaseUrl?: string; timeoutMs?: number }): VitalPbxClient {
  const simulate = (process.env.PBX_SIMULATE || "false").toLowerCase() === "true";
  const baseUrl = config?.baseUrl || process.env.PBX_BASE_URL;
  const token = config?.token || process.env.PBX_API_TOKEN;
  const secret = config?.secret || process.env.PBX_API_SECRET;
  const ariBaseUrl = config?.ariBaseUrl ?? process.env.PBX_ARI_BASE_URL ?? undefined;
  return new VitalPbxClient({
    baseUrl,
    ariBaseUrl: ariBaseUrl || undefined,
    apiToken: token,
    apiSecret: secret,
    timeoutMs: config?.timeoutMs ?? Number(process.env.PBX_TIMEOUT_MS || 10000),
    simulate,
    logger: (entry) => {
      const payload = {
        direction: entry.direction,
        method: entry.method,
        path: entry.path,
        status: entry.status,
        correlationId: entry.correlationId,
        elapsedMs: entry.elapsedMs,
        errorCode: entry.errorCode,
        message: entry.message
      };
      if (entry.direction === "error") app.log.warn({ vitalpbx: payload }, "vitalpbx_error");
      else app.log.info({ vitalpbx: payload }, "vitalpbx_debug");
    }
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
  if (!link || !link.pbxInstance.isEnabled) {
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
  const fallbackSipWsUrl = tenant?.webrtcRouteViaSbc
    ? "wss://app.connectcomunications.com/sip"
    : pbxWsEndpoint;  // uses module-level pbxWsEndpoint (from PBX_WS_ENDPOINT env var)
  return {
    webrtcEnabled: !!tenant?.webrtcEnabled,
    webrtcRouteViaSbc: !!tenant?.webrtcRouteViaSbc,
    sipWsUrl: explicitSipWsUrl || fallbackSipWsUrl,
    sipDomain: domain,
    outboundProxy: tenant?.outboundProxy || null,
    // Tenant-configured ICE servers override env-sourced servers (TURN/STUN from env).
    // buildEnvIceServers() is called fresh here so TURN credentials are always current.
    iceServers: configuredIce.length ? configuredIce : buildEnvIceServers(),
    dtmfMode: tenant?.dtmfMode || "RFC2833"
  };
}


function maskIceServersForResponse(input: any[]): any[] {
  if (!Array.isArray(input)) return [];
  return input.map((row: any) => {
    const urls = Array.isArray(row?.urls) ? row.urls.map((u: any) => String(u || "").trim()).filter(Boolean) : String(row?.urls || "").trim();
    return {
      urls,
      username: maskUsername(row?.username || null),
      hasCredential: !!row?.credential
    };
  });
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


async function queueEmailJob(params: {
  tenantId: string;
  invoiceId?: string | null;
  type: string;
  toEmail: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}) {
  return db.emailJob.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId || null,
      type: params.type,
      toEmail: params.toEmail,
      subject: params.subject,
      htmlBody: params.htmlBody,
      textBody: params.textBody,
      status: "QUEUED",
      attempts: 0,
      nextRunAt: new Date()
    }
  });
}

async function queueReceiptEmail(params: { tenantId: string; to: string; amountCents: number; periodEnd: Date; receiptId: string }) {
  const dollars = (params.amountCents / 100).toFixed(2);
  const due = params.periodEnd.toISOString().slice(0, 10);
  await queueEmailJob({
    tenantId: params.tenantId,
    type: "PAYMENT_SUCCEEDED",
    toEmail: params.to,
    subject: "Your Connect Communications payment receipt",
    htmlBody: `<p>Your payment of <strong>$${dollars}</strong> succeeded.</p><p>Next billing date: ${due}</p><p>Receipt ID: ${params.receiptId}</p>`,
    textBody: `Payment succeeded. Amount: $${dollars}. Next billing date: ${due}. Receipt ID: ${params.receiptId}`
  });
}

async function queueInvoiceCreatedEmail(params: { tenantId: string; invoiceId: string; to: string; amountCents: number; payUrl: string }) {
  const dollars = (params.amountCents / 100).toFixed(2);
  await queueEmailJob({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    type: "INVOICE_CREATED",
    toEmail: params.to,
    subject: "Your Connect Communications invoice",
    htmlBody: `<p>Invoice amount: <strong>$${dollars}</strong></p><p><a href="${params.payUrl}">Pay now</a></p>`,
    textBody: `Invoice amount: $${dollars}. Pay now: ${params.payUrl}`
  });
}

async function queueInvoiceDeclineEmail(params: { tenantId: string; invoiceId: string; to: string; amountCents: number; retryUrl: string }) {
  const dollars = (params.amountCents / 100).toFixed(2);
  await queueEmailJob({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    type: "PAYMENT_FAILED",
    toEmail: params.to,
    subject: "Invoice payment failed - retry required",
    htmlBody: `<p>Payment for invoice amount <strong>$${dollars}</strong> failed.</p><p><a href="${params.retryUrl}">Retry payment</a></p>`,
    textBody: `Invoice payment failed for $${dollars}. Retry payment: ${params.retryUrl}`
  });
}

async function queueInvoiceReminderEmail(params: { tenantId: string; invoiceId: string; to: string; amountCents: number; payUrl: string; overdue?: boolean }) {
  const dollars = (params.amountCents / 100).toFixed(2);
  const subject = params.overdue ? "Invoice overdue - payment reminder" : "Invoice reminder";
  const intro = params.overdue
    ? `Your invoice for <strong>$${dollars}</strong> is overdue.`
    : `This is a reminder for your invoice amount of <strong>$${dollars}</strong>.`;
  await queueEmailJob({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    type: params.overdue ? "INVOICE_OVERDUE" : "INVOICE_REMINDER",
    toEmail: params.to,
    subject,
    htmlBody: `<p>${intro}</p><p><a href="${params.payUrl}">Pay invoice</a></p>`,
    textBody: `${params.overdue ? "Invoice overdue." : "Invoice reminder."} Amount: $${dollars}. Pay invoice: ${params.payUrl}`
  });
}

function sanitizeEventPayload(input: unknown): Record<string, any> {
  const src = (input && typeof input === "object") ? (input as Record<string, any>) : {};
  const out: Record<string, any> = {};
  const blocked = new Set(["authorization", "auth", "token", "secret", "password"]);
  for (const [k, v] of Object.entries(src)) {
    const key = String(k || "").toLowerCase();
    if (blocked.has(key) || key.includes("token") || key.includes("secret") || key.includes("password")) continue;
    if (typeof v === "string" && v.length > 500) out[k] = `${v.slice(0, 500)}...`;
    else out[k] = v;
  }
  return out;
}

async function logInvoiceEvent(params: { tenantId: string; invoiceId: string; type: string; payload?: Record<string, any> }) {
  await db.invoiceEvent.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      type: params.type,
      payload: sanitizeEventPayload(params.payload || {}) as any
    }
  });
}

async function sendEmailJobNow(job: any): Promise<void> {
  const provider = await db.emailProviderConfig.findUnique({ where: { tenantId: job.tenantId } });
  if (!provider || !provider.isEnabled) {
    const err: any = new Error("EMAIL_PROVIDER_NOT_CONFIGURED");
    err.code = "EMAIL_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const simulate = (process.env.EMAIL_SIMULATE || "true").toLowerCase() !== "false";
  if (simulate) return;

  const creds = decryptJson<EmailProviderCredentialPayload>(provider.credentialsEncrypted);
  if (provider.provider === "SENDGRID") {
    const key = String(creds.sendgridApiKey || "").trim();
    if (!key) {
      const err: any = new Error("SENDGRID_API_KEY_MISSING");
      err.code = "SENDGRID_API_KEY_MISSING";
      throw err;
    }
    const fromEmail = provider.fromEmail || "billing@connectcomunications.com";
    const fromName = provider.fromName || "Connect Communications";
    const payload = {
      personalizations: [{ to: [{ email: job.toEmail }] }],
      from: { email: fromEmail, name: fromName },
      subject: job.subject,
      content: [
        { type: "text/plain", value: job.textBody },
        { type: "text/html", value: job.htmlBody }
      ]
    };
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const err: any = new Error("SENDGRID_SEND_FAILED");
      err.code = "SENDGRID_SEND_FAILED";
      throw err;
    }
    return;
  }

  const endpoint = process.env.SMTP_BRIDGE_ENDPOINT;
  if (!endpoint) {
    const err: any = new Error("SMTP_BRIDGE_MISSING");
    err.code = "SMTP_BRIDGE_MISSING";
    throw err;
  }

  const smtpHost = provider.provider === "GOOGLE_WORKSPACE" ? (creds.smtpHost || "smtp-relay.gmail.com") : (creds.smtpHost || null);
  const smtpPort = provider.provider === "GOOGLE_WORKSPACE" ? (creds.smtpPort || 587) : (creds.smtpPort || null);
  const smtpSecure = provider.provider === "GOOGLE_WORKSPACE" ? (typeof creds.smtpSecure === "boolean" ? creds.smtpSecure : false) : !!creds.smtpSecure;

  await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      to: job.toEmail,
      subject: job.subject,
      html: job.htmlBody,
      text: job.textBody,
      smtpHost,
      smtpPort,
      smtpUser: creds.smtpUser || null,
      smtpPass: creds.smtpPass || null,
      smtpSecure,
      fromName: provider.fromName || null,
      fromEmail: provider.fromEmail || null,
      replyTo: provider.replyTo || null
    })
  });
}

let emailJobProcessorRunning = false;

async function processEmailJobsBatch() {
  if (emailJobProcessorRunning) return;
  emailJobProcessorRunning = true;
  try {
    const jobs = await db.emailJob.findMany({
      where: { status: { in: ["QUEUED", "FAILED"] }, nextRunAt: { lte: new Date() }, attempts: { lt: 5 } },
      orderBy: { createdAt: "asc" },
      take: 10
    });

    for (const job of jobs) {
      try {
        await db.emailJob.update({ where: { id: job.id }, data: { status: "RUNNING", attempts: job.attempts + 1 } });
        await sendEmailJobNow(job);
        await db.emailJob.update({ where: { id: job.id }, data: { status: "SENT", sentAt: new Date(), lastErrorCode: null, lastErrorMessage: null } });
      } catch (e: any) {
        const attempts = job.attempts + 1;
        const delayMin = Math.min(60, 2 ** attempts);
        await db.emailJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            lastErrorCode: String(e?.code || "EMAIL_SEND_FAILED"),
            lastErrorMessage: String(e?.message || "email send failed"),
            nextRunAt: new Date(Date.now() + delayMin * 60 * 1000)
          }
        });
      }
    }
  } finally {
    emailJobProcessorRunning = false;
  }
}

let invoiceOverdueProcessorRunning = false;

async function processInvoiceOverdueBatch() {
  if (invoiceOverdueProcessorRunning) return;
  invoiceOverdueProcessorRunning = true;
  try {
    const now = new Date();
    const candidates = await db.invoice.findMany({
      where: {
        status: "SENT",
        dueAt: { lt: now }
      },
      orderBy: { dueAt: "asc" },
      take: 50
    });

    for (const invoice of candidates) {
      const overdue = await db.invoice.update({
        where: { id: invoice.id },
        data: { status: "OVERDUE", lastFailureReason: invoice.lastFailureReason || "OVERDUE" }
      });
      await logInvoiceEvent({
        tenantId: overdue.tenantId,
        invoiceId: overdue.id,
        type: "OVERDUE",
        payload: { dueAt: overdue.dueAt?.toISOString() || null }
      });
      await audit({ tenantId: overdue.tenantId, action: "INVOICE_OVERDUE", entityType: "Invoice", entityId: overdue.id });

      const nowMs = Date.now();
      const recentReminder = await db.invoiceEvent.findFirst({
        where: {
          invoiceId: overdue.id,
          type: { in: ["REMINDER_SENT", "OVERDUE_REMINDER_SENT"] },
          createdAt: { gte: new Date(nowMs - 24 * 60 * 60 * 1000) }
        },
        orderBy: { createdAt: "desc" }
      });
      if (!recentReminder) {
        const payUrl = overdue.externalPaymentLink || (overdue.payToken ? `https://app.connectcomunications.com/pay/invoice/${overdue.payToken}` : null);
        if (payUrl) {
          await queueInvoiceReminderEmail({
            tenantId: overdue.tenantId,
            invoiceId: overdue.id,
            to: overdue.customerEmail,
            amountCents: overdue.amountCents,
            payUrl,
            overdue: true
          });
          await logInvoiceEvent({ tenantId: overdue.tenantId, invoiceId: overdue.id, type: "OVERDUE_REMINDER_SENT", payload: { payUrl } });
        }
      }
    }
  } finally {
    invoiceOverdueProcessorRunning = false;
  }
}

function encodeEin(rawEin: string): string {
  return Buffer.from(rawEin, "utf8").toString("base64");
}

function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

type RecipientNormalizationSummary = {
  totalInput: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  invalidRecipients: string[];
};

function normalizeRecipientArray(rawRecipients: string[]): { normalizedRecipients: string[]; summary: RecipientNormalizationSummary } {
  const expanded: string[] = [];
  for (const row of rawRecipients) {
    for (const piece of String(row || "").split(/[\s,;]+/g)) {
      const trimmed = piece.trim();
      if (trimmed) expanded.push(trimmed);
    }
  }

  const seen = new Set<string>();
  const invalidRecipients: string[] = [];
  const normalizedRecipients: string[] = [];
  let duplicateCount = 0;

  for (const token of expanded) {
    if (!isE164(token)) {
      invalidRecipients.push(token);
      continue;
    }
    if (seen.has(token)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(token);
    normalizedRecipients.push(token);
  }

  return {
    normalizedRecipients,
    summary: {
      totalInput: expanded.length,
      validCount: normalizedRecipients.length,
      invalidCount: invalidRecipients.length,
      duplicateCount,
      invalidRecipients: invalidRecipients.slice(0, 50)
    }
  };
}

function toCampaignUiStatus(status: string): "DRAFT" | "READY" | "SENDING" | "SENT" | "FAILED" | "BLOCKED" {
  if (status === "NEEDS_APPROVAL" || status === "PAUSED") return "BLOCKED";
  if (status === "QUEUED") return "READY";
  if (status === "SENDING") return "SENDING";
  if (status === "SENT") return "SENT";
  if (status === "FAILED") return "FAILED";
  return "DRAFT";
}

function maskValue(value: string | undefined | null, start = 6, end = 4): string | null {
  if (!value) return null;
  if (value.length <= start + end) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, start)}${"*".repeat(value.length - start - end)}${value.slice(-end)}`;
}

function normalizeSolaPathOverrides(input: unknown): BillingSolaPathOverrides {
  const src = (input && typeof input === "object") ? (input as Record<string, unknown>) : {};
  const pick = (key: keyof BillingSolaPathOverrides) => {
    const raw = String(src[key] || "").trim();
    return raw || undefined;
  };
  return {
    customerPath: pick("customerPath"),
    subscriptionPath: pick("subscriptionPath"),
    transactionPath: pick("transactionPath"),
    hostedSessionPath: pick("hostedSessionPath"),
    chargePath: pick("chargePath"),
    cancelPath: pick("cancelPath")
  };
}

function maskSolaConfigForResponse(input: {
  record: any;
  secrets: BillingSolaCredentialPayload;
  pathOverrides: BillingSolaPathOverrides;
}) {
  return {
    id: input.record.id,
    tenantId: input.record.tenantId,
    configured: true,
    isEnabled: !!input.record.isEnabled,
    apiBaseUrl: input.record.apiBaseUrl,
    mode: input.record.mode === "PROD" ? "prod" : "sandbox",
    simulate: !!input.record.simulate,
    authMode: input.record.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
    authHeaderName: input.record.authHeaderName || null,
    pathOverrides: input.pathOverrides,
    masked: {
      apiKey: maskValue(input.secrets.apiKey, 4, 2),
      apiSecret: input.secrets.apiSecret ? "********" : null,
      webhookSecret: input.secrets.webhookSecret ? "********" : null
    },
    status: {
      lastTestAt: input.record.lastTestAt,
      lastTestResult: input.record.lastTestResult || null,
      lastTestErrorCode: input.record.lastTestErrorCode || null
    },
    meta: {
      createdAt: input.record.createdAt,
      updatedAt: input.record.updatedAt,
      createdByUserId: input.record.createdByUserId,
      updatedByUserId: input.record.updatedByUserId
    }
  };
}

async function getTenantSolaConfig(tenantId: string, opts?: { requireEnabled?: boolean; allowFallbackEnv?: boolean }): Promise<{ source: "TENANT" | "ENV"; adapterConfig: SolaCardknoxConfig; record: any | null; masked: any | null }> {
  const requireEnabled = opts?.requireEnabled !== false;
  const allowFallbackEnv = !!opts?.allowFallbackEnv;

  const record = await db.billingSolaConfig.findUnique({ where: { tenantId } });
  if (!record) {
    if (allowFallbackEnv) {
      const envCfg = getEnvSolaConfig();
      if (envCfg.baseUrl && envCfg.apiKey) {
        return { source: "ENV", adapterConfig: envCfg, record: null, masked: null };
      }
    }
    const err: any = new Error("NOT_CONFIGURED");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  if (requireEnabled && !record.isEnabled) {
    const err: any = new Error("SOLA_NOT_ENABLED");
    err.code = "SOLA_NOT_ENABLED";
    throw err;
  }

  let secrets: BillingSolaCredentialPayload;
  try {
    secrets = decryptJson<BillingSolaCredentialPayload>(record.credentialsEncrypted);
  } catch {
    const err: any = new Error("SOLA_DECRYPT_FAILED");
    err.code = "SOLA_DECRYPT_FAILED";
    throw err;
  }

  const pathOverrides = normalizeSolaPathOverrides(record.pathOverrides || {});
  const adapterConfig: SolaCardknoxConfig = {
    baseUrl: record.apiBaseUrl,
    apiKey: secrets.apiKey,
    apiSecret: secrets.apiSecret || undefined,
    webhookSecret: secrets.webhookSecret || undefined,
    mode: record.mode === "PROD" ? "prod" : "sandbox",
    simulate: !!record.simulate,
    authMode: record.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
    authHeaderName: record.authHeaderName || undefined,
    customerPath: pathOverrides.customerPath,
    subscriptionPath: pathOverrides.subscriptionPath,
    transactionPath: pathOverrides.transactionPath,
    hostedSessionPath: pathOverrides.hostedSessionPath || undefined,
    chargePath: pathOverrides.chargePath || undefined,
    cancelPath: pathOverrides.cancelPath || undefined,
    webhookSignatureHeader: process.env.SOLA_CARDKNOX_WEBHOOK_SIGNATURE_HEADER || "x-sola-signature",
    webhookTimestampHeader: process.env.SOLA_CARDKNOX_WEBHOOK_TIMESTAMP_HEADER || "x-sola-timestamp"
  };

  return {
    source: "TENANT",
    adapterConfig,
    record,
    masked: maskSolaConfigForResponse({ record, secrets, pathOverrides })
  };
}


function maskWhatsAppConfigForResponse(row: any, creds: any) {
  if (!row) return null;
  if (row.provider === "WHATSAPP_TWILIO") {
    const c = creds as WhatsAppTwilioCredentialPayload;
    return {
      provider: row.provider,
      isEnabled: !!row.isEnabled,
      preview: {
        accountSid: maskValue(c.accountSid),
        authToken: c.authToken ? "********" : null,
        fromWhatsAppNumber: maskValue(c.fromWhatsAppNumber || null, 3, 2),
        messagingServiceSid: maskValue(c.messagingServiceSid || null)
      },
      settings: row.settings || {},
      updatedAt: row.updatedAt,
      lastTestAt: row.lastTestAt,
      lastTestResult: row.lastTestResult || null,
      lastTestErrorCode: row.lastTestErrorCode || null
    };
  }

  const c = creds as WhatsAppMetaCredentialPayload;
  return {
    provider: row.provider,
    isEnabled: !!row.isEnabled,
    preview: {
      phoneNumberId: maskValue(c.phoneNumberId),
      wabaId: maskValue(c.wabaId),
      accessToken: c.accessToken ? "********" : null,
      verifyToken: c.verifyToken ? "********" : null,
      appSecret: c.appSecret ? "********" : null,
      webhookSecret: c.webhookSecret ? "********" : null
    },
    settings: row.settings || {},
    updatedAt: row.updatedAt,
    lastTestAt: row.lastTestAt,
    lastTestResult: row.lastTestResult || null,
    lastTestErrorCode: row.lastTestErrorCode || null
  };
}

async function getEnabledWhatsAppProvider(tenantId: string): Promise<{ row: any; creds: any } | null> {
  const row = await db.whatsAppProviderConfig.findFirst({ where: { tenantId, isEnabled: true }, orderBy: { updatedAt: "desc" } });
  if (!row) return null;
  try {
    const creds = decryptJson<any>(row.credentialsEncrypted);
    return { row, creds };
  } catch {
    return null;
  }
}

function normalizeWhatsAppNumber(input: string): string {
  return String(input || "").trim();
}

function normalizeContactNumber(input: string | null | undefined): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  return raw.replace(/\s+/g, "");
}

function resolveDashboardRange(input: unknown): { key: "24h" | "7d" | "30d"; since: Date } {
  const range = String(input || "30d").toLowerCase();
  if (range === "24h") return { key: "24h", since: new Date(Date.now() - 24 * 60 * 60 * 1000) };
  if (range === "7d") return { key: "7d", since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
  return { key: "30d", since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
}

async function findCustomerByContactNumber(tenantId: string, number: string | null | undefined) {
  const normalized = normalizeContactNumber(number);
  if (!normalized) return null;
  return db.customer.findFirst({
    where: {
      tenantId,
      OR: [
        { whatsappNumber: normalized },
        { primaryPhone: normalized }
      ]
    },
    orderBy: { updatedAt: "desc" }
  });
}

function sanitizeMetadata(input: unknown): Record<string, any> {
  const src = (input && typeof input === "object") ? (input as Record<string, any>) : {};
  const out: Record<string, any> = {};
  const blocked = new Set(["authorization", "auth", "token", "secret", "password"]);
  for (const [k, v] of Object.entries(src)) {
    const key = String(k || "").toLowerCase();
    if (blocked.has(key) || key.includes("token") || key.includes("secret") || key.includes("password")) continue;
    if (typeof v === "string" && v.length > 400) {
      out[k] = `${v.slice(0, 400)}...`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function upsertWhatsAppThread(params: {
  tenantId: string;
  providerType: WhatsAppProviderName;
  contactNumber: string;
  contactName?: string | null;
  lastDirection?: string | null;
  lastStatus?: string | null;
  lastMessagePreview?: string | null;
}) {
  const number = normalizeWhatsAppNumber(params.contactNumber);
  const customer = await findCustomerByContactNumber(params.tenantId, number);
  const existing = await db.whatsAppThread.findFirst({
    where: { tenantId: params.tenantId, providerType: params.providerType, contactNumber: number }
  });
  if (existing) {
    return db.whatsAppThread.update({
      where: { id: existing.id },
      data: {
        customerId: existing.customerId || customer?.id || null,
        contactName: params.contactName || existing.contactName || null,
        lastMessageAt: new Date(),
        lastDirection: params.lastDirection || existing.lastDirection || null,
        lastStatus: params.lastStatus || existing.lastStatus || null,
        lastMessagePreview: params.lastMessagePreview || existing.lastMessagePreview || null
      }
    });
  }
  return db.whatsAppThread.create({
    data: {
      tenantId: params.tenantId,
      customerId: customer?.id || null,
      providerType: params.providerType,
      contactNumber: number,
      contactName: params.contactName || null,
      lastMessageAt: new Date(),
      lastDirection: params.lastDirection || null,
      lastStatus: params.lastStatus || null,
      lastMessagePreview: params.lastMessagePreview || null
    }
  });
}

async function createWhatsAppMessage(params: {
  tenantId: string;
  threadId: string;
  providerType: WhatsAppProviderName;
  direction: "INBOUND" | "OUTBOUND";
  fromNumber: string;
  toNumber: string;
  body: string;
  externalMessageId?: string | null;
  status: string;
  errorCode?: string | null;
  metadata?: Record<string, any>;
  deliveredAt?: Date | null;
}) {
  return db.whatsAppMessage.create({
    data: {
      tenantId: params.tenantId,
      threadId: params.threadId,
      providerType: params.providerType,
      direction: params.direction,
      fromNumber: normalizeWhatsAppNumber(params.fromNumber),
      toNumber: normalizeWhatsAppNumber(params.toNumber),
      body: params.body,
      externalMessageId: params.externalMessageId || null,
      status: params.status,
      errorCode: params.errorCode || null,
      metadata: sanitizeMetadata(params.metadata || {}),
      deliveredAt: params.deliveredAt || null
    }
  });
}

async function updateWhatsAppMessageStatus(params: {
  providerType: WhatsAppProviderName;
  externalMessageId: string;
  status: string;
  errorCode?: string | null;
  metadata?: Record<string, any>;
  deliveredAt?: Date | null;
}) {
  const row = await db.whatsAppMessage.findFirst({
    where: { providerType: params.providerType, externalMessageId: params.externalMessageId },
    orderBy: { createdAt: "desc" }
  });
  if (!row) return null;

  const updated = await db.whatsAppMessage.update({
    where: { id: row.id },
    data: {
      status: params.status,
      errorCode: params.errorCode || null,
      metadata: sanitizeMetadata({ ...(row.metadata as any || {}), ...(params.metadata || {}) }),
      deliveredAt: params.deliveredAt || row.deliveredAt || null
    }
  });

  await db.whatsAppThread.update({
    where: { id: row.threadId },
    data: { lastStatus: params.status, lastMessageAt: new Date() }
  }).catch(() => undefined);
  return updated;
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

type StaffRole = "SUPER_ADMIN" | "ADMIN" | "BILLING" | "MESSAGING" | "SUPPORT" | "READ_ONLY" | "USER";

function isRole(user: JwtUser, allowed: StaffRole[]): boolean {
  return allowed.includes((user.role || "USER") as StaffRole);
}

function canManageBilling(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN", "ADMIN", "BILLING"]);
}

function canManageMessaging(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN", "ADMIN", "MESSAGING"]);
}

function canViewCustomers(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN", "ADMIN", "BILLING", "MESSAGING", "SUPPORT", "READ_ONLY", "USER"]);
}

function canManageProviders(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN", "ADMIN"]);
}

function canAccessAdminSbc(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN"]);
}

function canAccessAdminBilling(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN"]);
}

function canAccessCampaignSend(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN", "ADMIN", "MESSAGING"]);
}

function constantTimeEqualStr(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * TEMPORARY: gate for POST /admin/dev/generate-observe-token (remove when observation is done).
 * Allowed when NODE_ENV=development, or when DEV_OBSERVE_TOKEN_SECRET (≥16 chars) matches
 * header X-Dev-Observe-Secret or JSON body field "secret" (constant-time compare).
 */
function canIssueDevObserveJwt(req: { headers: Record<string, unknown>; body?: unknown }): boolean {
  if ((process.env.NODE_ENV || "") === "development") return true;
  const envSecret = (process.env.DEV_OBSERVE_TOKEN_SECRET || "").trim();
  if (envSecret.length < 16) return false;
  const h = String(req.headers["x-dev-observe-secret"] ?? "").trim();
  let bodySecret = "";
  if (req.body && typeof req.body === "object" && req.body !== null && "secret" in (req.body as object)) {
    const s = (req.body as { secret?: unknown }).secret;
    if (typeof s === "string") bodySecret = s.trim();
  }
  const provided = h.length > 0 ? h : bodySecret;
  return constantTimeEqualStr(provided, envSecret);
}

function canManageCustomerWorkflow(user: JwtUser): boolean {
  return isRole(user, ["SUPER_ADMIN", "ADMIN", "BILLING", "SUPPORT"]);
}

function canUseCustomerTargeting(user: JwtUser): boolean {
  return canManageMessaging(user) || canManageBilling(user);
}

const VITALPBX_ROLE_PERMISSIONS: Record<StaffRole, Set<VitalPbxPermission>> = {
  SUPER_ADMIN: new Set<VitalPbxPermission>([
    "vitalpbx.connection.view", "vitalpbx.connection.edit", "vitalpbx.connection.test",
    "vitalpbx.tenants.view", "vitalpbx.tenants.create", "vitalpbx.tenants.update", "vitalpbx.tenants.delete", "vitalpbx.tenants.switchContext",
    "vitalpbx.extensions.view", "vitalpbx.extensions.create", "vitalpbx.extensions.update", "vitalpbx.extensions.delete", "vitalpbx.extensions.viewRegistration", "vitalpbx.extensions.viewAccountCodes",
    "vitalpbx.inboundRoutes.view", "vitalpbx.inboundRoutes.create", "vitalpbx.inboundRoutes.update", "vitalpbx.inboundRoutes.delete",
    "vitalpbx.outboundRoutes.view", "vitalpbx.outboundRoutes.create", "vitalpbx.outboundRoutes.update", "vitalpbx.outboundRoutes.delete",
    "vitalpbx.ivr.view", "vitalpbx.ivr.create", "vitalpbx.ivr.update", "vitalpbx.ivr.delete",
    "vitalpbx.ringGroups.view", "vitalpbx.ringGroups.create", "vitalpbx.ringGroups.update", "vitalpbx.ringGroups.delete",
    "vitalpbx.queues.view", "vitalpbx.queues.create", "vitalpbx.queues.update", "vitalpbx.queues.delete", "vitalpbx.queues.agentControl",
    "vitalpbx.cdr.view", "vitalpbx.cdr.export", "vitalpbx.cdr.sync", "vitalpbx.cdr.viewRaw",
    "vitalpbx.recordings.view", "vitalpbx.recordings.download", "vitalpbx.recordings.delete",
    "vitalpbx.voicemail.view", "vitalpbx.voicemail.download", "vitalpbx.voicemail.delete", "vitalpbx.voicemail.updateSettings",
    "vitalpbx.accountCodes.view",
    "vitalpbx.authorizationCodes.view", "vitalpbx.authorizationCodes.create", "vitalpbx.authorizationCodes.update", "vitalpbx.authorizationCodes.delete",
    "vitalpbx.customerCodes.view", "vitalpbx.customerCodes.create", "vitalpbx.customerCodes.update", "vitalpbx.customerCodes.delete",
    "vitalpbx.aiApiKeys.view", "vitalpbx.aiApiKeys.create", "vitalpbx.aiApiKeys.update", "vitalpbx.aiApiKeys.delete",
    "vitalpbx.sync.run", "vitalpbx.sync.viewHealth", "vitalpbx.logs.view", "vitalpbx.featureFlags.view"
  ]),
  ADMIN: new Set<VitalPbxPermission>([
    "vitalpbx.connection.view", "vitalpbx.connection.test",
    "vitalpbx.tenants.view", "vitalpbx.tenants.switchContext",
    "vitalpbx.extensions.view", "vitalpbx.extensions.create", "vitalpbx.extensions.update", "vitalpbx.extensions.delete", "vitalpbx.extensions.viewRegistration", "vitalpbx.extensions.viewAccountCodes",
    "vitalpbx.inboundRoutes.view", "vitalpbx.inboundRoutes.create", "vitalpbx.inboundRoutes.update",
    "vitalpbx.outboundRoutes.view", "vitalpbx.outboundRoutes.create", "vitalpbx.outboundRoutes.update",
    "vitalpbx.ivr.view", "vitalpbx.ivr.create", "vitalpbx.ivr.update",
    "vitalpbx.ringGroups.view", "vitalpbx.ringGroups.create", "vitalpbx.ringGroups.update",
    "vitalpbx.queues.view", "vitalpbx.queues.create", "vitalpbx.queues.update", "vitalpbx.queues.delete", "vitalpbx.queues.agentControl",
    "vitalpbx.cdr.view", "vitalpbx.cdr.export", "vitalpbx.cdr.sync",
    "vitalpbx.recordings.view", "vitalpbx.recordings.download",
    "vitalpbx.voicemail.view", "vitalpbx.voicemail.download", "vitalpbx.voicemail.updateSettings",
    "vitalpbx.accountCodes.view",
    "vitalpbx.authorizationCodes.view", "vitalpbx.authorizationCodes.create", "vitalpbx.authorizationCodes.update",
    "vitalpbx.customerCodes.view", "vitalpbx.customerCodes.create", "vitalpbx.customerCodes.update",
    "vitalpbx.aiApiKeys.view", "vitalpbx.aiApiKeys.create", "vitalpbx.aiApiKeys.update",
    "vitalpbx.sync.run", "vitalpbx.sync.viewHealth", "vitalpbx.featureFlags.view"
  ]),
  BILLING: new Set<VitalPbxPermission>([
    "vitalpbx.tenants.view", "vitalpbx.tenants.switchContext",
    "vitalpbx.extensions.view", "vitalpbx.extensions.viewAccountCodes",
    "vitalpbx.cdr.view", "vitalpbx.cdr.export",
    "vitalpbx.accountCodes.view",
    "vitalpbx.authorizationCodes.view",
    "vitalpbx.customerCodes.view",
    "vitalpbx.featureFlags.view"
  ]),
  MESSAGING: new Set<VitalPbxPermission>([
    "vitalpbx.extensions.view", "vitalpbx.extensions.viewRegistration",
    "vitalpbx.queues.view", "vitalpbx.queues.create", "vitalpbx.queues.update", "vitalpbx.queues.agentControl",
    "vitalpbx.cdr.view",
    "vitalpbx.voicemail.view",
    "vitalpbx.customerCodes.view",
    "vitalpbx.sync.viewHealth"
  ]),
  SUPPORT: new Set<VitalPbxPermission>([
    "vitalpbx.extensions.view", "vitalpbx.extensions.viewRegistration",
    "vitalpbx.queues.view", "vitalpbx.cdr.view",
    "vitalpbx.recordings.view", "vitalpbx.voicemail.view",
    "vitalpbx.sync.viewHealth"
  ]),
  READ_ONLY: new Set<VitalPbxPermission>([
    "vitalpbx.connection.view",
    "vitalpbx.tenants.view",
    "vitalpbx.extensions.view",
    "vitalpbx.inboundRoutes.view",
    "vitalpbx.outboundRoutes.view",
    "vitalpbx.ivr.view",
    "vitalpbx.ringGroups.view",
    "vitalpbx.queues.view",
    "vitalpbx.cdr.view",
    "vitalpbx.recordings.view",
    "vitalpbx.voicemail.view",
    "vitalpbx.accountCodes.view",
    "vitalpbx.authorizationCodes.view",
    "vitalpbx.customerCodes.view",
    "vitalpbx.aiApiKeys.view",
    "vitalpbx.sync.viewHealth",
    "vitalpbx.logs.view",
    "vitalpbx.featureFlags.view"
  ]),
  USER: new Set<VitalPbxPermission>([
    "vitalpbx.extensions.view", "vitalpbx.cdr.view", "vitalpbx.voicemail.view"
  ])
};

function hasVitalPbxPermission(user: JwtUser, permission: VitalPbxPermission): boolean {
  const role = (user.role || "USER") as StaffRole;
  const set = VITALPBX_ROLE_PERMISSIONS[role] || VITALPBX_ROLE_PERMISSIONS.USER;
  return set.has(permission);
}

type VitalResourceAction = "view" | "create" | "update" | "delete";
type VitalResourcePermissionName =
  | "extensions"
  | "trunks"
  | "ring-groups"
  | "queues"
  | "ivr"
  | "routes"
  | "tenants"
  | "users"
  | "roles"
  | "cdr"
  | "devices"
  | "device-profiles"
  | "destinations"
  | "classes-of-services"
  | "conferences"
  | "phonebooks"
  | "route-selections"
  | "account-codes"
  | "authorization-codes"
  | "customer-codes"
  | "ai-api-keys"
  | "sms"
  | "whatsapp"
  | "virtual-faxes"
  | "voicemail"
  | "parking-lots";

function canAccessVitalResourceAction(user: JwtUser, resource: VitalResourcePermissionName, action: VitalResourceAction): boolean {
  const permissionFor = (r: VitalResourcePermissionName, a: VitalResourceAction): VitalPbxPermission | null => {
    if (r === "extensions") {
      if (a === "view") return "vitalpbx.extensions.view";
      if (a === "create") return "vitalpbx.extensions.create";
      if (a === "update") return "vitalpbx.extensions.update";
      return "vitalpbx.extensions.delete";
    }
    if (r === "routes") return a === "view" ? "vitalpbx.outboundRoutes.view" : a === "create" ? "vitalpbx.outboundRoutes.create" : a === "update" ? "vitalpbx.outboundRoutes.update" : "vitalpbx.outboundRoutes.delete";
    if (r === "ivr") return a === "view" ? "vitalpbx.ivr.view" : a === "create" ? "vitalpbx.ivr.create" : a === "update" ? "vitalpbx.ivr.update" : "vitalpbx.ivr.delete";
    if (r === "ring-groups") return a === "view" ? "vitalpbx.ringGroups.view" : a === "create" ? "vitalpbx.ringGroups.create" : a === "update" ? "vitalpbx.ringGroups.update" : "vitalpbx.ringGroups.delete";
    if (r === "queues") return a === "view" ? "vitalpbx.queues.view" : a === "create" ? "vitalpbx.queues.create" : a === "update" ? "vitalpbx.queues.update" : "vitalpbx.queues.delete";
    if (r === "cdr") return a === "view" ? "vitalpbx.cdr.view" : null;
    if (r === "voicemail") return a === "view" ? "vitalpbx.voicemail.view" : a === "delete" ? "vitalpbx.voicemail.delete" : "vitalpbx.voicemail.updateSettings";
    if (r === "account-codes") return a === "view" ? "vitalpbx.accountCodes.view" : null;
    if (r === "authorization-codes") return a === "view" ? "vitalpbx.authorizationCodes.view" : a === "create" ? "vitalpbx.authorizationCodes.create" : a === "update" ? "vitalpbx.authorizationCodes.update" : "vitalpbx.authorizationCodes.delete";
    if (r === "customer-codes") return a === "view" ? "vitalpbx.customerCodes.view" : a === "create" ? "vitalpbx.customerCodes.create" : a === "update" ? "vitalpbx.customerCodes.update" : "vitalpbx.customerCodes.delete";
    if (r === "ai-api-keys") return a === "view" ? "vitalpbx.aiApiKeys.view" : a === "create" ? "vitalpbx.aiApiKeys.create" : a === "update" ? "vitalpbx.aiApiKeys.update" : "vitalpbx.aiApiKeys.delete";
    if (r === "tenants") return a === "view" ? "vitalpbx.tenants.view" : a === "create" ? "vitalpbx.tenants.create" : a === "update" ? "vitalpbx.tenants.update" : "vitalpbx.tenants.delete";
    if (r === "trunks" || r === "users" || r === "roles" || r === "devices" || r === "device-profiles" || r === "destinations" || r === "classes-of-services" || r === "conferences" || r === "phonebooks" || r === "route-selections" || r === "parking-lots" || r === "virtual-faxes" || r === "sms" || r === "whatsapp") {
      return a === "view" ? "vitalpbx.extensions.view" : "vitalpbx.extensions.update";
    }
    return null;
  };
  const p = permissionFor(resource, action);
  if (!p) return false;
  return hasVitalPbxPermission(user, p);
}

async function requirePermission(req: any, reply: any, checker: (user: JwtUser) => boolean): Promise<JwtUser | null> {
  const user = getUser(req);
  if (!checker(user)) {
    reply.status(403).send({ error: "forbidden" });
    return null;
  }
  return user;
}

async function requireAdmin(req: any, reply: any): Promise<JwtUser | null> {
  return requirePermission(req, reply, (user) => isRole(user, ["ADMIN", "SUPER_ADMIN"]));
}

async function requireSuperAdmin(req: any, reply: any): Promise<JwtUser | null> {
  return requirePermission(req, reply, canAccessAdminSbc);
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

function signMediaTestToken(input: { runId: string; tokenId: string; tenantId: string; userId: string; expMs: number }): string {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  const sig = createHmac("sha256", mediaTestTokenSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyMediaTestToken(token: string): null | { runId: string; tokenId: string; tenantId: string; userId: string; expMs: number } {
  const t = String(token || "").trim();
  const idx = t.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = t.slice(0, idx);
  const sig = t.slice(idx + 1);
  const expected = createHmac("sha256", mediaTestTokenSecret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length != expected.length) return null;
  if (!timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed?.runId || !parsed?.tokenId || !parsed?.tenantId || !parsed?.userId || !parsed?.expMs) return null;
    if (Number(parsed.expMs) < Date.now()) return null;
    return {
      runId: String(parsed.runId),
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

function isMediaTestRecentlyPassed(tenant: any): boolean {
  if (!tenant || tenant.mediaTestStatus !== "PASSED" || !tenant.mediaTestedAt) return false;
  return new Date(tenant.mediaTestedAt).getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1000;
}

function parseMetricsRange(input: unknown): { label: "24h" | "7d"; since: Date } {
  const normalized = String(input || "24h").toLowerCase();
  if (normalized === "7d") return { label: "7d", since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
  return { label: "24h", since: new Date(Date.now() - 24 * 60 * 60 * 1000) };
}

async function getMediaMetricsForTenant(tenantId: string, since: Date): Promise<any> {
  const [mediaRuns, turnRuns] = await Promise.all([
    db.mediaTestRun.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { status: true, details: true, createdAt: true } }),
    db.turnValidationJob.findMany({ where: { tenantId, requestedAt: { gte: since } }, select: { hasRelay: true, errorCode: true } })
  ]);

  let passed = 0;
  let failed = 0;
  let relayTrueCount = 0;
  let relayFalseCount = 0;
  const errorCounts = new Map<string, number>();

  for (const row of mediaRuns as any[]) {
    if (row.status === "PASSED") passed += 1;
    if (row.status === "FAILED") failed += 1;
    const details: any = row.details || {};
    const hasRelay = details?.hasRelay;
    if (hasRelay === true) relayTrueCount += 1;
    if (hasRelay === false) relayFalseCount += 1;
    const err = String(details?.errorCode || "").trim();
    if (err) errorCounts.set(err, (errorCounts.get(err) || 0) + 1);
  }

  for (const row of turnRuns as any[]) {
    if (row.hasRelay === true) relayTrueCount += 1;
    if (row.hasRelay === false) relayFalseCount += 1;
    const err = String(row.errorCode || "").trim();
    if (err) errorCounts.set(err, (errorCounts.get(err) || 0) + 1);
  }

  const topErrorCodes = Array.from(errorCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalMediaTests: mediaRuns.length,
    passed,
    failed,
    relayTrueCount,
    relayFalseCount,
    topErrorCodes
  };
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

async function dockerExecCheck(container: string, command: string, timeoutMs = 2500): Promise<boolean | null> {
  try {
    await execFileAsync("docker", ["exec", container, "sh", "-lc", command], { timeout: timeoutMs });
    return true;
  } catch (e: any) {
    const code = Number(e?.code || 1);
    if (!Number.isNaN(code)) return false;
    return null;
  }
}

async function getOrCreateSbcConfig(): Promise<any> {
  const existing = await db.sbcConfig.findUnique({ where: { id: "default" } });
  if (existing) return existing;
  return db.sbcConfig.create({
    data: {
      id: "default",
      mode: "LOCAL",
      remoteUpstreamHost: null,
      remoteUpstreamPort: 7443
    }
  });
}

function isSafeRemoteUpstreamHost(input: string): boolean {
  if (!input) return false;
  if (input.includes("://") || input.includes("/") || /\s/.test(input)) return false;
  return /^[a-zA-Z0-9.-]+$/.test(input);
}

function resolveSbcTarget(config: any): { mode: "LOCAL" | "REMOTE"; host: string; port: number; proxyUrl: string } {
  const mode = config?.mode === "REMOTE" ? "REMOTE" : "LOCAL";
  const port = Number(config?.remoteUpstreamPort || 7443);
  if (mode === "REMOTE") {
    const host = String(config?.remoteUpstreamHost || "").trim().toLowerCase();
    return { mode, host, port, proxyUrl: `https://${host}:${port}` };
  }
  return { mode, host: "127.0.0.1", port, proxyUrl: `https://127.0.0.1:${port}` };
}

function buildSbcUpstreamConf(target: { host: string; port: number }): string {
  return [
    "upstream sbc_upstream {",
    `    server ${target.host}:${target.port};`,
    "    keepalive 16;",
    "}",
    ""
  ].join("\n");
}

function ensureSipProxyUsesNamedUpstream(siteContent: string): { content: string; changed: boolean } {
  const blockMatch = siteContent.match(/location\s+\/sip\s*\{[\s\S]*?\n\s*\}/m);
  if (!blockMatch) throw new Error("SIP_LOCATION_NOT_FOUND");

  const currentBlock = blockMatch[0];
  if (currentBlock.includes("proxy_pass https://sbc_upstream;")) {
    return { content: siteContent, changed: false };
  }

  const updatedBlock = currentBlock.replace(/proxy_pass\s+https?:\/\/[^\s;]+;/, "proxy_pass https://sbc_upstream;");
  if (updatedBlock == currentBlock) throw new Error("SIP_PROXY_PASS_NOT_FOUND");

  return {
    content: siteContent.replace(currentBlock, updatedBlock),
    changed: true
  };
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tempPath, content, { encoding: "utf8" });
  await fsp.rename(tempPath, filePath);
}

async function restoreFile(filePath: string, previous: string | null): Promise<void> {
  if (previous === null) {
    try {
      await fsp.unlink(filePath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    return;
  }
  await writeFileAtomic(filePath, previous);
}

async function testNginxConfig(): Promise<void> {
  await execFileAsync("nginx", ["-t"], { timeout: 5000 });
}

async function reloadNginx(): Promise<void> {
  try {
    await execFileAsync("systemctl", ["reload", "nginx"], { timeout: 5000 });
    return;
  } catch {
    await execFileAsync("nginx", ["-s", "reload"], { timeout: 5000 });
  }
}

async function applyNginxSbcTarget(config: any): Promise<{ target: { mode: "LOCAL" | "REMOTE"; host: string; port: number; proxyUrl: string }; sipProxyUpdated: boolean }> {
  const target = resolveSbcTarget(config);
  if (!target.host || !Number.isFinite(target.port)) throw new Error("INVALID_SBC_TARGET");

  const previousUpstream = await readOptionalFile(sbcUpstreamConfPath);
  const previousSite = await fsp.readFile(nginxConnectcommsSitePath, "utf8");
  const siteResult = ensureSipProxyUsesNamedUpstream(previousSite);

  try {
    if (siteResult.changed) {
      await writeFileAtomic(nginxConnectcommsSitePath, siteResult.content);
    }
    await writeFileAtomic(sbcUpstreamConfPath, buildSbcUpstreamConf(target));
    await testNginxConfig();
    await reloadNginx();
    return { target, sipProxyUpdated: siteResult.changed };
  } catch (e) {
    await restoreFile(sbcUpstreamConfPath, previousUpstream).catch(() => undefined);
    await writeFileAtomic(nginxConnectcommsSitePath, previousSite).catch(() => undefined);
    throw e;
  }
}

async function probeNginxSipProxy(): Promise<boolean> {
  try {
    const res = await fetch("https://app.connectcomunications.com/sip", {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "U0JDUmVhZGluZXNzVGVzdA==",
        "Sec-WebSocket-Version": "13",
        Origin: "https://app.connectcomunications.com"
      }
    });
    const wsHdr = String(res.headers.get("sec-websocket-version") || "").trim();
    if (wsHdr) return true;
    return res.status >= 100 && res.status < 500 && res.status !== 404;
  } catch {
    return false;
  }
}


async function probeRemoteWsEndpoint(host: string, port: number, timeoutMs = 3500): Promise<{ ok: boolean; latencyMs: number | null }> {
  const startedAt = Date.now();
  const url = `https://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "UmVtb3RlU2JjV3NUZXN0",
        "Sec-WebSocket-Version": "13",
        Origin: "https://app.connectcomunications.com"
      }
    });
    clearTimeout(timer);
    const wsHdr = String(res.headers.get("sec-websocket-version") || "").trim();
    const ok = !!wsHdr || (res.status >= 100 && res.status < 500 && res.status !== 404);
    return { ok, latencyMs: Date.now() - startedAt };
  } catch {
    clearTimeout(timer);
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}

async function probeSbcReadiness(configOverride?: any): Promise<any> {
  const sbcConfig = configOverride || await getOrCreateSbcConfig();
  const target = resolveSbcTarget(sbcConfig);
  const nginxSipProxyOk = await probeNginxSipProxy();
  const lastProbeAt = new Date();

  if (target.mode === "REMOTE") {
    const remoteTcpOk = target.host ? await tcpProbe(target.host, target.port, 2000) : false;
    const remoteWsProbe = target.host ? await probeRemoteWsEndpoint(target.host, target.port, 4000) : { ok: false, latencyMs: null };
    return {
      ok: true,
      mode: target.mode,
      probes: {
        nginxSipProxy: nginxSipProxyOk ? "OK" : "FAIL",
        kamailioUp: "SKIPPED",
        rtpengineUp: "SKIPPED",
        rtpengineControlReachableFromKamailio: "SKIPPED",
        pbxReachableFromKamailio: "SKIPPED",
        remoteUpstreamReachable: remoteTcpOk ? "OK" : "FAIL",
        remoteWsOk: !!remoteWsProbe.ok,
        remoteTcpOk: !!remoteTcpOk,
        remoteProbeLatencyMs: remoteWsProbe.latencyMs,
        lastProbeAt
      },
      targets: {
        activeUpstream: target.proxyUrl,
        remoteUpstreamHost: maskHostLabel(target.host || ""),
        remoteUpstreamPort: target.port
      }
    };
  }

  const status = await probeSbcStatus();
  const rtpFromKam = await dockerExecCheck(
    sbcKamailioContainer,
    `command -v nc >/dev/null 2>&1 && (nc -z -u -w2 ${sbcRtpengineHost} ${sbcRtpengineCtrlPort} >/dev/null 2>&1 || nc -z -w2 ${sbcRtpengineHost} ${sbcRtpengineCtrlPort} >/dev/null 2>&1)`
  );
  const pbxFromKam = await dockerExecCheck(
    sbcKamailioContainer,
    `command -v nc >/dev/null 2>&1 && nc -z -w2 ${sbcPbxHost} ${sbcPbxPort} >/dev/null 2>&1`
  );

  const toState = (ok: boolean | null) => ok ? "OK" : "FAIL";

  return {
    ok: true,
    mode: target.mode,
    probes: {
      nginxSipProxy: nginxSipProxyOk ? "OK" : "FAIL",
      kamailioUp: status.kamailio === "UP" ? "OK" : "FAIL",
      rtpengineUp: status.rtpengine === "UP" ? "OK" : "FAIL",
      rtpengineControlReachableFromKamailio: toState(rtpFromKam),
      pbxReachableFromKamailio: toState(pbxFromKam),
      remoteUpstreamReachable: "SKIPPED",
      remoteWsOk: null,
      remoteTcpOk: null,
      remoteProbeLatencyMs: null,
      lastProbeAt
    },
    targets: {
      activeUpstream: target.proxyUrl,
      kamailioHost: maskHostLabel(sbcKamailioHost),
      rtpengineHost: maskHostLabel(sbcRtpengineHost),
      pbxHost: maskHostLabel(sbcPbxHost),
      pbxPort: sbcPbxPort
    }
  };
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

  const [status, sbcConfig] = await Promise.all([probeSbcStatus(), getOrCreateSbcConfig()]);
  const target = resolveSbcTarget(sbcConfig);
  const maskedActiveUpstream = target.mode === "REMOTE"
    ? `https://${maskHostLabel(target.host)}:${target.port}`
    : target.proxyUrl;

  return {
    ok: true,
    route: { publicPath: "/sip", publicSipWsUrl: "wss://app.connectcomunications.com/sip" },
    mode: target.mode,
    activeUpstream: maskedActiveUpstream,
    services: {
      kamailio: target.mode === "LOCAL" ? status.kamailio : "SKIPPED",
      rtpengine: target.mode === "LOCAL" ? status.rtpengine : "SKIPPED",
      pbxViaSbc: target.mode === "LOCAL" ? status.pbx_via_sbc : "SKIPPED"
    },
    targets: {
      kamailioHost: maskHostLabel(sbcKamailioHost),
      rtpengineHost: maskHostLabel(sbcRtpengineHost),
      pbxHost: maskHostLabel(sbcPbxHost),
      pbxPort: sbcPbxPort,
      remoteUpstreamHost: target.mode === "REMOTE" ? maskHostLabel(target.host) : null,
      remoteUpstreamPort: target.mode === "REMOTE" ? target.port : null
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

// Unauthenticated — used by mobile app to log in AND provision via QR scan in one step.
// The QR code contains a short-lived HMAC-signed token issued by POST /voice/mobile-provisioning/token.
// Returns a full mobile session JWT + SIP provisioning bundle, eliminating the need for
// the mobile app to already be authenticated before provisioning.
app.post("/auth/mobile-qr-exchange", async (req, reply) => {
  const input = z.object({
    token: z.string().min(12),
    deviceInfo: z.object({
      platform: z.enum(["IOS", "ANDROID"]).optional(),
      deviceName: z.string().max(128).optional(),
      expoPushToken: z.string().optional(),
      voipPushToken: z.string().optional(),
    }).optional(),
  }).parse(req.body || {});

  // Rate-limit by token hash to prevent brute-force without leaking the token
  const tokenHash = hashToken(input.token);
  if (!checkBillingRateLimit(`qr-exchange:${tokenHash.slice(0, 16)}`, 5, 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  // Verify HMAC signature and expiry embedded in the token
  const verified = verifyMobileProvisioningToken(input.token);
  if (!verified) return reply.status(400).send({ error: "TOKEN_INVALID" });

  // Fetch the stored token record
  const tokenRow = await db.mobileProvisioningToken.findFirst({
    where: { tokenHash, tenantId: verified.tenantId, userId: verified.userId }
  });
  if (!tokenRow) return reply.status(400).send({ error: "TOKEN_INVALID" });
  if (tokenRow.usedAt) return reply.status(400).send({ error: "TOKEN_ALREADY_USED" });

  const now = new Date();
  if (tokenRow.expiresAt < now) return reply.status(400).send({ error: "TOKEN_EXPIRED" });

  // Atomically consume the token (race-safe)
  const consume = await db.mobileProvisioningToken.updateMany({
    where: { id: tokenRow.id, usedAt: null, expiresAt: { gte: now } },
    data: { usedAt: now }
  });
  if (consume.count === 0) {
    const latest = await db.mobileProvisioningToken.findUnique({ where: { id: tokenRow.id } });
    if (latest?.usedAt) return reply.status(400).send({ error: "TOKEN_ALREADY_USED" });
    return reply.status(400).send({ error: "TOKEN_EXPIRED" });
  }

  // Load user from DB to build a proper JwtUser for provisioning
  const dbUser = await db.user.findUnique({ where: { id: verified.userId } });
  if (!dbUser || dbUser.tenantId !== verified.tenantId) {
    return reply.status(400).send({ error: "USER_NOT_FOUND" });
  }
  const jwtUser: JwtUser = { sub: dbUser.id, tenantId: dbUser.tenantId, email: dbUser.email, role: dbUser.role };

  // Issue SIP provisioning (resets SIP password on PBX, returns credentials)
  let out: { sipPassword: string; provisioning: any; pbxExtensionLinkId: string };
  try {
    out = await issueOneTimeProvisioningForUser(jwtUser);
  } catch (e: any) {
    const code = String(e?.message || "VOICE_PROVISIONING_FAILED");
    return reply.status(code === "EXTENSION_NOT_ASSIGNED" ? 404 : 400).send({ error: code });
  }

  // Sign a full mobile session token (same shape as /auth/login)
  const sessionToken = await reply.jwtSign({ sub: dbUser.id, tenantId: dbUser.tenantId, email: dbUser.email, role: dbUser.role });

  // Upsert MobileDevice if push token provided (device can also register later via /mobile/devices/register)
  let deviceId: string | null = null;
  if (input.deviceInfo?.expoPushToken && input.deviceInfo?.platform) {
    const device = await db.mobileDevice.upsert({
      where: { expoPushToken: input.deviceInfo.expoPushToken },
      create: {
        tenantId: dbUser.tenantId,
        userId: dbUser.id,
        platform: input.deviceInfo.platform,
        expoPushToken: input.deviceInfo.expoPushToken,
        voipPushToken: input.deviceInfo.voipPushToken ?? null,
        deviceName: input.deviceInfo.deviceName ?? null,
        lastSeenAt: now,
      },
      update: {
        userId: dbUser.id,
        tenantId: dbUser.tenantId,
        voipPushToken: input.deviceInfo.voipPushToken ?? undefined,
        deviceName: input.deviceInfo.deviceName ?? undefined,
        lastSeenAt: now,
      },
    });
    deviceId = device.id;
  }

  await audit({
    tenantId: dbUser.tenantId,
    actorUserId: dbUser.id,
    action: "MOBILE_QR_EXCHANGE",
    entityType: "MobileProvisioningToken",
    entityId: tokenRow.id,
  });

  return {
    sessionToken,
    sipPassword: out.sipPassword,
    provisioning: out.provisioning,
    deviceId,
    user: { id: dbUser.id, email: dbUser.email, role: dbUser.role },
  };
});

// TEMPORARY: short-lived SUPER_ADMIN JWT for read-only observation scripts (no DB / no user creation).
// Remove after PBX↔Connect observation. Gated by NODE_ENV=development or DEV_OBSERVE_TOKEN_SECRET.
app.post("/admin/dev/generate-observe-token", async (req, reply) => {
  if (!canIssueDevObserveJwt({ headers: req.headers as Record<string, unknown>, body: req.body })) {
    return reply.status(404).send({ error: "not_found" });
  }
  const input = z
    .object({
      expiresMinutes: z.number().int().min(5).max(120).optional(),
      secret: z.string().optional(),
    })
    .parse(req.body || {});
  const minutes = Math.min(120, Math.max(5, input.expiresMinutes ?? 90));
  const expiresInSeconds = minutes * 60;
  const token = await reply.jwtSign(
    {
      sub: "dev-observe-token",
      tenantId: "global",
      email: "observe@dev.internal",
      role: "SUPER_ADMIN",
    },
    { sign: { expiresIn: expiresInSeconds } },
  );
  return { token };
});

app.addHook("preHandler", async (req, reply) => {
  const path = req.url.split("?")[0];
  // Reverse proxies often mount the API under a prefix (e.g. /api/...); req.url keeps that prefix.
  const isDevObserveTokenPath =
    path === "/admin/dev/generate-observe-token" || path.endsWith("/admin/dev/generate-observe-token");
  const isInternalCdrIngestPath =
    path === "/internal/cdr-ingest" || path.endsWith("/internal/cdr-ingest");
  if (
    path.includes("/webhooks/pbx")
    || path.startsWith("/billing/invoices/pay/")
    || isDevObserveTokenPath
    || isInternalCdrIngestPath
    || [
        "/health",
        "/auth/signup",
        "/auth/login",
        "/auth/mobile-qr-exchange",
        "/webhooks/twilio/sms-status",
        "/webhooks/sola-cardknox",
        "/webhooks/whatsapp/meta",
        "/webhooks/whatsapp/twilio/status"
      ].includes(path)
  ) return;
  try {
    await req.jwtVerify();
  } catch {
    return reply.status(401).send({ error: "unauthorized" });
  }
  // SUPER_ADMIN VitalPBX tenant context override.
  // When the frontend sends x-tenant-context: vpbx:{slug}, the backend bypasses the
  // tenantPbxLink lookup and scopes PBX API calls directly to that VitalPBX tenant.
  const user = req.user as JwtUser;
  if (user?.role === "SUPER_ADMIN") {
    const ctx = String((req.headers as any)["x-tenant-context"] || "").trim();
    if (ctx.startsWith("vpbx:")) {
      (req as any).pbxTenantOverride = ctx.slice(5); // e.g., "a_plus_center"
    }
  }
});

app.get("/me", async (req) => {
  const user = getUser(req);
  return { id: user.sub, tenantId: user.tenantId, email: user.email, role: user.role };
});

app.get("/admin/users", async (req, reply) => {
  const admin = await requirePermission(req, reply, (user) => isRole(user, ["SUPER_ADMIN", "ADMIN"]));
  if (!admin) return;
  return db.user.findMany({
    where: { tenantId: admin.tenantId },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, createdAt: true }
  });
});

app.post("/admin/users/:id/role", async (req, reply) => {
  const admin = await requirePermission(req, reply, (user) => isRole(user, ["SUPER_ADMIN", "ADMIN"]));
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    role: z.enum(["SUPER_ADMIN", "ADMIN", "BILLING", "MESSAGING", "SUPPORT", "READ_ONLY", "USER"])
  }).parse(req.body || {});
  const target = await db.user.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!target) return reply.status(404).send({ error: "user_not_found" });
  if (admin.role !== "SUPER_ADMIN" && input.role === "SUPER_ADMIN") {
    return reply.status(403).send({ error: "forbidden" });
  }
  const updated = await db.user.update({ where: { id: target.id }, data: { role: input.role } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "USER_ROLE_UPDATED", entityType: "User", entityId: updated.id });
  return { ok: true, user: { id: updated.id, email: updated.email, role: updated.role } };
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

app.get("/settings/providers/whatsapp", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageMessaging);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const rows = await db.whatsAppProviderConfig.findMany({ where: { tenantId: admin.tenantId }, orderBy: { updatedAt: "desc" } });
  const items: any[] = [];
  for (const row of rows) {
    try {
      const creds = decryptJson<any>(row.credentialsEncrypted);
      items.push(maskWhatsAppConfigForResponse(row, creds));
    } catch {
      items.push({ provider: row.provider, isEnabled: !!row.isEnabled, preview: {}, settings: row.settings || {}, updatedAt: row.updatedAt, lastTestAt: row.lastTestAt, lastTestResult: row.lastTestResult || null, lastTestErrorCode: row.lastTestErrorCode || "DECRYPT_FAILED" });
    }
  }

  const active = items.find((x) => x?.isEnabled) || null;
  return { providers: items, activeProvider: active?.provider || null };
});

app.put("/settings/providers/whatsapp/twilio", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageMessaging);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({
    accountSid: z.string().min(6),
    authToken: z.string().min(6),
    fromWhatsAppNumber: z.string().min(5).optional(),
    messagingServiceSid: z.string().min(5).optional(),
    statusWebhookPath: z.string().min(1).optional()
  }).parse(req.body || {});

  const provider: WhatsAppProviderName = "WHATSAPP_TWILIO";
  const creds: WhatsAppTwilioCredentialPayload = {
    accountSid: input.accountSid,
    authToken: input.authToken,
    fromWhatsAppNumber: input.fromWhatsAppNumber,
    messagingServiceSid: input.messagingServiceSid
  };

  const encrypted = encryptJson(creds);
  const existing = await db.whatsAppProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider } } });
  const saved = await db.whatsAppProviderConfig.upsert({
    where: { tenantId_provider: { tenantId: admin.tenantId, provider } },
    create: {
      tenantId: admin.tenantId,
      provider,
      isEnabled: false,
      settings: { statusWebhookPath: input.statusWebhookPath || "/webhooks/whatsapp/twilio/status" } as any,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      createdByUserId: admin.sub,
      updatedByUserId: admin.sub,
      lastTestResult: null,
      lastTestErrorCode: null,
      lastTestAt: null
    },
    update: {
      isEnabled: false,
      settings: { statusWebhookPath: input.statusWebhookPath || "/webhooks/whatsapp/twilio/status" } as any,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      updatedByUserId: admin.sub,
      lastTestResult: null,
      lastTestErrorCode: null,
      lastTestAt: null
    }
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: existing ? "WHATSAPP_CREDENTIAL_UPDATED" : "WHATSAPP_CREDENTIAL_CREATED", entityType: "WhatsAppProviderConfig", entityId: saved.id });
  return { ok: true, provider: "WHATSAPP_TWILIO", isEnabled: saved.isEnabled };
});

app.put("/settings/providers/whatsapp/meta", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageMessaging);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({
    phoneNumberId: z.string().min(3),
    wabaId: z.string().min(3),
    accessToken: z.string().min(8),
    verifyToken: z.string().min(4),
    appSecret: z.string().min(4).optional(),
    webhookSecret: z.string().min(4).optional(),
    webhookPath: z.string().min(1).optional()
  }).parse(req.body || {});

  const provider: WhatsAppProviderName = "WHATSAPP_META";
  const creds: WhatsAppMetaCredentialPayload = {
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    accessToken: input.accessToken,
    verifyToken: input.verifyToken,
    appSecret: input.appSecret || null,
    webhookSecret: input.webhookSecret || null
  };

  const encrypted = encryptJson(creds);
  const existing = await db.whatsAppProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider } } });
  const saved = await db.whatsAppProviderConfig.upsert({
    where: { tenantId_provider: { tenantId: admin.tenantId, provider } },
    create: {
      tenantId: admin.tenantId,
      provider,
      isEnabled: false,
      settings: { webhookPath: input.webhookPath || "/webhooks/whatsapp/meta" } as any,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      createdByUserId: admin.sub,
      updatedByUserId: admin.sub,
      lastTestResult: null,
      lastTestErrorCode: null,
      lastTestAt: null
    },
    update: {
      isEnabled: false,
      settings: { webhookPath: input.webhookPath || "/webhooks/whatsapp/meta" } as any,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      updatedByUserId: admin.sub,
      lastTestResult: null,
      lastTestErrorCode: null,
      lastTestAt: null
    }
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: existing ? "WHATSAPP_CREDENTIAL_UPDATED" : "WHATSAPP_CREDENTIAL_CREATED", entityType: "WhatsAppProviderConfig", entityId: saved.id });
  return { ok: true, provider: "WHATSAPP_META", isEnabled: saved.isEnabled };
});

app.post("/settings/providers/whatsapp/enable", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageMessaging);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ provider: z.enum(["WHATSAPP_TWILIO", "WHATSAPP_META"]) }).parse(req.body || {});
  const row = await db.whatsAppProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: input.provider } } });
  if (!row) return reply.status(404).send({ error: "provider_not_configured" });

  await db.whatsAppProviderConfig.updateMany({ where: { tenantId: admin.tenantId }, data: { isEnabled: false, updatedByUserId: admin.sub } });
  const updated = await db.whatsAppProviderConfig.update({ where: { id: row.id }, data: { isEnabled: true, updatedByUserId: admin.sub } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "WHATSAPP_CREDENTIAL_ENABLED", entityType: "WhatsAppProviderConfig", entityId: updated.id });
  return { ok: true, provider: updated.provider, isEnabled: true };
});

app.post("/settings/providers/whatsapp/disable", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageMessaging);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ provider: z.enum(["WHATSAPP_TWILIO", "WHATSAPP_META"]) }).parse(req.body || {});
  const row = await db.whatsAppProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: admin.tenantId, provider: input.provider } } });
  if (!row) return reply.status(404).send({ error: "provider_not_configured" });

  const updated = await db.whatsAppProviderConfig.update({ where: { id: row.id }, data: { isEnabled: false, updatedByUserId: admin.sub } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "WHATSAPP_CREDENTIAL_DISABLED", entityType: "WhatsAppProviderConfig", entityId: updated.id });
  return { ok: true, provider: updated.provider, isEnabled: false };
});

app.post("/whatsapp/test-send", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageMessaging);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({ to: z.string().min(8), message: z.string().min(1).max(512) }).parse(req.body || {});
  const active = await getEnabledWhatsAppProvider(admin.tenantId);
  if (!active) return reply.status(400).send({ error: "WHATSAPP_NOT_CONFIGURED" });

  const simulate = (process.env.WHATSAPP_SIMULATE || "true").toLowerCase() !== "false";
  const provider = active.row.provider;
  if (simulate) {
    await db.auditLog.create({ data: { tenantId: admin.tenantId, actorUserId: admin.sub, action: "WHATSAPP_TEST_SEND_SIMULATED", entityType: "Tenant", entityId: admin.tenantId } });
    return { ok: true, provider, simulated: true, to: maskValue(input.to, 2, 2), messageLength: input.message.length };
  }

  await db.auditLog.create({ data: { tenantId: admin.tenantId, actorUserId: admin.sub, action: "WHATSAPP_TEST_SEND_DISPATCHED", entityType: "Tenant", entityId: admin.tenantId } });
  return { ok: true, provider, simulated: false, queued: true };
});

app.get("/settings/whatsapp-routing", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const rows = await db.whatsAppProviderConfig.findMany({ where: { tenantId: admin.tenantId }, select: { provider: true, isEnabled: true, updatedAt: true } });
  return {
    providers: rows,
    activeProvider: rows.find((r) => r.isEnabled)?.provider || null,
    mode: "single_provider_active"
  };
});

app.get("/whatsapp/status", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const [routing, active, lastInbound, failures] = await Promise.all([
    db.whatsAppProviderConfig.findMany({ where: { tenantId: admin.tenantId }, select: { provider: true, isEnabled: true, updatedAt: true, lastTestAt: true, lastTestResult: true, lastTestErrorCode: true } }),
    getEnabledWhatsAppProvider(admin.tenantId),
    db.whatsAppMessage.findFirst({ where: { tenantId: admin.tenantId, direction: "INBOUND" }, orderBy: { createdAt: "desc" } }),
    db.whatsAppMessage.findMany({ where: { tenantId: admin.tenantId, status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 10 })
  ]);

  return {
    enabled: !!active,
    activeProvider: active?.row?.provider || null,
    providers: routing,
    webhookLastSeenAt: lastInbound?.createdAt || null,
    recentFailures: failures.map((f) => ({
      id: f.id,
      threadId: f.threadId,
      status: f.status,
      errorCode: f.errorCode || null,
      createdAt: f.createdAt
    })),
    mode: "single_provider_active"
  };
});

app.get("/whatsapp/messages/recent", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const query = z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    status: z.string().optional(),
    direction: z.enum(["INBOUND", "OUTBOUND"]).optional()
  }).parse(req.query || {});
  const rows = await db.whatsAppMessage.findMany({
    where: {
      tenantId: admin.tenantId,
      status: query.status || undefined,
      direction: query.direction || undefined
    },
    orderBy: { createdAt: "desc" },
    take: query.limit || 50
  });
  return rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    providerType: r.providerType,
    direction: r.direction,
    fromNumber: maskValue(r.fromNumber, 2, 2),
    toNumber: maskValue(r.toNumber, 2, 2),
    bodyPreview: (r.body || "").slice(0, 140),
    status: r.status,
    errorCode: r.errorCode || null,
    createdAt: r.createdAt,
    deliveredAt: r.deliveredAt || null
  }));
});

app.get("/whatsapp/threads", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const query = z.object({
    q: z.string().optional(),
    status: z.string().optional(),
    provider: z.enum(["WHATSAPP_TWILIO", "WHATSAPP_META"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional()
  }).parse(req.query || {});

  const rows = await db.whatsAppThread.findMany({
    where: {
      tenantId: admin.tenantId,
      providerType: query.provider || undefined,
      contactNumber: query.q ? { contains: query.q } : undefined,
      lastStatus: query.status || undefined
    },
    include: {
      customer: { select: { id: true, displayName: true } },
      _count: { select: { messages: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 }
    },
    orderBy: { updatedAt: "desc" },
    take: query.limit || 100
  });

  return rows.map((r) => ({
    id: r.id,
    providerType: r.providerType,
    contactNumberMasked: maskValue(r.contactNumber, 3, 2),
    contactNumberRaw: r.contactNumber,
    contactName: r.contactName || null,
    customerId: r.customerId || null,
    customerName: r.customer?.displayName || null,
    lastMessageAt: r.lastMessageAt,
    lastDirection: r.lastDirection || null,
    lastStatus: r.lastStatus || null,
    lastMessagePreview: r.lastMessagePreview || r.messages[0]?.body?.slice(0, 140) || "",
    messageCount: r._count.messages
  }));
});

app.get("/whatsapp/threads/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const thread = await db.whatsAppThread.findFirst({
    where: { id, tenantId: admin.tenantId },
    include: { customer: { select: { id: true, displayName: true } }, messages: { orderBy: { createdAt: "asc" }, take: 300 } }
  });
  if (!thread) return reply.status(404).send({ error: "thread_not_found" });
  return {
    id: thread.id,
    providerType: thread.providerType,
    contactNumberRaw: thread.contactNumber,
    contactNumberMasked: maskValue(thread.contactNumber, 3, 2),
    contactName: thread.contactName || null,
    customer: thread.customer ? { id: thread.customer.id, displayName: thread.customer.displayName } : null,
    lastMessageAt: thread.lastMessageAt,
    lastStatus: thread.lastStatus || null,
    messages: thread.messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      status: m.status,
      body: m.body,
      fromNumberMasked: maskValue(m.fromNumber, 3, 2),
      toNumberMasked: maskValue(m.toNumber, 3, 2),
      createdAt: m.createdAt,
      deliveredAt: m.deliveredAt || null,
      errorCode: m.errorCode || null
    }))
  };
});

app.post("/whatsapp/threads/:id/send", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageMessaging);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;
  const { id } = req.params as { id: string };
  const input = z.object({ message: z.string().min(1).max(2048) }).parse(req.body || {});

  const thread = await db.whatsAppThread.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!thread) return reply.status(404).send({ error: "thread_not_found" });
  const active = await getEnabledWhatsAppProvider(admin.tenantId);
  if (!active) return reply.status(400).send({ error: "WHATSAPP_NOT_CONFIGURED" });

  const providerType = active.row.provider as WhatsAppProviderName;
  const simulate = (process.env.WHATSAPP_SIMULATE || "true").toLowerCase() !== "false";
  const externalMessageId = simulate ? `wa_sim_${randomBytes(6).toString("hex")}` : `wa_out_${randomBytes(6).toString("hex")}`;
  const senderId = providerType === "WHATSAPP_TWILIO"
    ? String((active.creds as WhatsAppTwilioCredentialPayload).fromWhatsAppNumber || (active.creds as WhatsAppTwilioCredentialPayload).messagingServiceSid || "whatsapp:sender")
    : `meta:${String((active.creds as WhatsAppMetaCredentialPayload).phoneNumberId || "unknown")}`;
  const status = simulate ? "SENT" : "QUEUED";

  const msg = await createWhatsAppMessage({
    tenantId: admin.tenantId,
    threadId: thread.id,
    providerType,
    direction: "OUTBOUND",
    fromNumber: senderId,
    toNumber: thread.contactNumber,
    body: input.message,
    externalMessageId,
    status,
    metadata: { simulated: simulate }
  });
  await db.whatsAppThread.update({
    where: { id: thread.id },
    data: {
      providerType,
      lastDirection: "OUTBOUND",
      lastStatus: status,
      lastMessageAt: new Date(),
      lastMessagePreview: input.message.slice(0, 160)
    }
  });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "WHATSAPP_REPLY_SENT", entityType: "WhatsAppThread", entityId: thread.id });
  return { ok: true, simulated: simulate, threadId: thread.id, messageId: msg.id, status: msg.status };
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
    const [userCount, campaignCount, pbxLink] = await Promise.all([
      db.user.count({ where: { tenantId: t.id } }),
      db.smsCampaign.count({ where: { tenantId: t.id } }),
      db.tenantPbxLink.findUnique({ where: { tenantId: t.id }, select: { pbxTenantId: true, pbxInstanceId: true } }).catch(() => null),
    ]);
    return {
      id: t.id,
      name: t.name,
      pbxTenantId: pbxLink?.pbxTenantId ?? null,
      pbxInstanceId: pbxLink?.pbxInstanceId ?? null,
      isApproved: t.isApproved,
      dailySmsCap: t.dailySmsCap,
      perSecondRate: t.perSecondRate,
      firstCampaignRequiresApproval: t.firstCampaignRequiresApproval,
      stats: { users: userCount, campaigns: campaignCount },
    };
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
  if (!canManageMessaging(user)) return reply.status(403).send({ error: "forbidden" });
  const input = z.object({
    name: z.string().min(2),
    fromNumber: z.string().min(7).optional(),
    fromNumberId: z.string().optional(),
    message: z.string().min(3).max(320),
    audienceType: z.string().default("manual"),
    recipients: z.array(z.string().min(8)).min(1),
    autoSend: z.boolean().default(false)
  }).parse(req.body);

  const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const normalized = normalizeRecipientArray(input.recipients);
  if (normalized.summary.validCount === 0 || normalized.summary.invalidCount > 0) {
    return reply.status(400).send({
      error: {
        code: "INVALID_RECIPIENTS",
        message: "Campaign recipients include invalid phone numbers.",
        details: normalized.summary
      }
    });
  }
  if (normalized.summary.validCount > tenant.maxCampaignSize) {
    return reply.status(400).send({
      error: {
        code: "CAMPAIGN_TOO_LARGE",
        message: "Campaign exceeds tenant max campaign size.",
        details: { recipientCount: normalized.summary.validCount, maxCampaignSize: tenant.maxCampaignSize }
      }
    });
  }
  if (tenant.smsSuspended) {
    return reply.status(400).send({
      error: {
        code: "TENANT_SUSPENDED",
        message: "Tenant SMS sending is suspended.",
        details: { reason: tenant.smsSuspendedReason || null }
      }
    });
  }

  let selectedNumber = null as any;
  if (input.fromNumberId) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { id: input.fromNumberId, tenantId: user.tenantId } });
  } else if (input.fromNumber) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { phoneNumber: input.fromNumber, tenantId: user.tenantId } });
  } else if (tenant.defaultSmsFromNumberId) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { id: tenant.defaultSmsFromNumberId, tenantId: user.tenantId } });
  }

  if (tenant.smsSendMode === "LIVE") {
    if (!selectedNumber) {
      return reply.status(400).send({
        error: { code: "NO_SENDER_NUMBER", message: "You must select an ACTIVE sender number before sending in LIVE mode." }
      });
    }
    if (selectedNumber.status !== "ACTIVE") {
      return reply.status(400).send({
        error: { code: "NO_SENDER_NUMBER", message: "Selected sender number is not ACTIVE." }
      });
    }
    const canSendLive = await enforceBillingForLive(user.tenantId);
    if (!canSendLive) {
      return reply.status(400).send({
        error: { code: "LIVE_MODE_BLOCKED", message: "LIVE mode sending is blocked until billing requirements are met." }
      });
    }
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

  const decision = await decideCampaignPolicy({
    tenant,
    tenantId: user.tenantId,
    actorUserId: user.sub,
    message: input.message,
    recipientsCount: normalized.summary.validCount
  });
  if ("reject" in decision) return reply.status(400).send({ error: decision.reject });

  const shouldAutoSend = !!input.autoSend;
  const campaignStatus = shouldAutoSend ? (forcedNeedsApproval ? "NEEDS_APPROVAL" : decision.status) : "DRAFT";
  const holdReason = shouldAutoSend ? (forcedNeedsApproval ? "SENDER_PROVIDER_MISMATCH" : decision.holdReason) : null;

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
    normalized.normalizedRecipients.map((to) => db.smsMessage.create({ data: { campaignId: campaign.id, toNumber: to, fromNumber: effectiveFrom, fromNumberId: selectedNumber?.id || null, body: decision.normalizedMessage, status: "QUEUED" } }))
  );

  if (campaign.status === "QUEUED") {
    await enqueueCampaignMessages(campaign.id, user.tenantId);
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_QUEUED", entityType: "SmsCampaign", entityId: campaign.id });
  } else if (campaign.status === "NEEDS_APPROVAL") {
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_HELD_FOR_APPROVAL", entityType: "SmsCampaign", entityId: campaign.id });
  } else {
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_DRAFT_CREATED", entityType: "SmsCampaign", entityId: campaign.id });
  }

  return {
    campaign: { ...campaign, uiStatus: toCampaignUiStatus(campaign.status) },
    sender: selectedNumber ? { id: selectedNumber.id, phoneNumber: selectedNumber.phoneNumber, provider: selectedNumber.provider, isDefault: tenant.defaultSmsFromNumberId === selectedNumber.id } : null,
    recipientSummary: normalized.summary,
    queuedMessages: campaign.status === "QUEUED" ? createdMessages.length : 0,
    holdReason: campaign.holdReason
  };
});

app.put("/sms/campaigns/:id", async (req, reply) => {
  const user = getUser(req);
  const { id } = req.params as { id: string };
  const input = z.object({
    name: z.string().min(2).optional(),
    message: z.string().min(3).max(320).optional(),
    recipients: z.array(z.string().min(8)).optional(),
    fromNumber: z.string().min(7).optional(),
    fromNumberId: z.string().optional()
  }).parse(req.body || {});

  const campaign = await db.smsCampaign.findFirst({ where: { id, tenantId: user.tenantId }, include: { messages: true, tenant: true } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
  if (!["DRAFT", "NEEDS_APPROVAL", "FAILED", "PAUSED"].includes(campaign.status)) {
    return reply.status(400).send({ error: "CAMPAIGN_NOT_EDITABLE" });
  }

  let nextMessage = campaign.message;
  if (input.message) {
    const normalized = normalizeSmsWithStop(input.message);
    if (!normalized.ok) return reply.status(400).send({ error: "MESSAGE_TOO_LONG_AFTER_STOP_APPEND" });
    nextMessage = normalized.message;
    if (normalized.appendedStop) {
      await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_STOP_INSTRUCTION_APPENDED", entityType: "SmsCampaign", entityId: id });
    }
  }

  let selectedNumber = null as any;
  if (input.fromNumberId) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { id: input.fromNumberId, tenantId: user.tenantId } });
  } else if (input.fromNumber) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { phoneNumber: input.fromNumber, tenantId: user.tenantId } });
  } else if (campaign.tenant.defaultSmsFromNumberId) {
    selectedNumber = await db.phoneNumber.findFirst({ where: { id: campaign.tenant.defaultSmsFromNumberId, tenantId: user.tenantId } });
  }
  const effectiveFrom = selectedNumber?.phoneNumber || input.fromNumber || campaign.fromNumber || "+15550000000";

  const updateCampaign = await db.smsCampaign.update({
    where: { id },
    data: { name: input.name || campaign.name, message: nextMessage, fromNumber: effectiveFrom }
  });

  let recipientSummary: RecipientNormalizationSummary | null = null;

  if (input.recipients) {
    const normalizedRecipients = normalizeRecipientArray(input.recipients);
    recipientSummary = normalizedRecipients.summary;
    if (recipientSummary.validCount === 0 || recipientSummary.invalidCount > 0) {
      return reply.status(400).send({
        error: {
          code: "INVALID_RECIPIENTS",
          message: "Campaign recipients include invalid phone numbers.",
          details: recipientSummary
        }
      });
    }
    if (recipientSummary.validCount > campaign.tenant.maxCampaignSize) {
      return reply.status(400).send({
        error: {
          code: "CAMPAIGN_TOO_LARGE",
          message: "Campaign exceeds tenant max campaign size.",
          details: { recipientCount: recipientSummary.validCount, maxCampaignSize: campaign.tenant.maxCampaignSize }
        }
      });
    }
    await db.smsMessage.deleteMany({ where: { campaignId: id } });
    await Promise.all(normalizedRecipients.normalizedRecipients.map((to) => db.smsMessage.create({ data: { campaignId: id, toNumber: to, fromNumber: effectiveFrom, fromNumberId: selectedNumber?.id || campaign.messages[0]?.fromNumberId || null, body: nextMessage, status: "QUEUED" } })));
  } else if (input.message) {
    await db.smsMessage.updateMany({ where: { campaignId: id }, data: { body: nextMessage } });
  }
  if (!input.recipients && (input.fromNumber || input.fromNumberId)) {
    await db.smsMessage.updateMany({ where: { campaignId: id }, data: { fromNumber: effectiveFrom, fromNumberId: selectedNumber?.id || null } });
  }

  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_UPDATED", entityType: "SmsCampaign", entityId: id });
  return { campaign: { ...updateCampaign, uiStatus: toCampaignUiStatus(updateCampaign.status) }, recipientSummary };
});

app.post("/sms/campaigns/:id/preview", async (req, reply) => {
  const user = getUser(req);
  const { id } = req.params as { id: string };

  const campaign = await db.smsCampaign.findFirst({ where: { id, tenantId: user.tenantId }, include: { messages: true, tenant: true } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const recipientCount = campaign.messages.length;
  const invalidRecipients = campaign.messages.filter((m) => !isE164(m.toNumber)).map((m) => m.toNumber);
  const senderNumberId = campaign.messages[0]?.fromNumberId || campaign.tenant.defaultSmsFromNumberId || null;
  const sender = senderNumberId ? await db.phoneNumber.findFirst({ where: { id: senderNumberId, tenantId: user.tenantId } }) : null;
  const canSendLive = campaign.tenant.smsSendMode !== "LIVE" ? true : await enforceBillingForLive(user.tenantId);

  const warnings: Array<{ code: string; message: string }> = [];
  if (recipientCount > campaign.tenant.maxCampaignSize) warnings.push({ code: "CAMPAIGN_TOO_LARGE", message: "Recipient count exceeds tenant max campaign size." });
  if (invalidRecipients.length > 0) warnings.push({ code: "INVALID_RECIPIENTS", message: "Campaign contains invalid recipients." });
  if (!sender && campaign.tenant.smsSendMode === "LIVE") warnings.push({ code: "NO_SENDER_NUMBER", message: "Set an ACTIVE sender number before LIVE send." });
  if (campaign.tenant.smsSuspended) warnings.push({ code: "TENANT_SUSPENDED", message: "Tenant SMS sending is suspended." });
  if (!canSendLive) warnings.push({ code: "LIVE_MODE_BLOCKED", message: "LIVE mode blocked until billing requirements are met." });

  const sampleRecipients = campaign.messages.slice(0, 10).map((m) => maskValue(m.toNumber, 2, 2));
  return {
    campaignId: campaign.id,
    status: campaign.status,
    uiStatus: toCampaignUiStatus(campaign.status),
    recipientCount,
    recipientSummary: {
      totalInput: recipientCount,
      validCount: recipientCount - invalidRecipients.length,
      invalidCount: invalidRecipients.length,
      duplicateCount: 0,
      invalidRecipients: invalidRecipients.slice(0, 50)
    },
    sender: sender ? { id: sender.id, phoneNumber: sender.phoneNumber, status: sender.status, provider: sender.provider, isDefault: campaign.tenant.defaultSmsFromNumberId === sender.id } : null,
    sampleRecipients,
    messageLength: campaign.message.length,
    warnings,
    canSend: warnings.length === 0
  };
});

app.post("/sms/campaigns/:id/send", async (req, reply) => {
  const user = getUser(req);
  if (!canAccessCampaignSend(user)) return reply.status(403).send({ error: "forbidden" });
  const { id } = req.params as { id: string };

  const campaign = await db.smsCampaign.findFirst({ where: { id, tenantId: user.tenantId }, include: { messages: true, tenant: true } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
  if (!["DRAFT", "PAUSED", "FAILED", "NEEDS_APPROVAL"].includes(campaign.status)) {
    return reply.status(400).send({ error: "CAMPAIGN_NOT_SENDABLE" });
  }

  if (campaign.tenant.smsSuspended) {
    return reply.status(400).send({ error: { code: "TENANT_SUSPENDED", message: "Tenant SMS sending is suspended." } });
  }
  if (campaign.messages.length > campaign.tenant.maxCampaignSize) {
    return reply.status(400).send({
      error: {
        code: "CAMPAIGN_TOO_LARGE",
        message: "Campaign exceeds tenant max campaign size.",
        details: { recipientCount: campaign.messages.length, maxCampaignSize: campaign.tenant.maxCampaignSize }
      }
    });
  }
  const invalidRecipients = campaign.messages.filter((m) => !isE164(m.toNumber)).map((m) => m.toNumber);
  if (invalidRecipients.length > 0) {
    return reply.status(400).send({
      error: {
        code: "INVALID_RECIPIENTS",
        message: "Campaign contains invalid recipients.",
        details: {
          totalInput: campaign.messages.length,
          validCount: campaign.messages.length - invalidRecipients.length,
          invalidCount: invalidRecipients.length,
          duplicateCount: 0,
          invalidRecipients: invalidRecipients.slice(0, 50)
        }
      }
    });
  }

  const selectedSenderNumberId = campaign.messages[0]?.fromNumberId || campaign.tenant.defaultSmsFromNumberId || null;
  const selectedSender = selectedSenderNumberId ? await db.phoneNumber.findFirst({ where: { id: selectedSenderNumberId, tenantId: user.tenantId } }) : null;
  if (campaign.tenant.smsSendMode === "LIVE" && (!selectedSender || selectedSender.status !== "ACTIVE")) {
    return reply.status(400).send({ error: { code: "NO_SENDER_NUMBER", message: "Set an ACTIVE sender number before sending in LIVE mode." } });
  }
  if (campaign.tenant.smsSendMode === "LIVE") {
    const canSendLive = await enforceBillingForLive(user.tenantId);
    if (!canSendLive) {
      return reply.status(400).send({ error: { code: "LIVE_MODE_BLOCKED", message: "LIVE mode sending is blocked until billing requirements are met." } });
    }
  }

  const decision = await decideCampaignPolicy({ tenant: campaign.tenant, tenantId: user.tenantId, actorUserId: user.sub, message: campaign.message, recipientsCount: campaign.messages.length });
  if ("reject" in decision) return reply.status(400).send({ error: decision.reject });

  if (campaign.tenant.smsSendMode === "LIVE" && !campaign.tenant.defaultSmsFromNumberId) {
    return reply.status(400).send({ error: "NO_SENDER_NUMBER", message: "Set a tenant default sender number before sending in LIVE mode." });
  }

  const nextStatus = decision.status === "NEEDS_APPROVAL" ? "NEEDS_APPROVAL" : "QUEUED";
  const updated = await db.smsCampaign.update({ where: { id }, data: { status: nextStatus, requiresApproval: nextStatus === "NEEDS_APPROVAL", holdReason: decision.holdReason, riskScore: decision.riskScore, message: decision.normalizedMessage } });
  await db.smsMessage.updateMany({ where: { campaignId: id }, data: { body: decision.normalizedMessage, status: "QUEUED", error: null } });

  if (nextStatus === "QUEUED") {
    await enqueueCampaignMessages(id, user.tenantId);
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_SEND_ENQUEUED", entityType: "SmsCampaign", entityId: id });
  } else {
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: "SMS_CAMPAIGN_SEND_HELD", entityType: "SmsCampaign", entityId: id });
  }

  return {
    ok: true,
    campaign: { ...updated, uiStatus: toCampaignUiStatus(updated.status) },
    queuedMessages: nextStatus === "QUEUED" ? campaign.messages.length : 0
  };
});

app.get("/sms/campaigns", async (req) => {
  const user = getUser(req);
  const rows = await db.smsCampaign.findMany({ where: { tenantId: user.tenantId }, include: { messages: { select: { status: true } } }, orderBy: { createdAt: "desc" } });
  return rows.map((row) => {
    const sentCount = row.messages.filter((m) => m.status === "SENT" || m.status === "DELIVERED").length;
    const failedCount = row.messages.filter((m) => m.status === "FAILED").length;
    return {
      id: row.id,
      name: row.name,
      fromNumber: row.fromNumber,
      status: row.status,
      uiStatus: toCampaignUiStatus(row.status),
      holdReason: row.holdReason,
      createdAt: row.createdAt,
      totalRecipients: row.messages.length,
      sentCount,
      failedCount
    };
  });
});

app.get("/sms/campaigns/:id", async (req, reply) => {
  const user = getUser(req);
  const { id } = req.params as { id: string };
  const campaign = await db.smsCampaign.findFirst({ where: { id, tenantId: user.tenantId }, include: { messages: true } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const metrics = {
    total: campaign.messages.length,
    queued: campaign.messages.filter((m) => m.status === "QUEUED").length,
    sending: campaign.messages.filter((m) => m.status === "SENDING").length,
    sent: campaign.messages.filter((m) => m.status === "SENT").length,
    delivered: campaign.messages.filter((m) => m.status === "DELIVERED").length,
    failed: campaign.messages.filter((m) => m.status === "FAILED").length
  };

  const senderNumberId = campaign.messages[0]?.fromNumberId || null;
  const sender = senderNumberId ? await db.phoneNumber.findFirst({ where: { id: senderNumberId, tenantId: user.tenantId } }) : null;
  return {
    ...campaign,
    uiStatus: toCampaignUiStatus(campaign.status),
    sender: sender ? { id: sender.id, phoneNumber: sender.phoneNumber, status: sender.status, provider: sender.provider } : null,
    metrics
  };
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
        mediaReliabilityGateEnabled: true,
        mediaPolicy: true,
        turnRequiredForMobile: true,
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
    turnRequiredForMobile: !!tenant.turnRequiredForMobile,
    mediaPolicy: tenant.mediaPolicy || "TURN_ONLY",
    mediaReliabilityGateEnabled: !!tenant.mediaReliabilityGateEnabled,
    configuredSipWsUrl: tenant.sipWsUrl || null,
    configuredSipDomain: tenant.sipDomain || null,
    configuredOutboundProxy: tenant.outboundProxy || null,
    configuredIceServers: maskIceServersForResponse(Array.isArray(tenant.iceServers) ? tenant.iceServers as any[] : []),
    effectiveSipWsUrl: cfg.sipWsUrl,
    effectiveSipDomain: cfg.sipDomain,
    outboundProxy: cfg.outboundProxy,
    dtmfMode: cfg.dtmfMode,
    iceServerCount: Array.isArray(cfg.iceServers) ? cfg.iceServers.length : 0
  };
});

app.get("/voice/effective-config", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const [tenant, link, readiness, lastUpdateAudit] = await Promise.all([
    db.tenant.findUnique({
      where: { id: admin.tenantId },
      select: {
        webrtcEnabled: true,
        webrtcRouteViaSbc: true,
        turnRequiredForMobile: true,
        mediaPolicy: true,
        mediaReliabilityGateEnabled: true,
        mediaTestStatus: true,
        mediaTestedAt: true,
        sipWsUrl: true,
        sipDomain: true,
        outboundProxy: true,
        iceServers: true,
        dtmfMode: true
      }
    }),
    db.tenantPbxLink.findUnique({ where: { tenantId: admin.tenantId }, include: { pbxInstance: true } }),
    probeSbcReadiness().catch(() => null),
    db.auditLog.findFirst({
      where: { tenantId: admin.tenantId, action: "VOICE_WEBRTC_SETTINGS_UPDATED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, actorUserId: true }
    })
  ]);

  if (!tenant) return reply.status(404).send({ error: "TENANT_NOT_FOUND" });

  const cfg = resolveWebrtcConfig(tenant, link);
  const warnings: string[] = [];
  if (!cfg.sipWsUrl) warnings.push("SIP WSS URL missing. Set sipWsUrl or enable Route WebRTC via SBC.");
  if (!cfg.sipDomain) warnings.push("SIP Domain missing. Set sipDomain or ensure PBX domain is linked.");
  if (!Array.isArray(cfg.iceServers) || cfg.iceServers.length === 0) warnings.push("ICE servers empty. Add STUN/TURN servers for reliability.");
  if (tenant.webrtcRouteViaSbc && readiness?.probes?.nginxSipProxy === "FAIL") {
    warnings.push("Route via SBC is enabled but /sip proxy probe failed.");
  }

  return {
    ok: true,
    resolved: {
      sipWsUrl: cfg.sipWsUrl,
      sipDomain: cfg.sipDomain,
      outboundProxy: cfg.outboundProxy,
      iceServers: maskIceServersForResponse(Array.isArray(cfg.iceServers) ? cfg.iceServers as any[] : []),
      webrtcRouteViaSbc: !!tenant.webrtcRouteViaSbc,
      turnRequiredForMobile: !!tenant.turnRequiredForMobile,
      mediaPolicy: tenant.mediaPolicy || "TURN_ONLY",
      mediaReliabilityGateEnabled: !!tenant.mediaReliabilityGateEnabled,
      mediaTestStatus: tenant.mediaTestStatus || "UNKNOWN",
      mediaTestedAt: tenant.mediaTestedAt || null,
      dtmfMode: cfg.dtmfMode
    },
    configured: {
      sipWsUrl: tenant.sipWsUrl || null,
      sipDomain: tenant.sipDomain || null,
      outboundProxy: tenant.outboundProxy || null,
      iceServers: maskIceServersForResponse(Array.isArray(tenant.iceServers) ? tenant.iceServers as any[] : []),
      linkedPbxDomain: link?.pbxDomain || null
    },
    meta: {
      lastUpdatedAt: lastUpdateAudit?.createdAt || null,
      lastUpdatedByUserId: lastUpdateAudit?.actorUserId || null,
      simulationMode: !!voiceSimulate,
      allowRealSipRegisterTest: (process.env.VOICE_ENABLE_REAL_REGISTER_TESTS || "false").toLowerCase() === "true"
    },
    warnings
  };
});

app.put("/voice/webrtc/settings", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const parsed = z.object({
    webrtcRouteViaSbc: z.boolean().optional(),
    turnRequiredForMobile: z.boolean().optional(),
    mediaPolicy: z.enum(["TURN_ONLY", "RTPENGINE_PREFERRED"]).optional(),
    mediaReliabilityGateEnabled: z.boolean().optional(),
    sipDomain: z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9.-]+$/).optional().nullable(),
    sipWsUrl: z.string().trim().url().refine((v) => v.startsWith("wss://") || v.startsWith("ws://"), "sipWsUrl must use ws:// or wss://").optional().nullable(),
    outboundProxy: z.string().trim().min(1).max(255).optional().nullable(),
    iceServers: z.array(iceServerSchema).max(12).optional()
  }).safeParse(req.body || {});

  if (!parsed.success) return reply.status(400).send({ error: "BAD_REQUEST", details: parsed.error.flatten() });
  const input = parsed.data;

  if (Object.keys(input).length === 0) {
    return reply.status(400).send({ error: "BAD_REQUEST", message: "No settings provided" });
  }

  const data: any = {};
  if (typeof input.webrtcRouteViaSbc === "boolean") data.webrtcRouteViaSbc = input.webrtcRouteViaSbc;
  if (typeof input.turnRequiredForMobile === "boolean") data.turnRequiredForMobile = input.turnRequiredForMobile;
  if (typeof input.mediaReliabilityGateEnabled === "boolean") data.mediaReliabilityGateEnabled = input.mediaReliabilityGateEnabled;
  if (input.mediaPolicy) data.mediaPolicy = input.mediaPolicy;
  if (input.sipDomain !== undefined) data.sipDomain = input.sipDomain ? String(input.sipDomain).trim() : null;
  if (input.sipWsUrl !== undefined) data.sipWsUrl = input.sipWsUrl ? String(input.sipWsUrl).trim() : null;
  if (input.outboundProxy !== undefined) data.outboundProxy = input.outboundProxy ? String(input.outboundProxy).trim() : null;
  if (input.iceServers !== undefined) data.iceServers = input.iceServers as any;

  const updated = await db.tenant.update({
    where: { id: admin.tenantId },
    data
  });

  await audit({
    tenantId: admin.tenantId,
    actorUserId: admin.sub,
    action: "VOICE_WEBRTC_SETTINGS_UPDATED",
    entityType: "Tenant",
    entityId: admin.tenantId
  });

  return {
    ok: true,
    updated: {
      webrtcRouteViaSbc: !!updated.webrtcRouteViaSbc,
      turnRequiredForMobile: !!updated.turnRequiredForMobile,
      mediaPolicy: updated.mediaPolicy || "TURN_ONLY",
      mediaReliabilityGateEnabled: !!updated.mediaReliabilityGateEnabled,
      sipDomain: updated.sipDomain || null,
      sipWsUrl: updated.sipWsUrl || null,
      outboundProxy: updated.outboundProxy || null,
      iceServers: maskIceServersForResponse(Array.isArray(updated.iceServers) ? updated.iceServers as any[] : [])
    }
  };
});

app.get("/voice/sbc-test/capabilities", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  return {
    ok: true,
    simulationMode: !!voiceSimulate,
    allowRealSipRegisterTest: (process.env.VOICE_ENABLE_REAL_REGISTER_TESTS || "false").toLowerCase() === "true"
  };
});

app.post("/voice/sbc-test/ws-probe", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({ sipWsUrl: z.string().trim().optional() }).parse(req.body || {});
  const [tenant, link] = await Promise.all([
    db.tenant.findUnique({ where: { id: admin.tenantId } }),
    db.tenantPbxLink.findUnique({ where: { tenantId: admin.tenantId }, include: { pbxInstance: true } })
  ]);
  if (!tenant) return reply.status(404).send({ error: "TENANT_NOT_FOUND" });

  const cfg = resolveWebrtcConfig(tenant, link);
  const rawUrl = String(input.sipWsUrl || cfg.sipWsUrl || "").trim();
  if (!rawUrl) return reply.status(400).send({ error: "SIP_WS_URL_MISSING" });

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return reply.status(400).send({ error: "SIP_WS_URL_INVALID" });
  }

  const proto = parsed.protocol.toLowerCase();
  if (!["wss:", "ws:", "https:", "http:"].includes(proto)) {
    return reply.status(400).send({ error: "SIP_WS_URL_UNSUPPORTED_SCHEME" });
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : (proto === "wss:" || proto === "https:" ? 443 : 80);
  const wsProbe = (proto === "wss:" || proto === "https:")
    ? await probeRemoteWsEndpoint(host, port, 4000)
    : { ok: await tcpProbe(host, port, 2200), latencyMs: null };

  return {
    ok: true,
    probe: {
      sipWsUrl: maskHostOnly(rawUrl),
      wsOk: !!wsProbe.ok,
      latencyMs: wsProbe.latencyMs,
      testedAt: new Date()
    }
  };
});

app.get("/voice/media-test/status", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const [tenant, recent] = await Promise.all([
    db.tenant.findUnique({
      where: { id: admin.tenantId },
      select: {
        mediaReliabilityGateEnabled: true,
        mediaTestStatus: true,
        mediaTestedAt: true,
        mediaLastErrorCode: true,
        mediaLastErrorAt: true,
        mediaPolicy: true,
        sbcUdpExposureConfirmed: true,
        sbcUdpExposureConfirmedAt: true
      }
    }),
    db.mediaTestRun.findFirst({ where: { tenantId: admin.tenantId }, orderBy: { createdAt: "desc" } })
  ]);

  if (!tenant) return reply.status(404).send({ error: "TENANT_NOT_FOUND" });

  return {
    ok: true,
    mediaReliabilityGateEnabled: !!tenant.mediaReliabilityGateEnabled,
    mediaTestStatus: tenant.mediaTestStatus || "UNKNOWN",
    mediaTestedAt: tenant.mediaTestedAt || null,
    mediaLastErrorCode: tenant.mediaLastErrorCode || null,
    mediaLastErrorAt: tenant.mediaLastErrorAt || null,
    mediaPolicy: tenant.mediaPolicy || "TURN_ONLY",
    sbcUdpExposureConfirmed: !!tenant.sbcUdpExposureConfirmed,
    sbcUdpExposureConfirmedAt: tenant.sbcUdpExposureConfirmedAt || null,
    recentRun: recent ? {
      id: recent.id,
      createdAt: recent.createdAt,
      completedAt: recent.completedAt,
      status: recent.status,
      platform: recent.platform,
      details: recent.details || null
    } : null
  };
});

app.put("/voice/media-test/status", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const input = z.object({
    mediaReliabilityGateEnabled: z.boolean().optional(),
    mediaPolicy: z.enum(["TURN_ONLY", "RTPENGINE_PREFERRED"]).optional(),
    sbcUdpExposureConfirmed: z.boolean().optional()
  }).parse(req.body || {});
  if (input.mediaReliabilityGateEnabled === undefined && !input.mediaPolicy && input.sbcUdpExposureConfirmed === undefined) {
    return reply.status(400).send({ error: "MEDIA_STATUS_UPDATE_REQUIRED" });
  }

  const updated = await db.tenant.update({
    where: { id: admin.tenantId },
    data: {
      ...(input.mediaReliabilityGateEnabled === undefined ? {} : { mediaReliabilityGateEnabled: !!input.mediaReliabilityGateEnabled }),
      ...(input.mediaPolicy ? { mediaPolicy: input.mediaPolicy } : {}),
      ...(input.sbcUdpExposureConfirmed === undefined ? {} : {
        sbcUdpExposureConfirmed: !!input.sbcUdpExposureConfirmed,
        sbcUdpExposureConfirmedAt: input.sbcUdpExposureConfirmed ? new Date() : null,
        sbcUdpExposureConfirmedByUserId: input.sbcUdpExposureConfirmed ? admin.sub : null
      })
    }
  });

  const mediaAuditAction = input.mediaPolicy
    ? `VOICE_MEDIA_POLICY_${input.mediaPolicy}`
    : (input.mediaReliabilityGateEnabled !== undefined
      ? (input.mediaReliabilityGateEnabled ? "VOICE_MEDIA_GATE_ENABLED" : "VOICE_MEDIA_GATE_DISABLED")
      : (input.sbcUdpExposureConfirmed ? "SBC_UDP_EXPOSURE_CONFIRMED" : "SBC_UDP_EXPOSURE_UNCONFIRMED"));

  await audit({
    tenantId: admin.tenantId,
    actorUserId: admin.sub,
    action: mediaAuditAction,
    entityType: "Tenant",
    entityId: admin.tenantId
  });

  return {
    ok: true,
    mediaReliabilityGateEnabled: !!updated.mediaReliabilityGateEnabled,
    mediaPolicy: updated.mediaPolicy || "TURN_ONLY",
    mediaTestStatus: updated.mediaTestStatus,
    mediaTestedAt: updated.mediaTestedAt,
    mediaLastErrorCode: updated.mediaLastErrorCode,
    mediaLastErrorAt: updated.mediaLastErrorAt,
    sbcUdpExposureConfirmed: !!updated.sbcUdpExposureConfirmed,
    sbcUdpExposureConfirmedAt: updated.sbcUdpExposureConfirmedAt || null
  };
});

app.post("/voice/media-test/start", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  if (!checkBillingRateLimit(`voice-media-test:${admin.tenantId}`, 30, 60 * 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const input = z.object({ platform: z.enum(["WEB", "IOS", "ANDROID"]).default("WEB") }).parse(req.body || {});

  const tokenId = createHmac("sha256", mediaTestTokenSecret).update(`${admin.tenantId}:${admin.sub}:${Date.now()}:${Math.random()}`).digest("hex");
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
  const run = await db.mediaTestRun.create({
    data: {
      tenantId: admin.tenantId,
      userId: admin.sub,
      tokenId,
      expiresAt,
      platform: input.platform,
      status: "QUEUED"
    }
  });

  const token = signMediaTestToken({
    runId: run.id,
    tokenId,
    tenantId: admin.tenantId,
    userId: admin.sub,
    expMs: expiresAt.getTime()
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "VOICE_MEDIA_TEST_REQUESTED", entityType: "MediaTestRun", entityId: run.id });
  return { ok: true, runId: run.id, token, expiresAt, platform: run.platform };
});

app.post("/voice/media-test/report", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    token: z.string().min(10),
    hasRelay: z.boolean(),
    iceSelectedPairType: z.enum(["host", "srflx", "relay", "unknown"]).default("unknown"),
    wsOk: z.boolean(),
    sipRegisterOk: z.boolean(),
    rtpCandidatePresent: z.boolean().optional(),
    durationMs: z.number().int().min(0).max(120000).optional(),
    platform: z.enum(["WEB", "IOS", "ANDROID"]).optional(),
    errorCode: z.string().max(120).optional()
  }).parse(req.body || {});

  const verified = verifyMediaTestToken(input.token);
  if (!verified) return reply.status(400).send({ error: "INVALID_MEDIA_TEST_TOKEN" });
  if (verified.tenantId !== user.tenantId) return reply.status(403).send({ error: "forbidden" });
  const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
  if (verified.userId !== user.sub && !isAdmin) return reply.status(403).send({ error: "forbidden" });

  const run = await db.mediaTestRun.findFirst({ where: { id: verified.runId, tokenId: verified.tokenId, tenantId: user.tenantId } });
  if (!run) return reply.status(404).send({ error: "MEDIA_TEST_RUN_NOT_FOUND" });
  if (run.completedAt) return { ok: true, runId: run.id, status: run.status };
  if (run.expiresAt.getTime() < Date.now()) {
    await db.mediaTestRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date(), details: { errorCode: "EXPIRED" } as any } });
    return reply.status(400).send({ error: "MEDIA_TEST_RUN_EXPIRED" });
  }

  const now = new Date();
  const rtpAnchored = !!input.hasRelay || !!input.rtpCandidatePresent;
  const passed = !!input.wsOk && !!input.sipRegisterOk && rtpAnchored;
  const errorCode = passed
    ? null
    : (input.errorCode || (!input.wsOk ? "WS_NOT_OK" : (!input.sipRegisterOk ? "SIP_REGISTER_FAILED" : "NO_RELAY_PATH")));

  const details = {
    iceSelectedPairType: input.iceSelectedPairType,
    hasRelay: !!input.hasRelay,
    rtpAnchored,
    durationMs: input.durationMs || null,
    errorCode
  };

  await db.mediaTestRun.update({
    where: { id: run.id },
    data: {
      completedAt: now,
      status: passed ? "PASSED" : "FAILED",
      platform: input.platform || run.platform,
      details: details as any
    }
  });

  await db.tenant.update({
    where: { id: user.tenantId },
    data: passed
      ? {
          mediaTestStatus: "PASSED",
          mediaTestedAt: now,
          mediaLastErrorCode: null,
          mediaLastErrorAt: null
        }
      : {
          mediaTestStatus: "FAILED",
          mediaTestedAt: now,
          mediaLastErrorCode: errorCode,
          mediaLastErrorAt: now
        }
  });

  await db.alert.create({
    data: {
      tenantId: user.tenantId,
      severity: passed ? "INFO" : "MEDIUM",
      category: "VOICE_DIAG",
      message: passed ? "Media reliability test passed" : "Media reliability test failed",
      metadata: details as any
    }
  }).catch(() => undefined);

  await audit({ tenantId: user.tenantId, actorUserId: user.sub, action: passed ? "VOICE_MEDIA_TEST_PASSED" : "VOICE_MEDIA_TEST_FAILED", entityType: "MediaTestRun", entityId: run.id });

  return { ok: true, runId: run.id, status: passed ? "PASSED" : "FAILED", mediaTestStatus: passed ? "PASSED" : "FAILED", mediaTestedAt: now };
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

// Config completeness check — no secrets exposed, safe to call from dashboard UI.
// Returns everything needed to diagnose why browser/mobile phone fails to register or gets no audio.
app.get("/voice/webrtc/health", async (req, reply) => {
  const user = getUser(req);

  const [tenant, link, hasExtension, linkedDevices] = await Promise.all([
    db.tenant.findUnique({ where: { id: user.tenantId } }),
    db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } }),
    db.pbxExtensionLink.findFirst({ where: { tenantId: user.tenantId, extension: { ownerUserId: user.sub } } }).then(Boolean),
    db.mobileDevice.count({ where: { tenantId: user.tenantId, userId: user.sub } }),
  ]);

  const cfg = resolveWebrtcConfig(tenant, link);

  // Check ICE servers in the resolved config
  const iceServers: Array<{ urls: string | string[] }> = Array.isArray(cfg.iceServers) ? cfg.iceServers : [];
  const stunConfigured = iceServers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).startsWith("stun:"));
  });
  const turnConfigured = !!turnServerEnv || iceServers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).startsWith("turn:") || String(u).startsWith("turns:"));
  });

  // Probe the telephony service health (AMI/ARI state) — best-effort, 3 s timeout.
  // TELEPHONY_INTERNAL_URL defaults to localhost:3003.
  let amiConnected: boolean | null = null;
  let ariRestHealthy: boolean | null = null;
  try {
    const telephonyBase = (process.env.TELEPHONY_INTERNAL_URL || "http://localhost:3003").replace(/\/$/, "");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const hRes = await fetch(`${telephonyBase}/health`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (hRes.ok) {
      const hBody = await hRes.json() as { ami?: { connected?: boolean }; ari?: { restHealthy?: boolean } };
      amiConnected = hBody?.ami?.connected ?? null;
      ariRestHealthy = hBody?.ari?.restHealthy ?? null;
    }
  } catch {
    // Telephony service unreachable — report null rather than false
  }

  const browserReady = cfg.webrtcEnabled && !!cfg.sipWsUrl && !!cfg.sipDomain && !!hasExtension;
  const mobileReady  = cfg.webrtcEnabled && !!cfg.sipWsUrl && !!cfg.sipDomain && !!hasExtension;

  const missingConfig: string[] = [
    !pbxWsEndpoint && !(tenant as any)?.sipWsUrl
      ? "PBX_WS_ENDPOINT — set to wss://209.145.60.79:8089/ws on API server (or configure sipWsUrl in Voice→Settings→WebRTC)"
      : null,
    !cfg.sipDomain
      ? "SIP_DOMAIN — set sipDomain in Voice→Settings→WebRTC"
      : null,
    !cfg.webrtcEnabled
      ? "WEBRTC_ENABLED — enable WebRTC in Voice→Settings"
      : null,
    !stunConfigured
      ? "STUN_SERVER — no STUN server in ICE list (set STUN_SERVER env var or add via Voice→Settings→ICE Servers)"
      : null,
    !turnConfigured
      ? "TURN_SERVER — no TURN server configured; audio will fail behind strict NAT (set TURN_SERVER env var)"
      : null,
  ].filter((x): x is string => x !== null);

  return {
    pbxHost: pbxHostEnv,
    pbxWsEndpoint: cfg.sipWsUrl ?? null,
    sipDomain: cfg.sipDomain ?? null,
    webrtcEnabled: cfg.webrtcEnabled,
    amiConnected,
    ariRestHealthy,
    ariWebSocketSupported: false,
    stunConfigured,
    turnConfigured,
    browserProvisioningReady: browserReady,
    mobileProvisioningReady: mobileReady,
    extensionAssigned: hasExtension,
    linkedMobileDevices: linkedDevices,
    missingConfig,
    // Env-level config summary (never logs passwords)
    envConfig: {
      PBX_WS_ENDPOINT: pbxWsEndpoint ?? "(not set)",
      STUN_SERVER: stunServerEnv,
      TURN_SERVER: turnServerEnv ?? "(not set)",
      TURN_USERNAME: turnUsernameEnv ? "(set)" : "(not set)",
      TURN_PASSWORD: turnPasswordEnv ? "(set)" : "(not set)",
    },
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

    // Upsert device record if push token was supplied alongside the redemption
    const di = input.deviceInfo;
    if (di?.expoPushToken && di?.platform && ["IOS", "ANDROID"].includes(String(di.platform))) {
      await db.mobileDevice.upsert({
        where: { expoPushToken: String(di.expoPushToken) },
        create: {
          tenantId: user.tenantId,
          userId: user.sub,
          platform: di.platform as "IOS" | "ANDROID",
          expoPushToken: String(di.expoPushToken),
          voipPushToken: di.voipPushToken ? String(di.voipPushToken) : null,
          deviceName: di.deviceName ? String(di.deviceName) : null,
          lastSeenAt: now,
        },
        update: {
          userId: user.sub,
          tenantId: user.tenantId,
          voipPushToken: di.voipPushToken ? String(di.voipPushToken) : undefined,
          deviceName: di.deviceName ? String(di.deviceName) : undefined,
          lastSeenAt: now,
        },
      });
    }

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
    type: z.enum(["SESSION_START", "SESSION_HEARTBEAT", "SIP_REGISTER", "SIP_UNREGISTER", "WS_CONNECTED", "WS_DISCONNECTED", "WS_RECONNECT", "ICE_GATHERING", "ICE_SELECTED_PAIR", "TURN_TEST_RESULT", "INCOMING_INVITE", "ANSWER_TAPPED", "CALL_CONNECTED", "CALL_ENDED", "ERROR", "MEDIA_TEST_RUN"]),
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

app.get("/voice/media-metrics", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const q = z.object({ range: z.enum(["24h", "7d"]).optional() }).parse(req.query || {});
  const parsed = parseMetricsRange(q.range || "24h");
  const metrics = await getMediaMetricsForTenant(admin.tenantId, parsed.since);

  return {
    ok: true,
    range: parsed.label,
    since: parsed.since,
    ...metrics
  };
});

app.get("/admin/voice/media-metrics", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const q = z.object({ range: z.enum(["24h", "7d"]).optional() }).parse(req.query || {});
  const parsed = parseMetricsRange(q.range || "24h");

  const [tenantRows, mediaRuns, turnRuns] = await Promise.all([
    db.tenant.findMany({ select: { id: true, name: true } }),
    db.mediaTestRun.findMany({ where: { createdAt: { gte: parsed.since } }, select: { tenantId: true, status: true, details: true } }),
    db.turnValidationJob.findMany({ where: { requestedAt: { gte: parsed.since } }, select: { tenantId: true, hasRelay: true, errorCode: true } })
  ]);

  let passed = 0;
  let failed = 0;
  let relayTrueCount = 0;
  let relayFalseCount = 0;
  const errorCounts = new Map<string, number>();
  const tenantFailMap = new Map<string, number>();

  for (const row of mediaRuns as any[]) {
    if (row.status === "PASSED") passed += 1;
    if (row.status === "FAILED") {
      failed += 1;
      tenantFailMap.set(String(row.tenantId), (tenantFailMap.get(String(row.tenantId)) || 0) + 1);
    }
    const details: any = row.details || {};
    if (details?.hasRelay === true) relayTrueCount += 1;
    if (details?.hasRelay === false) relayFalseCount += 1;
    const err = String(details?.errorCode || "").trim();
    if (err) errorCounts.set(err, (errorCounts.get(err) || 0) + 1);
  }

  for (const row of turnRuns as any[]) {
    if (row.hasRelay === true) relayTrueCount += 1;
    if (row.hasRelay === false) relayFalseCount += 1;
    const err = String(row.errorCode || "").trim();
    if (err) errorCounts.set(err, (errorCounts.get(err) || 0) + 1);
    if (err) tenantFailMap.set(String(row.tenantId), (tenantFailMap.get(String(row.tenantId)) || 0) + 1);
  }

  const tenantNameById = new Map<string, string>();
  for (const t of tenantRows as any[]) tenantNameById.set(String(t.id), String(t.name || "tenant"));

  const topErrorCodes = Array.from(errorCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const tenantsFailingMost = Array.from(tenantFailMap.entries())
    .map(([tenantId, failures]) => ({ tenantId, tenantName: tenantNameById.get(tenantId) || "tenant", failures }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 20);

  return {
    ok: true,
    range: parsed.label,
    since: parsed.since,
    totalMediaTests: mediaRuns.length,
    passed,
    failed,
    relayTrueCount,
    relayFalseCount,
    topErrorCodes,
    tenantsFailingMost
  };
});

app.get("/admin/sbc/config", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const config = await getOrCreateSbcConfig();
  const target = resolveSbcTarget(config);
  const readiness = await probeSbcReadiness(config);

  return {
    ok: true,
    config: {
      id: config.id,
      mode: config.mode,
      remoteUpstreamHost: config.remoteUpstreamHost,
      remoteUpstreamPort: config.remoteUpstreamPort,
      updatedAt: config.updatedAt,
      updatedByUserId: config.updatedByUserId
    },
    activeUpstream: target.proxyUrl,
    readiness
  };
});

app.put("/admin/sbc/config", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const parsed = z.object({
    mode: z.enum(["LOCAL", "REMOTE"]),
    remoteUpstreamHost: z.string().trim().min(1).max(255).optional().nullable(),
    remoteUpstreamPort: z.coerce.number().int().min(1).max(65535).optional()
  }).safeParse(req.body || {});

  if (!parsed.success) return reply.status(400).send({ error: "BAD_REQUEST", details: parsed.error.flatten() });

  const mode = parsed.data.mode;
  const remoteUpstreamHost = mode === "REMOTE" ? String(parsed.data.remoteUpstreamHost || "").trim().toLowerCase() : null;
  const remoteUpstreamPort = Number(parsed.data.remoteUpstreamPort || 7443);

  const current = await getOrCreateSbcConfig();
  const requestedNoop = current.mode === mode
    && String(current.remoteUpstreamHost || "") === String(remoteUpstreamHost || "")
    && Number(current.remoteUpstreamPort || 7443) === remoteUpstreamPort;

  if (mode === "REMOTE") {
    if (!remoteUpstreamHost || !isSafeRemoteUpstreamHost(remoteUpstreamHost)) {
      return reply.status(400).send({ error: "SBC_CONFIG_INVALID_REMOTE_HOST" });
    }
    const reachable = await tcpProbe(remoteUpstreamHost, remoteUpstreamPort, 1800);
    if (!reachable) {
      return reply.status(400).send({ error: "SBC_REMOTE_UPSTREAM_UNREACHABLE" });
    }
  }

  if (!requestedNoop) {
    try {
      await applyNginxSbcTarget({ mode, remoteUpstreamHost, remoteUpstreamPort });
    } catch (e: any) {
      await audit({
        tenantId: admin.tenantId,
        action: "SBC_CONFIG_APPLY_FAILED",
        entityType: "SbcConfig",
        entityId: "default",
        actorUserId: admin.sub
      }).catch(() => undefined);
      req.log.warn({ err: e?.message || String(e) }, "SBC_CONFIG_APPLY_FAILED");
      return reply.status(500).send({ error: "SBC_CONFIG_APPLY_FAILED" });
    }
  }

  const saved = await db.sbcConfig.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      mode,
      remoteUpstreamHost,
      remoteUpstreamPort,
      updatedByUserId: admin.sub
    },
    update: {
      mode,
      remoteUpstreamHost,
      remoteUpstreamPort,
      updatedByUserId: admin.sub
    }
  });

  await audit({
    tenantId: admin.tenantId,
    action: "SBC_CONFIG_UPDATED",
    entityType: "SbcConfig",
    entityId: "default",
    actorUserId: admin.sub
  }).catch(() => undefined);

  const target = resolveSbcTarget(saved);
  const readiness = await probeSbcReadiness(saved);

  return {
    ok: true,
    config: {
      id: saved.id,
      mode: saved.mode,
      remoteUpstreamHost: saved.remoteUpstreamHost,
      remoteUpstreamPort: saved.remoteUpstreamPort,
      updatedAt: saved.updatedAt,
      updatedByUserId: saved.updatedByUserId
    },
    activeUpstream: target.proxyUrl,
    readiness
  };
});

app.get("/admin/sbc/readiness", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  return probeSbcReadiness();
});

app.get("/admin/sbc/ops-plan", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const plan = [
    "SBC Media Ops Plan (No Execution)",
    "",
    "Recommended UDP RTP range:",
    "- 35000-35199/udp",
    "",
    "Suggested UFW commands (do not run automatically):",
    "- sudo ufw allow 35000:35199/udp",
    "- sudo ufw status numbered",
    "",
    "Optional iptables rate-limit snippet:",
    "- sudo iptables -A INPUT -p udp --dport 35000:35199 -m hashlimit --hashlimit-above 120/second --hashlimit-burst 240 --hashlimit-mode srcip --hashlimit-name rtp_abuse -j DROP",
    "",
    "Validation checklist after opening UDP range:",
    "1) /dashboard/voice/sbc-test -> Test WS handshake + Test SIP REGISTER + Run Media Test",
    "2) /dashboard/voice/diagnostics -> verify relay rate and pass rate trends",
    "3) Place controlled real call (mobile + web), confirm two-way audio + stable call duration",
    "4) Confirm media test outcomes are PASSED within tenant metrics windows"
  ].join("\n");

  return {
    ok: true,
    generatedAt: new Date(),
    recommendation: { udpRange: "35000-35199/udp" },
    plan
  };
});

app.get("/admin/sbc/rollout/tenants", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;

  const rows = await db.tenant.findMany({
    select: {
      id: true,
      name: true,
      mediaPolicy: true,
      turnRequiredForMobile: true,
      mediaReliabilityGateEnabled: true,
      mediaTestStatus: true,
      mediaTestedAt: true,
      sbcUdpExposureConfirmed: true,
      sbcUdpExposureConfirmedAt: true
    },
    orderBy: { createdAt: "desc" },
    take: 500
  });

  return rows;
});

app.get("/admin/sbc/rollout/tenant/:tenantId", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { tenantId } = req.params as { tenantId: string };

  const [tenant, latestRun, metrics24h] = await Promise.all([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        mediaPolicy: true,
        turnRequiredForMobile: true,
        mediaReliabilityGateEnabled: true,
        mediaTestStatus: true,
        mediaTestedAt: true,
        mediaLastErrorCode: true,
        sbcUdpExposureConfirmed: true,
        sbcUdpExposureConfirmedAt: true,
        sbcUdpExposureConfirmedByUserId: true
      }
    }),
    db.mediaTestRun.findFirst({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
    getMediaMetricsForTenant(tenantId, new Date(Date.now() - 24 * 60 * 60 * 1000))
  ]);

  if (!tenant) return reply.status(404).send({ error: "TENANT_NOT_FOUND" });

  const totalRelay = Number(metrics24h?.relayTrueCount || 0) + Number(metrics24h?.relayFalseCount || 0);
  const relayRate = totalRelay > 0 ? Number((Number(metrics24h?.relayTrueCount || 0) / totalRelay).toFixed(4)) : 0;

  return {
    ok: true,
    tenant,
    latestMediaTestRun: latestRun ? {
      id: latestRun.id,
      status: latestRun.status,
      createdAt: latestRun.createdAt,
      completedAt: latestRun.completedAt,
      details: latestRun.details || null
    } : null,
    metrics24h: {
      ...metrics24h,
      relayRate
    }
  };
});

app.put("/admin/sbc/rollout/tenant/:tenantId", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { tenantId } = req.params as { tenantId: string };

  const input = z.object({
    mediaPolicy: z.enum(["TURN_ONLY", "RTPENGINE_PREFERRED"]).optional(),
    mediaReliabilityGateEnabled: z.boolean().optional(),
    turnRequiredForMobile: z.boolean().optional(),
    sbcUdpExposureConfirmed: z.boolean().optional()
  }).parse(req.body || {});

  const updated = await db.tenant.update({
    where: { id: tenantId },
    data: {
      ...(input.mediaPolicy ? { mediaPolicy: input.mediaPolicy } : {}),
      ...(input.mediaReliabilityGateEnabled === undefined ? {} : { mediaReliabilityGateEnabled: !!input.mediaReliabilityGateEnabled }),
      ...(input.turnRequiredForMobile === undefined ? {} : { turnRequiredForMobile: !!input.turnRequiredForMobile }),
      ...(input.sbcUdpExposureConfirmed === undefined ? {} : {
        sbcUdpExposureConfirmed: !!input.sbcUdpExposureConfirmed,
        sbcUdpExposureConfirmedAt: input.sbcUdpExposureConfirmed ? new Date() : null,
        sbcUdpExposureConfirmedByUserId: input.sbcUdpExposureConfirmed ? admin.sub : null
      })
    }
  });

  await audit({ tenantId, actorUserId: admin.sub, action: "SBC_ROLLOUT_TENANT_UPDATED", entityType: "Tenant", entityId: tenantId });

  return {
    ok: true,
    tenant: {
      id: updated.id,
      mediaPolicy: updated.mediaPolicy,
      mediaReliabilityGateEnabled: !!updated.mediaReliabilityGateEnabled,
      turnRequiredForMobile: !!updated.turnRequiredForMobile,
      mediaTestStatus: updated.mediaTestStatus,
      mediaTestedAt: updated.mediaTestedAt,
      sbcUdpExposureConfirmed: !!updated.sbcUdpExposureConfirmed,
      sbcUdpExposureConfirmedAt: updated.sbcUdpExposureConfirmedAt || null
    }
  };
});

app.post("/admin/sbc/rollout/tenant/:tenantId/media-test/run", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { tenantId } = req.params as { tenantId: string };

  const recentSessions = await db.voiceClientSession.findMany({
    where: { tenantId, startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    orderBy: { lastSeenAt: "desc" },
    take: 40,
    select: { iceHasTurn: true, lastRegState: true }
  });

  const hasRelay = recentSessions.some((s: any) => !!s.iceHasTurn);
  const wsOk = recentSessions.length > 0;
  const sipRegisterOk = recentSessions.some((s: any) => String(s.lastRegState || "").toUpperCase() === "REGISTERED");
  const passed = wsOk && sipRegisterOk && hasRelay;
  const now = new Date();
  const errorCode = passed ? null : (!wsOk ? "NO_RECENT_DIAG_SESSION" : (!sipRegisterOk ? "SIP_REGISTER_NOT_OBSERVED" : "NO_RELAY_PATH"));

  const tokenId = createHmac("sha256", mediaTestTokenSecret).update(`${tenantId}:${admin.sub}:${Date.now()}:${Math.random()}`).digest("hex");
  const run = await db.mediaTestRun.create({
    data: {
      tenantId,
      userId: admin.sub,
      tokenId,
      expiresAt: new Date(Date.now() + 2 * 60 * 1000),
      completedAt: now,
      status: passed ? "PASSED" : "FAILED",
      platform: "WEB",
      details: {
        iceSelectedPairType: hasRelay ? "relay" : "unknown",
        hasRelay,
        rtpAnchored: hasRelay,
        durationMs: 100,
        errorCode
      } as any
    }
  });

  await db.tenant.update({
    where: { id: tenantId },
    data: passed
      ? { mediaTestStatus: "PASSED", mediaTestedAt: now, mediaLastErrorCode: null, mediaLastErrorAt: null }
      : { mediaTestStatus: "FAILED", mediaTestedAt: now, mediaLastErrorCode: errorCode, mediaLastErrorAt: now }
  });

  await audit({ tenantId, actorUserId: admin.sub, action: passed ? "VOICE_MEDIA_TEST_PASSED" : "VOICE_MEDIA_TEST_FAILED", entityType: "MediaTestRun", entityId: run.id });

  return {
    ok: true,
    runId: run.id,
    status: passed ? "PASSED" : "FAILED",
    observed: { wsOk, sipRegisterOk, hasRelay },
    errorCode
  };
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
      turnLastErrorAt: true,
      mediaReliabilityGateEnabled: true,
      mediaTestStatus: true,
      mediaTestedAt: true,
      mediaLastErrorCode: true,
      mediaPolicy: true,
      sbcUdpExposureConfirmed: true,
      sbcUdpExposureConfirmedAt: true
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
      select: {
        turnRequiredForMobile: true,
        turnValidationStatus: true,
        turnValidatedAt: true,
        mediaReliabilityGateEnabled: true,
        mediaTestStatus: true,
        mediaTestedAt: true,
        mediaLastErrorCode: true,
        mediaLastErrorAt: true,
        mediaPolicy: true
      }
    });
    if (tenant?.turnRequiredForMobile && (tenant?.mediaPolicy || "TURN_ONLY") === "TURN_ONLY" && !isTurnRecentlyVerified(tenant)) {
      return {
        ok: false,
        code: "TURN_REQUIRED_NOT_VERIFIED",
        status: existing.status,
        inviteId: existing.id,
        turnValidationStatus: tenant.turnValidationStatus,
        turnValidatedAt: tenant.turnValidatedAt || null
      };
    }
    if (tenant?.mediaReliabilityGateEnabled && !isMediaTestRecentlyPassed(tenant)) {
      return {
        ok: false,
        code: "MEDIA_TEST_REQUIRED_NOT_PASSED",
        status: existing.status,
        inviteId: existing.id,
        mediaTestStatus: tenant.mediaTestStatus || "UNKNOWN",
        mediaTestedAt: tenant.mediaTestedAt || null,
        mediaLastErrorCode: tenant.mediaLastErrorCode || null,
        mediaLastErrorAt: tenant.mediaLastErrorAt || null
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
  if (result?.tenantId) {
    const normalizedFrom = normalizeContactNumber(normalized.fromNumber);
    const normalizedTo = normalizeContactNumber(normalized.toExtension);
    const customer = await findCustomerByContactNumber(result.tenantId, normalizedFrom || normalizedTo || null);
    await db.pbxCallEvent.create({
      data: {
        tenantId: result.tenantId,
        customerId: customer?.id || null,
        pbxTenantId: normalized.pbxTenantId || null,
        eventType: normalized.eventType,
        callId: normalized.pbxCallId || null,
        fromNumber: normalized.fromNumber || null,
        toNumber: normalized.toExtension || null,
        extension: normalized.pbxExtensionId || null,
        status: normalized.state || null,
        payload: normalized as any
      }
    });
  }
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
    // Primary test path for VitalPBX integrations: GET /api/v2/tenants.
    const vital = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret });
    const tenants = await vital.listTenants();
    const healthy = Array.isArray(tenants) && tenants.every((row) => row && typeof row === "object");
    if (!healthy) {
      return reply.status(400).send({ error: "PBX_PARSE_ERROR", message: "VitalPBX tenants payload is invalid." });
    }
    const capabilities = await vital.detectCapabilities().catch(() => null);
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_INSTANCE_TEST_OK", entityType: "PbxInstance", entityId: instance.id });
    return {
      ok: true,
      provider: "VITALPBX",
      tenantCount: tenants.length,
      capabilities
    };
  } catch (e: any) {
    // Backward-compatible fallback for existing WirePBX-style instances.
    try {
      await getWirePbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }).healthCheck();
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_INSTANCE_TEST_OK", entityType: "PbxInstance", entityId: instance.id });
      return {
        ok: true,
        provider: "WIRE_PBX_COMPAT",
        warning: "VitalPBX test failed but WirePBX compatibility health endpoint passed.",
        vitalError: String(e?.code || e?.message || "PBX_UNAVAILABLE")
      };
    } catch (wireErr: any) {
      await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_INSTANCE_TEST_FAILED", entityType: "PbxInstance", entityId: instance.id });
      return reply.status(400).send({
        error: String(e?.code || "PBX_UNAVAILABLE"),
        message: String(e?.message || "VitalPBX connection test failed"),
        fallbackError: String(wireErr?.code || wireErr?.message || "PBX_UNAVAILABLE")
      });
    }
  }
});

type VitalResourceName =
  | "extensions"
  | "trunks"
  | "ring-groups"
  | "queues"
  | "ivr"
  | "routes"
  | "tenants"
  | "users"
  | "roles"
  | "cdr"
  | "devices"
  | "device-profiles"
  | "destinations"
  | "classes-of-services"
  | "conferences"
  | "phonebooks"
  | "route-selections"
  | "account-codes"
  | "authorization-codes"
  | "customer-codes"
  | "ai-api-keys"
  | "sms"
  | "whatsapp"
  | "virtual-faxes"
  | "voicemail"
  | "parking-lots";

function isVitalResourceName(input: string): input is VitalResourceName {
  return [
    "extensions",
    "trunks",
    "ring-groups",
    "queues",
    "ivr",
    "routes",
    "tenants",
    "users",
    "roles",
    "cdr",
    "devices",
    "device-profiles",
    "destinations",
    "classes-of-services",
    "conferences",
    "phonebooks",
    "route-selections",
    "account-codes",
    "authorization-codes",
    "customer-codes",
    "ai-api-keys",
    "sms",
    "whatsapp",
    "virtual-faxes",
    "voicemail",
    "parking-lots"
  ].includes(input);
}

async function vitalListByResource(client: VitalPbxClient, resource: VitalResourceName, tenantId?: string) {
  if (resource === "extensions") return client.listExtensions(tenantId);
  if (resource === "trunks") return client.listTrunks(tenantId);
  if (resource === "ring-groups") return client.listRingGroups(tenantId);
  if (resource === "queues") return client.listQueues(tenantId);
  if (resource === "ivr") return client.listIvr(tenantId);
  if (resource === "routes") return client.listRoutes(tenantId);
  if (resource === "tenants") return client.listTenants();
  if (resource === "users") return (await client.callEndpoint<any[]>("users.list", { tenant: tenantId })).data || [];
  if (resource === "roles") return (await client.callEndpoint<any[]>("roles.list", { tenant: tenantId })).data || [];
  if (resource === "cdr") return (await client.callEndpoint<any[]>("cdr.list", { tenant: tenantId })).data || [];
  if (resource === "devices") return (await client.callEndpoint<any[]>("devices.list", { tenant: tenantId })).data || [];
  if (resource === "device-profiles") return (await client.callEndpoint<any[]>("deviceProfiles.list", { tenant: tenantId })).data || [];
  if (resource === "destinations") return (await client.callEndpoint<any[]>("destinations.list", { tenant: tenantId })).data || [];
  if (resource === "classes-of-services") return (await client.callEndpoint<any[]>("classesOfServices.list", { tenant: tenantId })).data || [];
  if (resource === "conferences") return (await client.callEndpoint<any[]>("conferences.list", { tenant: tenantId })).data || [];
  if (resource === "phonebooks") return (await client.callEndpoint<any[]>("phonebooks.list", { tenant: tenantId })).data || [];
  if (resource === "route-selections") return (await client.callEndpoint<any[]>("routeSelections.list", { tenant: tenantId })).data || [];
  if (resource === "account-codes") return client.listAccountCodes(tenantId);
  if (resource === "authorization-codes") return client.listAuthorizationCodes(tenantId);
  if (resource === "customer-codes") return client.listCustomerCodes(tenantId);
  if (resource === "ai-api-keys") return client.listAiApiKeys(tenantId);
  if (resource === "sms") return (await client.callEndpoint<any[]>("sms.phoneNumbers", { tenant: tenantId })).data || [];
  if (resource === "whatsapp") return (await client.callEndpoint<any[]>("whatsapp.numbers", { tenant: tenantId })).data || [];
  if (resource === "virtual-faxes") return (await client.callEndpoint<any[]>("virtualFaxes.list", { tenant: tenantId })).data || [];
  if (resource === "parking-lots") return (await client.callEndpoint<any[]>("parkingLots.list", { tenant: tenantId })).data || [];
  if (resource === "voicemail") throw new Error("resource_requires_item_path");
  throw new Error("resource_not_supported");
}

async function vitalCreateByResource(client: VitalPbxClient, resource: VitalResourceName, payload: Record<string, unknown>, tenantId?: string) {
  if (resource === "extensions") return client.createExtension(payload);
  if (resource === "trunks") return client.createTrunk(payload);
  if (resource === "ring-groups") return client.createRingGroup(payload);
  if (resource === "queues") return client.createQueue(payload, tenantId);
  if (resource === "ivr") return client.createIvr(payload);
  if (resource === "routes") return client.createRoute(payload);
  if (resource === "tenants") return client.createTenant(payload);
  if (resource === "authorization-codes") return client.createAuthorizationCode(payload, tenantId);
  if (resource === "customer-codes") return client.createCustomerCode(payload, tenantId);
  if (resource === "ai-api-keys") return client.createAiApiKey(payload, tenantId);
  throw new Error("resource_not_supported");
}

async function vitalUpdateByResource(client: VitalPbxClient, resource: VitalResourceName, id: string, payload: Record<string, unknown>, tenantId?: string) {
  if (resource === "extensions") return client.updateExtension(id, payload);
  if (resource === "trunks") return client.updateTrunk(id, payload);
  if (resource === "ring-groups") return client.updateRingGroup(id, payload);
  if (resource === "queues") return client.updateQueue(id, payload, tenantId);
  if (resource === "ivr") return client.updateIvr(id, payload);
  if (resource === "routes") return client.updateRoute(id, payload);
  if (resource === "tenants") return client.updateTenant(id, payload);
  if (resource === "authorization-codes") return client.updateAuthorizationCode(id, payload, tenantId);
  if (resource === "customer-codes") return client.updateCustomerCode(id, payload, tenantId);
  if (resource === "ai-api-keys") return client.updateAiApiKey(id, payload, tenantId);
  throw new Error("resource_not_supported");
}

async function vitalDeleteByResource(client: VitalPbxClient, resource: VitalResourceName, id: string, tenantId?: string) {
  if (resource === "extensions") return client.deleteExtension(id);
  if (resource === "trunks") return client.deleteTrunk(id);
  if (resource === "ring-groups") return client.deleteRingGroup(id);
  if (resource === "queues") return client.deleteQueue(id, tenantId);
  if (resource === "ivr") return client.deleteIvr(id);
  if (resource === "routes") return client.deleteRoute(id);
  if (resource === "tenants") return client.deleteTenant(id);
  if (resource === "authorization-codes") return client.deleteAuthorizationCode(id, tenantId);
  if (resource === "customer-codes") return client.deleteCustomerCode(id, tenantId);
  if (resource === "ai-api-keys") return client.deleteAiApiKey(id, tenantId);
  throw new Error("resource_not_supported");
}

app.get("/admin/pbx/tenants", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const query = z.object({ instanceId: z.string().optional() }).parse(req.query || {});
  const instance = query.instanceId
    ? await db.pbxInstance.findUnique({ where: { id: query.instanceId } })
    : await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const client = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret });
  const tenants = await client.listTenants();
  return { instanceId: instance.id, tenants };
});

app.post("/admin/pbx/tenants", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const input = z.object({
    instanceId: z.string().min(1),
    name: z.string().min(2),
    externalId: z.string().optional(),
    sipDomain: z.string().optional(),
    extensionRangeStart: z.number().int().optional(),
    extensionRangeEnd: z.number().int().optional(),
    voicemailEnabled: z.boolean().default(true),
    recordingDirectory: z.string().optional()
  }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const client = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret });
  const created = await client.createTenant({
    name: input.name,
    externalId: input.externalId || undefined,
    sipDomain: input.sipDomain || undefined,
    extensionRangeStart: input.extensionRangeStart || undefined,
    extensionRangeEnd: input.extensionRangeEnd || undefined,
    voicemailEnabled: input.voicemailEnabled,
    recordingDirectory: input.recordingDirectory || undefined
  });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "PBX_TENANT_CREATED", entityType: "PbxInstance", entityId: instance.id });
  return { ok: true, tenant: created };
});

app.post("/admin/pbx/tenants/:id/suspend", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ instanceId: z.string().min(1) }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  await getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }).suspendTenant(id);
  return { ok: true };
});

app.post("/admin/pbx/tenants/:id/unsuspend", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ instanceId: z.string().min(1) }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  await getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }).unsuspendTenant(id);
  return { ok: true };
});

app.delete("/admin/pbx/tenants/:id", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ instanceId: z.string().min(1) }).parse(req.query || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  await getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }).deleteTenant(id);
  return { ok: true };
});

app.post("/admin/pbx/tenants/:id/sync", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ instanceId: z.string().min(1) }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const out = await getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }).syncTenant(id);
  return { ok: true, out };
});

app.get("/admin/pbx/resources/:resource", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { resource } = req.params as { resource: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  const query = z.object({ instanceId: z.string().min(1), pbxTenantId: z.string().optional() }).parse(req.query || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: query.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const out = await vitalListByResource(getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }), resource, query.pbxTenantId);
  return { resource, rows: out };
});

app.post("/admin/pbx/resources/:resource", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { resource } = req.params as { resource: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  const input = z.object({ instanceId: z.string().min(1), payload: z.record(z.any()) }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const out = await vitalCreateByResource(getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }), resource, input.payload, undefined);
  return { ok: true, resource, out };
});

app.patch("/admin/pbx/resources/:resource/:id", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { resource, id } = req.params as { resource: string; id: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  const input = z.object({ instanceId: z.string().min(1), payload: z.record(z.any()) }).parse(req.body || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: input.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const out = await vitalUpdateByResource(getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }), resource, id, input.payload, undefined);
  return { ok: true, resource, out };
});

app.delete("/admin/pbx/resources/:resource/:id", async (req, reply) => {
  const admin = await requireSuperAdmin(req, reply);
  if (!admin) return;
  const { resource, id } = req.params as { resource: string; id: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  const query = z.object({ instanceId: z.string().min(1) }).parse(req.query || {});
  const instance = await db.pbxInstance.findUnique({ where: { id: query.instanceId } });
  if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  await vitalDeleteByResource(getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret }), resource, id, undefined);
  return { ok: true, resource };
});

// Resource list cache: 120 s TTL — extensions/trunks/queues change rarely.
const PBX_RESOURCE_CACHE = new Map<string, { at: number; rows: any[] }>();

app.get("/voice/pbx/resources/:resource", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  const { resource } = req.params as { resource: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  if (!canAccessVitalResourceAction(user, resource, "view")) return reply.status(403).send({ error: "forbidden" });

  // SUPER_ADMIN with vpbx: tenant context: bypass tenantPbxLink, query VitalPBX directly.
  const pbxTenantOverride = (req as any).pbxTenantOverride as string | undefined;
  if (pbxTenantOverride && isRole(user, ["SUPER_ADMIN"])) {
    const overrideCacheKey = `vpbx:${pbxTenantOverride}:${resource}`;
    const overrideCached = PBX_RESOURCE_CACHE.get(overrideCacheKey);
    if (overrideCached && Date.now() - overrideCached.at < PBX_LIVE_TTL_RESOURCES) {
      return { resource, rows: overrideCached.rows };
    }
    const overrideInstance = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
    if (!overrideInstance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const overrideAuth = decryptJson<{ token: string; secret?: string }>(overrideInstance.apiAuthEncrypted);
    const overrideRows = await vitalListByResource(
      getVitalPbxClient({ baseUrl: overrideInstance.baseUrl, token: overrideAuth.token, secret: overrideAuth.secret }),
      resource as VitalResourceName,
      pbxTenantOverride
    );
    PBX_RESOURCE_CACHE.set(overrideCacheKey, { at: Date.now(), rows: overrideRows });
    return { resource, rows: overrideRows };
  }

  const cacheKey = `${user.tenantId}:${resource}`;
  const cached = PBX_RESOURCE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < PBX_LIVE_TTL_RESOURCES) {
    return { resource, rows: cached.rows };
  }

  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) return reply.status(404).send({ error: "PBX_LINK_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  const out = await vitalListByResource(getVitalPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }), resource, link.pbxTenantId || undefined);
  PBX_RESOURCE_CACHE.set(cacheKey, { at: Date.now(), rows: out });
  return { resource, rows: out };
});

app.post("/voice/pbx/resources/:resource", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  const { resource } = req.params as { resource: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  if (!canAccessVitalResourceAction(user, resource, "create")) return reply.status(403).send({ error: "forbidden" });
  const input = z.object({ payload: z.record(z.any()) }).parse(req.body || {});
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) return reply.status(404).send({ error: "PBX_LINK_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  const payload = { ...input.payload, pbxTenantId: link.pbxTenantId || input.payload.pbxTenantId };
  const out = await vitalCreateByResource(getVitalPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }), resource, payload, link.pbxTenantId || undefined);
  return { ok: true, resource, out };
});

app.patch("/voice/pbx/resources/:resource/:id", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  const { resource, id } = req.params as { resource: string; id: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  if (!canAccessVitalResourceAction(user, resource, "update")) return reply.status(403).send({ error: "forbidden" });
  const input = z.object({ payload: z.record(z.any()) }).parse(req.body || {});
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) return reply.status(404).send({ error: "PBX_LINK_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  const out = await vitalUpdateByResource(getVitalPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }), resource, id, input.payload, link.pbxTenantId || undefined);
  return { ok: true, resource, out };
});

app.delete("/voice/pbx/resources/:resource/:id", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  const { resource, id } = req.params as { resource: string; id: string };
  if (!isVitalResourceName(resource)) return reply.status(400).send({ error: "resource_not_supported" });
  if (!canAccessVitalResourceAction(user, resource, "delete")) return reply.status(403).send({ error: "forbidden" });
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) return reply.status(404).send({ error: "PBX_LINK_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  await vitalDeleteByResource(getVitalPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }), resource, id, link.pbxTenantId || undefined);
  return { ok: true, resource };
});

app.get("/voice/pbx/call-recordings", async (req, reply) => {
  const user = await requirePermission(req, reply, canManageMessaging);
  if (!user) return;
  const query = z.object({
    extension: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    q: z.string().optional()
  }).parse(req.query || {});
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) return reply.status(404).send({ error: "PBX_LINK_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  const rows = await getVitalPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }).listCallRecordings({
    tenantId: link.pbxTenantId || undefined,
    extension: query.extension,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    q: query.q
  });
  return { rows };
});

app.get("/voice/pbx/call-reports", async (req, reply) => {
  const user = await requirePermission(req, reply, canManageMessaging);
  if (!user) return;
  const query = z.object({ dateFrom: z.string().optional(), dateTo: z.string().optional() }).parse(req.query || {});
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } });
  if (!link) return reply.status(404).send({ error: "PBX_LINK_NOT_FOUND" });
  const auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  const report = await getVitalPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret }).getCallReports({
    tenantId: link.pbxTenantId || undefined,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo
  });
  return { report };
});

app.get("/voice/pbx/cdr-history", async (req, reply) => {
  const user = await requirePermission(req, reply, canManageMessaging);
  if (!user) return;
  const q = z.object({
    tenantId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }).parse(req.query || {});

  const maxRows = q.limit ?? 200;
  const isSuper = user.role === "SUPER_ADMIN";

  let rows: any[];
  if (_pbxCdrCache.ts === 0 || Date.now() - _pbxCdrCache.ts > 120_000) {
    return reply.send({ items: [], stale: true, message: "CDR cache warming up — data will appear shortly." });
  }

  if (isSuper) {
    if (q.tenantId) {
      rows = _pbxCdrCache.byTenant.get(q.tenantId) || [];
      if (rows.length === 0) {
        const link = await db.tenantPbxLink.findUnique({ where: { tenantId: q.tenantId }, include: { tenant: true } });
        if (link) {
          const slug = normSlug(link.tenant?.name || "");
          if (slug) rows = _pbxCdrCache.byTenant.get(`vpbx:${slug}`) || [];
        }
      }
    } else {
      rows = _pbxCdrCache.rows;
    }
  } else {
    rows = _pbxCdrCache.byTenant.get(user.tenantId) || [];
    if (rows.length === 0) {
      const link = await db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { tenant: true } });
      if (link) {
        const slug = normSlug(link.tenant?.name || "");
        if (slug) rows = _pbxCdrCache.byTenant.get(`vpbx:${slug}`) || [];
      }
    }
  }

  // Format rows for client
  const sorted = rows.slice().sort((a: any, b: any) => {
    const ta = String(a?.calldate || a?.start || "");
    const tb = String(b?.calldate || b?.start || "");
    return tb.localeCompare(ta);
  });

  const items = sorted.slice(0, maxRows).map((r: any) => {
    const ct = Number(r?.calltype ?? r?.callType ?? 0);
    let direction = "unknown";
    if (ct === 1) direction = "internal";
    else if (ct === 2) direction = "incoming";
    else if (ct === 3) direction = "outgoing";
    else {
      const dir = String(r?.direction || r?.call_type || "").toLowerCase();
      if (dir.includes("in") && !dir.includes("internal")) direction = "incoming";
      else if (dir.includes("internal")) direction = "internal";
      else if (dir.includes("out")) direction = "outgoing";
    }
    const disp = String(r?.disposition || "").toUpperCase();
    const tid = String(r?.tenantid ?? r?.tenant_id ?? r?.tenant ?? "").trim();
    return {
      id: String(r?.uniqueid || r?.id || r?.cdr_id || ""),
      linkedId: String(r?.linkedid || r?.linkedId || ""),
      calldate: String(r?.calldate || r?.start || ""),
      src: String(r?.src || r?.source || ""),
      dst: String(r?.dst || r?.destination || ""),
      clid: String(r?.clid || r?.callerid || ""),
      direction,
      disposition: disp === "ANSWERED" ? "Answered" : disp === "NO ANSWER" ? "No Answer" : disp === "BUSY" ? "Busy" : disp || "Unknown",
      duration: Number(r?.duration || 0),
      billsec: Number(r?.billsec || 0),
      pbxTenantId: tid,
      dcontext: String(r?.dcontext || ""),
    };
  });

  return reply.send({
    items,
    total: rows.length,
    showing: items.length,
    asOf: new Date(_pbxCdrCache.ts).toISOString(),
    scope: isSuper && !q.tenantId ? "all" : "tenant",
  });
});

app.get("/billing/sola/config", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const record = await db.billingSolaConfig.findUnique({ where: { tenantId: admin.tenantId } });
  if (!record) {
    return { configured: false, config: null };
  }

  try {
    const resolved = await getTenantSolaConfig(admin.tenantId, { requireEnabled: false, allowFallbackEnv: false });
    return { configured: true, config: resolved.masked };
  } catch {
    return {
      configured: true,
      config: {
        id: record.id,
        tenantId: record.tenantId,
        configured: true,
        isEnabled: !!record.isEnabled,
        apiBaseUrl: record.apiBaseUrl,
        mode: record.mode === "PROD" ? "prod" : "sandbox",
        simulate: !!record.simulate,
        authMode: record.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
        authHeaderName: record.authHeaderName || null,
        pathOverrides: normalizeSolaPathOverrides(record.pathOverrides || {}),
        masked: { apiKey: null, apiSecret: null, webhookSecret: null },
        status: {
          lastTestAt: record.lastTestAt,
          lastTestResult: record.lastTestResult || null,
          lastTestErrorCode: record.lastTestErrorCode || null
        },
        meta: {
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          createdByUserId: record.createdByUserId,
          updatedByUserId: record.updatedByUserId
        }
      }
    };
  }
});

app.put("/billing/sola/config", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({
    apiBaseUrl: z.string().url(),
    mode: z.enum(["sandbox", "prod"]),
    simulate: z.boolean().default(false),
    authMode: z.enum(["xkey_body", "authorization_header"]),
    authHeaderName: z.string().min(1).max(64).optional().nullable(),
    apiKey: z.string().min(1).optional(),
    apiSecret: z.string().min(1).optional().nullable(),
    webhookSecret: z.string().min(1).optional().nullable(),
    pathOverrides: z.object({
      customerPath: z.string().min(1).optional(),
      subscriptionPath: z.string().min(1).optional(),
      transactionPath: z.string().min(1).optional(),
      hostedSessionPath: z.string().min(1).optional(),
      chargePath: z.string().min(1).optional(),
      cancelPath: z.string().min(1).optional()
    }).optional()
  }).parse(req.body || {});

  if (input.mode === "prod" && input.simulate) {
    return reply.status(400).send({ error: "INVALID_MODE", message: "simulate must be disabled when mode=prod" });
  }

  const existing = await db.billingSolaConfig.findUnique({ where: { tenantId: admin.tenantId } });
  let existingSecrets: BillingSolaCredentialPayload = { apiKey: "", apiSecret: null, webhookSecret: null };
  if (existing) {
    try {
      existingSecrets = decryptJson<BillingSolaCredentialPayload>(existing.credentialsEncrypted);
    } catch {
      return reply.status(400).send({ error: "SOLA_DECRYPT_FAILED" });
    }
  }

  const nextSecrets: BillingSolaCredentialPayload = {
    apiKey: input.apiKey || existingSecrets.apiKey || "",
    apiSecret: input.apiSecret !== undefined ? (input.apiSecret || null) : (existingSecrets.apiSecret || null),
    webhookSecret: input.webhookSecret !== undefined ? (input.webhookSecret || null) : (existingSecrets.webhookSecret || null)
  };

  if (!nextSecrets.apiKey) {
    return reply.status(400).send({ error: "SOLA_API_KEY_REQUIRED" });
  }

  const encrypted = encryptJson(nextSecrets);
  const pathOverrides = normalizeSolaPathOverrides(input.pathOverrides || existing?.pathOverrides || {});
  const isEnabled = false;

  const upserted = await db.billingSolaConfig.upsert({
    where: { tenantId: admin.tenantId },
    create: {
      tenantId: admin.tenantId,
      apiBaseUrl: input.apiBaseUrl,
      mode: input.mode === "prod" ? "PROD" : "SANDBOX",
      simulate: input.simulate,
      authMode: input.authMode === "authorization_header" ? "AUTHORIZATION_HEADER" : "XKEY_BODY",
      authHeaderName: input.authHeaderName || null,
      pathOverrides: pathOverrides as any,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      isEnabled,
      createdByUserId: admin.sub,
      updatedByUserId: admin.sub,
      lastTestResult: null,
      lastTestErrorCode: null,
      lastTestAt: null
    },
    update: {
      apiBaseUrl: input.apiBaseUrl,
      mode: input.mode === "prod" ? "PROD" : "SANDBOX",
      simulate: input.simulate,
      authMode: input.authMode === "authorization_header" ? "AUTHORIZATION_HEADER" : "XKEY_BODY",
      authHeaderName: input.authHeaderName || null,
      pathOverrides: pathOverrides as any,
      credentialsEncrypted: encrypted,
      credentialsKeyId: "v1",
      isEnabled,
      updatedByUserId: admin.sub,
      lastTestResult: null,
      lastTestErrorCode: null,
      lastTestAt: null
    }
  });

  await audit({
    tenantId: admin.tenantId,
    actorUserId: admin.sub,
    action: existing ? "SOLA_CREDENTIAL_UPDATED" : "SOLA_CREDENTIAL_CREATED",
    entityType: "BillingSolaConfig",
    entityId: upserted.id
  });

  const masked = maskSolaConfigForResponse({ record: upserted, secrets: nextSecrets, pathOverrides });
  return { ok: true, config: masked };
});

app.post("/billing/sola/config/test", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  let resolved: { source: "TENANT" | "ENV"; adapterConfig: SolaCardknoxConfig; record: any | null; masked: any | null };
  try {
    resolved = await getTenantSolaConfig(admin.tenantId, { requireEnabled: false, allowFallbackEnv: false });
  } catch (e: any) {
    const code = String(e?.code || "NOT_CONFIGURED");
    return reply.status(400).send({ error: code });
  }

  try {
    const result = await getSolaAdapter(resolved.adapterConfig).testConnection();
    const updated = await db.billingSolaConfig.update({
      where: { tenantId: admin.tenantId },
      data: { lastTestAt: new Date(), lastTestResult: "SUCCESS", lastTestErrorCode: null, updatedByUserId: admin.sub }
    });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SOLA_CREDENTIAL_TESTED_SUCCESS", entityType: "BillingSolaConfig", entityId: updated.id });
    return { ok: true, simulated: result.simulated, code: "OK" };
  } catch (e: any) {
    const code = String(e?.code || "SOLA_VALIDATION_FAILED");
    const updated = await db.billingSolaConfig.update({
      where: { tenantId: admin.tenantId },
      data: { lastTestAt: new Date(), lastTestResult: "FAILED", lastTestErrorCode: code, updatedByUserId: admin.sub }
    });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SOLA_CREDENTIAL_TESTED_FAILED", entityType: "BillingSolaConfig", entityId: updated.id });
    return reply.status(400).send({ error: "SOLA_VALIDATION_FAILED", code });
  }
});

app.post("/billing/sola/config/enable", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const record = await db.billingSolaConfig.findUnique({ where: { tenantId: admin.tenantId } });
  if (!record) return reply.status(404).send({ error: "NOT_CONFIGURED" });
  if (record.lastTestResult !== "SUCCESS") {
    return reply.status(400).send({ error: "SOLA_TEST_REQUIRED", message: "Run test connection successfully before enabling." });
  }

  const updated = await db.billingSolaConfig.update({ where: { tenantId: admin.tenantId }, data: { isEnabled: true, updatedByUserId: admin.sub } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SOLA_CREDENTIAL_ENABLED", entityType: "BillingSolaConfig", entityId: updated.id });
  return { ok: true, isEnabled: true, updatedAt: updated.updatedAt };
});

app.post("/billing/sola/config/disable", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const record = await db.billingSolaConfig.findUnique({ where: { tenantId: admin.tenantId } });
  if (!record) return reply.status(404).send({ error: "NOT_CONFIGURED" });

  const updated = await db.billingSolaConfig.update({ where: { tenantId: admin.tenantId }, data: { isEnabled: false, updatedByUserId: admin.sub } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "SOLA_CREDENTIAL_DISABLED", entityType: "BillingSolaConfig", entityId: updated.id });
  return { ok: true, isEnabled: false, updatedAt: updated.updatedAt };
});

app.get("/admin/billing/sola/tenants", async (req, reply) => {
  const admin = await requirePermission(req, reply, canAccessAdminBilling);
  if (!admin) return;

  const rows = await db.tenant.findMany({
    select: {
      id: true,
      name: true,
      billingSolaConfig: { select: { id: true, isEnabled: true, mode: true, simulate: true, lastTestAt: true, lastTestResult: true, lastTestErrorCode: true, updatedAt: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  return rows.map((r) => ({
    tenantId: r.id,
    tenantName: r.name,
    configured: !!r.billingSolaConfig,
    isEnabled: !!r.billingSolaConfig?.isEnabled,
    mode: r.billingSolaConfig ? (r.billingSolaConfig.mode === "PROD" ? "prod" : "sandbox") : null,
    simulate: r.billingSolaConfig ? !!r.billingSolaConfig.simulate : null,
    lastTestAt: r.billingSolaConfig?.lastTestAt || null,
    lastTestResult: r.billingSolaConfig?.lastTestResult || null,
    lastTestErrorCode: r.billingSolaConfig?.lastTestErrorCode || null,
    updatedAt: r.billingSolaConfig?.updatedAt || null
  }));
});

app.get("/admin/billing/sola/tenant/:id", async (req, reply) => {
  const admin = await requirePermission(req, reply, canAccessAdminBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const { id } = req.params as { id: string };
  const tenant = await db.tenant.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const record = await db.billingSolaConfig.findUnique({ where: { tenantId: id } });
  if (!record) return { tenantId: tenant.id, tenantName: tenant.name, configured: false, config: null };

  try {
    const resolved = await getTenantSolaConfig(id, { requireEnabled: false, allowFallbackEnv: false });
    return { tenantId: tenant.id, tenantName: tenant.name, configured: true, config: resolved.masked };
  } catch {
    return { tenantId: tenant.id, tenantName: tenant.name, configured: true, config: null };
  }
});

app.get("/settings/email", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const row = await db.emailProviderConfig.findUnique({ where: { tenantId: admin.tenantId } });
  if (!row) return { configured: false, config: null };

  let creds: EmailProviderCredentialPayload = {};
  try { creds = decryptJson<EmailProviderCredentialPayload>(row.credentialsEncrypted); } catch {}

  return {
    configured: true,
    config: {
      provider: row.provider,
      isEnabled: row.isEnabled,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      replyTo: row.replyTo,
      logoUrl: row.logoUrl,
      footerText: row.footerText,
      settings: row.settings || {},
      masked: {
        sendgridApiKey: creds.sendgridApiKey ? "********" : null,
        smtpHost: maskValue(creds.smtpHost || null, 2, 2),
        smtpPort: creds.smtpPort || null,
        smtpUser: maskValue(creds.smtpUser || null, 2, 2),
        smtpPass: creds.smtpPass ? "********" : null,
        smtpSecure: typeof creds.smtpSecure === "boolean" ? creds.smtpSecure : null
      },
      lastTestAt: row.lastTestAt,
      lastTestResult: row.lastTestResult,
      lastTestErrorCode: row.lastTestErrorCode,
      updatedAt: row.updatedAt
    }
  };
});

app.put("/settings/email", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const input = z.object({
    provider: z.enum(["SENDGRID", "SMTP", "GOOGLE_WORKSPACE"]),
    fromName: z.string().min(1).max(120).optional().nullable(),
    fromEmail: z.string().email().optional().nullable(),
    replyTo: z.string().email().optional().nullable(),
    logoUrl: z.string().url().optional().nullable(),
    footerText: z.string().max(500).optional().nullable(),
    sendgridApiKey: z.string().min(6).optional(),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpUser: z.string().min(1).optional(),
    smtpPass: z.string().min(1).optional(),
    smtpSecure: z.boolean().optional()
  }).parse(req.body || {});

  const existing = await db.emailProviderConfig.findUnique({ where: { tenantId: admin.tenantId } });
  let existingCreds: EmailProviderCredentialPayload = {};
  if (existing) {
    try { existingCreds = decryptJson<EmailProviderCredentialPayload>(existing.credentialsEncrypted); } catch {}
  }

  const creds: EmailProviderCredentialPayload = {
    sendgridApiKey: input.sendgridApiKey || existingCreds.sendgridApiKey || null,
    smtpHost: input.smtpHost || existingCreds.smtpHost || null,
    smtpPort: input.smtpPort ?? existingCreds.smtpPort ?? null,
    smtpUser: input.smtpUser || existingCreds.smtpUser || null,
    smtpPass: input.smtpPass || existingCreds.smtpPass || null,
    smtpSecure: input.smtpSecure ?? existingCreds.smtpSecure ?? null
  };

  if (input.provider === "SENDGRID" && !creds.sendgridApiKey) {
    return reply.status(400).send({ error: "SENDGRID_API_KEY_REQUIRED" });
  }
  if (input.provider === "GOOGLE_WORKSPACE") {
    creds.smtpHost = creds.smtpHost || "smtp-relay.gmail.com";
    creds.smtpPort = creds.smtpPort || 587;
    if (creds.smtpSecure === null || creds.smtpSecure === undefined) creds.smtpSecure = false;
  }
  if ((input.provider === "SMTP" || input.provider === "GOOGLE_WORKSPACE") && (!creds.smtpHost || !creds.smtpPort || !creds.smtpUser || !creds.smtpPass)) {
    return reply.status(400).send({ error: "SMTP_CONFIG_INCOMPLETE" });
  }

  const row = await db.emailProviderConfig.upsert({
    where: { tenantId: admin.tenantId },
    create: {
      tenantId: admin.tenantId,
      provider: input.provider,
      fromName: input.fromName || null,
      fromEmail: input.fromEmail || null,
      replyTo: input.replyTo || null,
      logoUrl: input.logoUrl || null,
      footerText: input.footerText || null,
      settings: {},
      credentialsEncrypted: encryptJson(creds),
      credentialsKeyId: "v1",
      isEnabled: false,
      createdByUserId: admin.sub,
      updatedByUserId: admin.sub,
      lastTestAt: null,
      lastTestResult: null,
      lastTestErrorCode: null
    },
    update: {
      provider: input.provider,
      fromName: input.fromName || null,
      fromEmail: input.fromEmail || null,
      replyTo: input.replyTo || null,
      logoUrl: input.logoUrl || null,
      footerText: input.footerText || null,
      credentialsEncrypted: encryptJson(creds),
      credentialsKeyId: "v1",
      isEnabled: false,
      updatedByUserId: admin.sub,
      lastTestAt: null,
      lastTestResult: null,
      lastTestErrorCode: null
    }
  });

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: existing ? "EMAIL_PROVIDER_UPDATED" : "EMAIL_PROVIDER_CREATED", entityType: "EmailProviderConfig", entityId: row.id });
  return { ok: true, provider: row.provider, isEnabled: row.isEnabled, updatedAt: row.updatedAt };
});

app.post("/settings/email/test", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  if (!ensureCredentialCrypto(reply)) return;

  const row = await db.emailProviderConfig.findUnique({ where: { tenantId: admin.tenantId } });
  if (!row) return reply.status(404).send({ error: "EMAIL_NOT_CONFIGURED" });

  try {
    const target = (row.fromEmail || "billing@connectcomunications.com").trim();
    await queueEmailJob({
      tenantId: admin.tenantId,
      type: "EMAIL_TEST",
      toEmail: target,
      subject: "Connect Communications email test",
      htmlBody: "<p>Email provider test successful.</p>",
      textBody: "Email provider test successful."
    });
    await db.emailProviderConfig.update({ where: { tenantId: admin.tenantId }, data: { isEnabled: true, lastTestAt: new Date(), lastTestResult: "SUCCESS", lastTestErrorCode: null, updatedByUserId: admin.sub } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "EMAIL_PROVIDER_TEST_SUCCESS", entityType: "EmailProviderConfig", entityId: row.id });
    return { ok: true };
  } catch (e: any) {
    await db.emailProviderConfig.update({ where: { tenantId: admin.tenantId }, data: { lastTestAt: new Date(), lastTestResult: "FAILED", lastTestErrorCode: String(e?.code || "EMAIL_TEST_FAILED"), updatedByUserId: admin.sub } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "EMAIL_PROVIDER_TEST_FAILED", entityType: "EmailProviderConfig", entityId: row.id });
    return reply.status(400).send({ error: "EMAIL_TEST_FAILED" });
  }
});

app.get("/customers", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const query = z.object({
    q: z.string().optional(),
    filter: z.enum(["overdue", "unpaid", "whatsapp", "email_only", "inactive"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional()
  }).parse(req.query || {});
  const q = (query.q || "").trim();
  const rows = await db.customer.findMany({
    where: {
      tenantId: admin.tenantId,
      status: query.filter === "inactive" ? "INACTIVE" : undefined,
      whatsappNumber: query.filter === "whatsapp" ? { not: null } : undefined,
      OR: q ? [
        { displayName: { contains: q, mode: "insensitive" } },
        { companyName: { contains: q, mode: "insensitive" } },
        { primaryEmail: { contains: q, mode: "insensitive" } },
        { primaryPhone: { contains: q } },
        { whatsappNumber: { contains: q } }
      ] : undefined
    },
    orderBy: { updatedAt: "desc" },
    take: query.limit || 100
  });

  const out = await Promise.all(rows.map(async (customer) => {
    const threadOr = [
      { customerId: customer.id },
      customer.whatsappNumber ? { contactNumber: customer.whatsappNumber } : null,
      customer.primaryPhone ? { contactNumber: customer.primaryPhone } : null
    ].filter(Boolean) as any[];
    const [unpaidInvoiceCount, unpaidBalance, overdueCount, latestInvoice, latestThread, latestEmail] = await Promise.all([
      db.invoice.count({
        where: {
          tenantId: admin.tenantId,
          customerId: customer.id,
          status: { in: ["DRAFT", "SENT", "OVERDUE"] }
        }
      }),
      db.invoice.aggregate({
        where: {
          tenantId: admin.tenantId,
          customerId: customer.id,
          status: { in: ["DRAFT", "SENT", "OVERDUE"] }
        },
        _sum: { amountCents: true }
      }),
      db.invoice.count({
        where: {
          tenantId: admin.tenantId,
          customerId: customer.id,
          status: "OVERDUE"
        }
      }),
      db.invoice.findFirst({ where: { tenantId: admin.tenantId, customerId: customer.id }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
      db.whatsAppThread.findFirst({
        where: {
          tenantId: admin.tenantId,
          OR: threadOr
        },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true }
      }),
      customer.primaryEmail
        ? db.emailJob.findFirst({ where: { tenantId: admin.tenantId, toEmail: customer.primaryEmail }, orderBy: { createdAt: "desc" }, select: { createdAt: true } })
        : Promise.resolve(null)
    ]);
    const latestActivityAt = [latestInvoice?.updatedAt, latestThread?.updatedAt, latestEmail?.createdAt]
      .filter(Boolean)
      .sort((a: any, b: any) => (new Date(b).getTime() - new Date(a).getTime()))[0] || customer.updatedAt;

    return {
      id: customer.id,
      displayName: customer.displayName,
      companyName: customer.companyName || null,
      primaryEmail: customer.primaryEmail || null,
      primaryPhone: customer.primaryPhone || null,
      whatsappNumber: customer.whatsappNumber || null,
      tags: Array.isArray(customer.tags) ? customer.tags : [],
      status: customer.status,
      lastContactAt: customer.lastContactAt || null,
      unpaidInvoiceCount,
      overdueInvoiceCount: overdueCount,
      unpaidBalanceCents: unpaidBalance._sum.amountCents || 0,
      latestActivityAt
    };
  }));
  const filtered = out.filter((row) => {
    if (query.filter === "overdue") return row.overdueInvoiceCount > 0;
    if (query.filter === "unpaid") return row.unpaidInvoiceCount > 0;
    if (query.filter === "email_only") return !!row.primaryEmail && !row.primaryPhone && !row.whatsappNumber;
    return true;
  });
  return filtered;
});

app.get("/customers/segments/summary", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [customers, overdueCustomerRows, unpaidCustomerRows] = await Promise.all([
    db.customer.findMany({
      where: { tenantId: admin.tenantId },
      select: { id: true, primaryEmail: true, primaryPhone: true, whatsappNumber: true, lastContactAt: true, status: true }
    }),
    db.invoice.groupBy({
      by: ["customerId"],
      where: { tenantId: admin.tenantId, status: "OVERDUE", customerId: { not: null } },
      _count: { _all: true }
    }),
    db.invoice.groupBy({
      by: ["customerId"],
      where: { tenantId: admin.tenantId, status: { in: ["DRAFT", "SENT", "OVERDUE"] }, customerId: { not: null } },
      _count: { _all: true }
    })
  ]);

  const overdueCustomerIds = new Set(overdueCustomerRows.map((r) => r.customerId).filter(Boolean));
  const unpaidCustomerIds = new Set(unpaidCustomerRows.map((r) => r.customerId).filter(Boolean));
  const noRecentContactCount = customers.filter((c) => !c.lastContactAt || c.lastContactAt < thirtyDaysAgo).length;
  const whatsappCount = customers.filter((c) => !!c.whatsappNumber).length;
  const emailOnlyCount = customers.filter((c) => !!c.primaryEmail && !c.primaryPhone && !c.whatsappNumber).length;
  const inactiveCount = customers.filter((c) => c.status === "INACTIVE").length;

  return {
    totals: {
      customers: customers.length,
      overdueCustomers: overdueCustomerIds.size,
      unpaidCustomers: unpaidCustomerIds.size,
      noRecentContact: noRecentContactCount,
      withWhatsApp: whatsappCount,
      emailOnly: emailOnlyCount,
      inactive: inactiveCount
    }
  };
});

app.get("/customers/segments/targeting", async (req, reply) => {
  const admin = await requirePermission(req, reply, canUseCustomerTargeting);
  if (!admin) return;
  const query = z.object({
    segment: z.enum(["overdue", "unpaid", "whatsapp"])
  }).parse(req.query || {});

  let customerIds: string[] = [];
  if (query.segment === "whatsapp") {
    const customers = await db.customer.findMany({
      where: { tenantId: admin.tenantId, whatsappNumber: { not: null } },
      select: { id: true }
    });
    customerIds = customers.map((c) => c.id);
  } else {
    const grouped = await db.invoice.groupBy({
      by: ["customerId"],
      where: {
        tenantId: admin.tenantId,
        customerId: { not: null },
        status: query.segment === "overdue" ? "OVERDUE" : { in: ["DRAFT", "SENT", "OVERDUE"] }
      },
      _count: { _all: true }
    });
    customerIds = grouped.map((g) => g.customerId).filter(Boolean) as string[];
  }

  if (customerIds.length === 0) {
    return { segment: query.segment, customers: [], recipients: [] };
  }

  const customers = await db.customer.findMany({
    where: { tenantId: admin.tenantId, id: { in: customerIds } },
    select: { id: true, displayName: true, primaryPhone: true, whatsappNumber: true }
  });
  const recipients = Array.from(new Set(customers.map((c) => c.primaryPhone || c.whatsappNumber).filter(Boolean))) as string[];
  return { segment: query.segment, customers, recipients };
});

app.post("/customers", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const input = z.object({
    displayName: z.string().min(1).max(160),
    companyName: z.string().max(160).optional().nullable(),
    primaryEmail: z.string().email().optional().nullable(),
    primaryPhone: z.string().min(5).max(40).optional().nullable(),
    whatsappNumber: z.string().min(5).max(40).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    status: z.enum(["ACTIVE", "PAST_DUE", "INACTIVE"]).optional(),
    lastContactAt: z.string().datetime().optional().nullable()
  }).parse(req.body || {});
  const created = await db.customer.create({
    data: {
      tenantId: admin.tenantId,
      displayName: input.displayName.trim(),
      companyName: input.companyName || null,
      primaryEmail: input.primaryEmail || null,
      primaryPhone: normalizeContactNumber(input.primaryPhone) || null,
      whatsappNumber: normalizeContactNumber(input.whatsappNumber) || null,
      notes: input.notes || null,
      tags: (input.tags || []) as any,
      status: input.status || "ACTIVE",
      lastContactAt: input.lastContactAt ? new Date(input.lastContactAt) : null
    }
  });
  const threadOr = [
    created.whatsappNumber ? { contactNumber: created.whatsappNumber } : null,
    created.primaryPhone ? { contactNumber: created.primaryPhone } : null
  ].filter(Boolean) as any[];
  if (threadOr.length > 0) {
    await db.whatsAppThread.updateMany({
      where: { tenantId: admin.tenantId, OR: threadOr },
      data: { customerId: created.id }
    });
  }
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "CUSTOMER_CREATED", entityType: "Customer", entityId: created.id });
  return created;
});

app.get("/customers/:id", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const row = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!row) return reply.status(404).send({ error: "customer_not_found" });
  return row;
});

app.put("/customers/:id", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const existing = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!existing) return reply.status(404).send({ error: "customer_not_found" });
  const input = z.object({
    displayName: z.string().min(1).max(160).optional(),
    companyName: z.string().max(160).optional().nullable(),
    primaryEmail: z.string().email().optional().nullable(),
    primaryPhone: z.string().min(5).max(40).optional().nullable(),
    whatsappNumber: z.string().min(5).max(40).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    status: z.enum(["ACTIVE", "PAST_DUE", "INACTIVE"]).optional(),
    lastContactAt: z.string().datetime().optional().nullable()
  }).parse(req.body || {});
  const updated = await db.customer.update({
    where: { id },
    data: {
      displayName: input.displayName?.trim(),
      companyName: input.companyName !== undefined ? (input.companyName || null) : undefined,
      primaryEmail: input.primaryEmail !== undefined ? (input.primaryEmail || null) : undefined,
      primaryPhone: input.primaryPhone !== undefined ? (normalizeContactNumber(input.primaryPhone) || null) : undefined,
      whatsappNumber: input.whatsappNumber !== undefined ? (normalizeContactNumber(input.whatsappNumber) || null) : undefined,
      notes: input.notes !== undefined ? (input.notes || null) : undefined,
      tags: input.tags !== undefined ? (input.tags as any) : undefined,
      status: input.status !== undefined ? input.status : undefined,
      lastContactAt: input.lastContactAt !== undefined ? (input.lastContactAt ? new Date(input.lastContactAt) : null) : undefined
    }
  });

  const threadOr = [
    input.whatsappNumber ? { contactNumber: normalizeContactNumber(input.whatsappNumber) || "" } : null,
    input.primaryPhone ? { contactNumber: normalizeContactNumber(input.primaryPhone) || "" } : null
  ].filter(Boolean) as any[];
  const linkedThreadIds = threadOr.length > 0
    ? await db.whatsAppThread.findMany({
        where: { tenantId: admin.tenantId, OR: threadOr },
        select: { id: true }
      })
    : [];
  if (linkedThreadIds.length > 0) {
    await db.whatsAppThread.updateMany({
      where: { id: { in: linkedThreadIds.map((t) => t.id) } },
      data: { customerId: updated.id }
    });
  }

  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "CUSTOMER_UPDATED", entityType: "Customer", entityId: updated.id });
  return updated;
});

app.get("/customers/:id/notes", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId }, select: { id: true } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });
  const rows = await db.customerNote.findMany({
    where: { tenantId: admin.tenantId, customerId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { createdByUser: { select: { id: true, email: true, role: true } } }
  });
  return rows.map((n) => ({
    id: n.id,
    body: n.body,
    createdAt: n.createdAt,
    createdByUser: n.createdByUser
  }));
});

app.post("/customers/:id/notes", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ body: z.string().min(1).max(5000) }).parse(req.body || {});
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });
  const note = await db.customerNote.create({
    data: {
      tenantId: admin.tenantId,
      customerId: id,
      body: input.body.trim(),
      createdByUserId: admin.sub
    }
  });
  await db.customer.update({ where: { id: customer.id }, data: { lastContactAt: new Date() } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "CUSTOMER_NOTE_CREATED", entityType: "Customer", entityId: id });
  return note;
});

app.put("/customers/:id/tags", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    tags: z.array(z.string().min(1).max(60)).max(20),
    status: z.enum(["ACTIVE", "PAST_DUE", "INACTIVE"]).optional()
  }).parse(req.body || {});
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });
  const updated = await db.customer.update({
    where: { id: customer.id },
    data: { tags: input.tags as any, status: input.status || customer.status }
  });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "CUSTOMER_TAGS_UPDATED", entityType: "Customer", entityId: id });
  return updated;
});

app.post("/customers/:id/send-reminder", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });
  const invoice = await db.invoice.findFirst({
    where: { tenantId: admin.tenantId, customerId: id, status: { in: ["DRAFT", "SENT", "OVERDUE"] } },
    orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
  });
  if (!invoice) return reply.status(404).send({ error: "unpaid_invoice_not_found" });

  const now = Date.now();
  const recentReminder = await db.invoiceEvent.findFirst({
    where: {
      invoiceId: invoice.id,
      type: { in: ["REMINDER_SENT", "OVERDUE_REMINDER_SENT"] },
      createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) }
    },
    orderBy: { createdAt: "desc" }
  });
  if (recentReminder) return reply.status(429).send({ error: "REMINDER_THROTTLED" });

  const payUrl = invoice.externalPaymentLink || (invoice.payToken ? `https://app.connectcomunications.com/pay/invoice/${invoice.payToken}` : null);
  if (!payUrl) return reply.status(400).send({ error: "PAY_LINK_MISSING" });
  await queueInvoiceReminderEmail({
    tenantId: admin.tenantId,
    invoiceId: invoice.id,
    to: invoice.customerEmail,
    amountCents: invoice.amountCents,
    payUrl,
    overdue: invoice.status === "OVERDUE"
  });
  await logInvoiceEvent({
    tenantId: admin.tenantId,
    invoiceId: invoice.id,
    type: invoice.status === "OVERDUE" ? "OVERDUE_REMINDER_SENT" : "REMINDER_SENT",
    payload: { source: "CUSTOMER_WORKFLOW", customerId: id }
  });
  await db.customer.update({ where: { id }, data: { lastContactAt: new Date() } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "CUSTOMER_REMINDER_SENT", entityType: "Customer", entityId: id });
  return { ok: true, invoiceId: invoice.id };
});

app.post("/customers/:id/send-invoice", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ invoiceId: z.string().optional() }).parse(req.body || {});
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });
  const invoice = input.invoiceId
    ? await db.invoice.findFirst({ where: { id: input.invoiceId, tenantId: admin.tenantId, customerId: id } })
    : await db.invoice.findFirst({
        where: { tenantId: admin.tenantId, customerId: id, status: { in: ["DRAFT", "SENT", "OVERDUE"] } },
        orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
      });
  if (!invoice) return reply.status(404).send({ error: "invoice_not_found" });
  if (invoice.status === "PAID") return reply.status(400).send({ error: "INVOICE_ALREADY_PAID" });
  if (invoice.status === "VOID") return reply.status(400).send({ error: "INVOICE_VOIDED" });

  const payToken = invoice.payToken || `inv_${randomBytes(18).toString("hex")}`;
  const payUrl = `https://app.connectcomunications.com/pay/invoice/${payToken}`;
  const updated = await db.invoice.update({
    where: { id: invoice.id },
    data: {
      status: invoice.status === "OVERDUE" ? "OVERDUE" : "SENT",
      payToken,
      payTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      externalPaymentLink: payUrl
    }
  });
  await queueInvoiceCreatedEmail({ tenantId: admin.tenantId, invoiceId: updated.id, to: updated.customerEmail, amountCents: updated.amountCents, payUrl });
  await logInvoiceEvent({ tenantId: admin.tenantId, invoiceId: updated.id, type: "SENT", payload: { source: "CUSTOMER_WORKFLOW" } });
  await db.customer.update({ where: { id }, data: { lastContactAt: new Date() } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "CUSTOMER_INVOICE_SENT", entityType: "Customer", entityId: id });
  return { ok: true, invoice: updated };
});

app.get("/customers/:id/activity", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });

  const invoiceIds = (await db.invoice.findMany({ where: { tenantId: admin.tenantId, customerId: id }, select: { id: true } })).map((r) => r.id);
  const smsOr = [customer.primaryPhone ? { toNumber: customer.primaryPhone } : null, customer.whatsappNumber ? { toNumber: customer.whatsappNumber } : null].filter(Boolean) as any[];
  const waOr = [{ customerId: id }, customer.whatsappNumber ? { contactNumber: customer.whatsappNumber } : null, customer.primaryPhone ? { contactNumber: customer.primaryPhone } : null].filter(Boolean) as any[];
  const emailOr = [customer.primaryEmail ? { toEmail: customer.primaryEmail } : null, invoiceIds.length ? { invoiceId: { in: invoiceIds } } : null].filter(Boolean) as any[];

  const [invoiceEvents, paymentEvents, emailEvents, whatsappEvents, smsEvents, notes, tasks, pbxEvents] = await Promise.all([
    invoiceIds.length ? db.invoiceEvent.findMany({ where: { tenantId: admin.tenantId, invoiceId: { in: invoiceIds } }, orderBy: { createdAt: "desc" }, take: 100 }) : Promise.resolve([]),
    invoiceIds.length ? db.paymentEvent.findMany({ where: { tenantId: admin.tenantId, subscriptionId: { in: invoiceIds } }, orderBy: { createdAt: "desc" }, take: 100 }) : Promise.resolve([]),
    emailOr.length ? db.emailJob.findMany({ where: { tenantId: admin.tenantId, OR: emailOr }, orderBy: { createdAt: "desc" }, take: 100 }) : Promise.resolve([]),
    db.whatsAppMessage.findMany({ where: { tenantId: admin.tenantId, thread: { is: { OR: waOr } } }, orderBy: { createdAt: "desc" }, take: 100 }),
    smsOr.length ? db.smsMessage.findMany({ where: { campaign: { tenantId: admin.tenantId }, OR: smsOr }, orderBy: { createdAt: "desc" }, take: 100 }) : Promise.resolve([]),
    db.customerNote.findMany({ where: { tenantId: admin.tenantId, customerId: id }, orderBy: { createdAt: "desc" }, take: 100, include: { createdByUser: { select: { email: true } } } }),
    db.customerTask.findMany({ where: { tenantId: admin.tenantId, customerId: id }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.pbxCallEvent.findMany({ where: { tenantId: admin.tenantId, customerId: id }, orderBy: { createdAt: "desc" }, take: 100 })
  ]);

  const timeline: Array<{ type: string; createdAt: Date; label: string; meta?: any }> = [];
  for (const e of invoiceEvents) timeline.push({ type: `INVOICE_${e.type}`, createdAt: e.createdAt, label: `Invoice ${e.type.toLowerCase()}`, meta: { invoiceId: e.invoiceId } });
  for (const e of paymentEvents) timeline.push({ type: "PAYMENT_EVENT", createdAt: e.createdAt, label: `Payment ${String(e.status || "").toLowerCase()}`, meta: { amountCents: e.amountCents, currency: e.currency } });
  for (const e of emailEvents) timeline.push({ type: "EMAIL_EVENT", createdAt: e.createdAt, label: `Email ${String(e.status || "").toLowerCase()} (${e.type})` });
  for (const e of whatsappEvents) timeline.push({ type: "WHATSAPP_EVENT", createdAt: e.createdAt, label: `WhatsApp ${String(e.direction || "").toLowerCase()} ${String(e.status || "").toLowerCase()}` });
  for (const e of smsEvents) timeline.push({ type: "SMS_EVENT", createdAt: e.createdAt, label: `SMS ${String(e.status || "").toLowerCase()}` });
  for (const n of notes) timeline.push({ type: "NOTE", createdAt: n.createdAt, label: `Note added by ${n.createdByUser?.email || "staff"}`, meta: { body: n.body } });
  for (const t of tasks) timeline.push({ type: "TASK", createdAt: t.createdAt, label: `Task ${String(t.status || "").toLowerCase()}: ${t.title}` });
  for (const p of pbxEvents) timeline.push({ type: "CALL_EVENT", createdAt: p.createdAt, label: `Call ${String(p.status || "").toLowerCase()} (${p.eventType})` });
  timeline.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    customer: {
      id: customer.id,
      displayName: customer.displayName,
      status: customer.status,
      tags: Array.isArray(customer.tags) ? customer.tags : [],
      lastContactAt: customer.lastContactAt || null
    },
    timeline: timeline.slice(0, 250)
  };
});

app.get("/customers/:id/tasks", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const rows = await db.customerTask.findMany({ where: { tenantId: admin.tenantId, customerId: id }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
  return { rows };
});

app.post("/customers/:id/tasks", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    title: z.string().min(2),
    body: z.string().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    dueAt: z.string().optional()
  }).parse(req.body || {});
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });
  const created = await db.customerTask.create({
    data: {
      tenantId: admin.tenantId,
      customerId: customer.id,
      title: input.title.trim(),
      body: input.body?.trim() || null,
      priority: input.priority,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      createdByUserId: admin.sub
    }
  });
  return { ok: true, task: created };
});

app.patch("/customers/:id/tasks/:taskId", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const { id, taskId } = req.params as { id: string; taskId: string };
  const input = z.object({
    title: z.string().min(2).optional(),
    body: z.string().optional().nullable(),
    status: z.enum(["OPEN", "DONE"]).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    dueAt: z.string().optional().nullable()
  }).parse(req.body || {});
  const curr = await db.customerTask.findFirst({ where: { id: taskId, customerId: id, tenantId: admin.tenantId } });
  if (!curr) return reply.status(404).send({ error: "task_not_found" });
  const updated = await db.customerTask.update({
    where: { id: curr.id },
    data: {
      title: input.title?.trim(),
      body: input.body === undefined ? undefined : (input.body?.trim() || null),
      status: input.status,
      priority: input.priority,
      dueAt: input.dueAt === undefined ? undefined : (input.dueAt ? new Date(input.dueAt) : null),
      completedAt: input.status === "DONE" ? new Date() : input.status === "OPEN" ? null : undefined,
      completedByUserId: input.status === "DONE" ? admin.sub : input.status === "OPEN" ? null : undefined
    }
  });
  return { ok: true, task: updated };
});

app.get("/automation/rules", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const rows = await db.automationRule.findMany({ where: { tenantId: admin.tenantId }, orderBy: { createdAt: "desc" } });
  return { rows };
});

app.post("/automation/rules", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const input = z.object({
    name: z.string().min(2),
    triggerType: z.enum(["INVOICE_OVERDUE", "PAYMENT_FAILED", "NEW_CUSTOMER", "WHATSAPP_INBOUND"]),
    actionType: z.enum(["SEND_SMS", "SEND_EMAIL", "TAG_CUSTOMER", "CREATE_TASK"]),
    actionPayload: z.record(z.any()).optional(),
    isEnabled: z.boolean().default(true)
  }).parse(req.body || {});
  const created = await db.automationRule.create({
    data: {
      tenantId: admin.tenantId,
      name: input.name.trim(),
      triggerType: input.triggerType,
      actionType: input.actionType,
      actionPayload: (input.actionPayload || {}) as any,
      isEnabled: input.isEnabled,
      createdByUserId: admin.sub
    }
  });
  return { ok: true, rule: created };
});

app.patch("/automation/rules/:id", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageCustomerWorkflow);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    name: z.string().min(2).optional(),
    actionPayload: z.record(z.any()).optional(),
    isEnabled: z.boolean().optional()
  }).parse(req.body || {});
  const curr = await db.automationRule.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!curr) return reply.status(404).send({ error: "rule_not_found" });
  const updated = await db.automationRule.update({
    where: { id },
    data: {
      name: input.name?.trim(),
      actionPayload: input.actionPayload ? (input.actionPayload as any) : undefined,
      isEnabled: input.isEnabled
    }
  });
  return { ok: true, rule: updated };
});

app.get("/voice/ivr/schedules", async (req, reply) => {
  const user = await requirePermission(req, reply, canManageMessaging);
  if (!user) return;
  const rows = await db.ivrSchedule.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
  return { rows };
});

app.post("/voice/ivr/schedules", async (req, reply) => {
  const user = await requirePermission(req, reply, canManageMessaging);
  if (!user) return;
  const input = z.object({
    ivrId: z.string().min(1),
    recordingId: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    timezone: z.string().default("UTC"),
    enabled: z.boolean().default(true)
  }).parse(req.body || {});
  const created = await db.ivrSchedule.create({
    data: {
      tenantId: user.tenantId,
      ivrId: input.ivrId,
      recordingId: input.recordingId,
      startTime: new Date(input.startTime),
      endTime: new Date(input.endTime),
      timezone: input.timezone,
      enabled: input.enabled
    }
  });
  return { ok: true, schedule: created };
});

app.patch("/voice/ivr/schedules/:id", async (req, reply) => {
  const user = await requirePermission(req, reply, canManageMessaging);
  if (!user) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    recordingId: z.string().min(1).optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    timezone: z.string().optional(),
    enabled: z.boolean().optional()
  }).parse(req.body || {});
  const curr = await db.ivrSchedule.findFirst({ where: { id, tenantId: user.tenantId } });
  if (!curr) return reply.status(404).send({ error: "schedule_not_found" });
  const updated = await db.ivrSchedule.update({
    where: { id },
    data: {
      recordingId: input.recordingId,
      startTime: input.startTime ? new Date(input.startTime) : undefined,
      endTime: input.endTime ? new Date(input.endTime) : undefined,
      timezone: input.timezone,
      enabled: input.enabled
    }
  });
  return { ok: true, schedule: updated };
});

app.get("/customers/:id/summary", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const customer = await db.customer.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!customer) return reply.status(404).send({ error: "customer_not_found" });

  const customerInvoiceIds = (await db.invoice.findMany({
    where: { tenantId: admin.tenantId, customerId: customer.id },
    select: { id: true }
  })).map((r) => r.id);

  const smsOr = [
    customer.primaryPhone ? { toNumber: customer.primaryPhone } : null,
    customer.whatsappNumber ? { toNumber: customer.whatsappNumber } : null
  ].filter(Boolean) as any[];
  const waOr = [
    { customerId: customer.id },
    customer.whatsappNumber ? { contactNumber: customer.whatsappNumber } : null,
    customer.primaryPhone ? { contactNumber: customer.primaryPhone } : null
  ].filter(Boolean) as any[];
  const [invoiceCounts, invoiceUnpaidSum, recentInvoices, recentInvoiceEvents, recentPaymentEvents, recentSms, whatsappThreads, latestEmailJobs] = await Promise.all([
    db.invoice.groupBy({
      by: ["status"],
      where: { tenantId: admin.tenantId, customerId: customer.id },
      _count: { _all: true }
    }),
    db.invoice.aggregate({
      where: { tenantId: admin.tenantId, customerId: customer.id, status: { in: ["DRAFT", "SENT", "OVERDUE"] } },
      _sum: { amountCents: true }
    }),
    db.invoice.findMany({
      where: { tenantId: admin.tenantId, customerId: customer.id },
      orderBy: { createdAt: "desc" },
      take: 10
    }),
    customerInvoiceIds.length
      ? db.invoiceEvent.findMany({
          where: { tenantId: admin.tenantId, invoiceId: { in: customerInvoiceIds } },
          orderBy: { createdAt: "desc" },
          take: 20
        })
      : Promise.resolve([]),
    customerInvoiceIds.length
      ? db.paymentEvent.findMany({
          where: { tenantId: admin.tenantId, subscriptionId: { in: customerInvoiceIds } },
          orderBy: { createdAt: "desc" },
          take: 20
        })
      : Promise.resolve([]),
    smsOr.length > 0
      ? db.smsMessage.findMany({
          where: { campaign: { tenantId: admin.tenantId }, OR: smsOr },
          orderBy: { createdAt: "desc" },
          take: 20,
          include: { campaign: { select: { id: true, name: true } } }
        })
      : Promise.resolve([]),
    db.whatsAppThread.findMany({
      where: {
        tenantId: admin.tenantId,
        OR: waOr
      },
      orderBy: { updatedAt: "desc" },
      take: 20
    }),
    (() => {
      const emailOr = [
        customer.primaryEmail ? { toEmail: customer.primaryEmail } : null,
        customerInvoiceIds.length ? { invoiceId: { in: customerInvoiceIds } } : null
      ].filter(Boolean) as any[];
      if (emailOr.length === 0) return Promise.resolve([]);
      return db.emailJob.findMany({
        where: { tenantId: admin.tenantId, OR: emailOr },
        orderBy: { createdAt: "desc" },
        take: 20
      });
    })()
  ]);

  const byStatus: Record<string, number> = { DRAFT: 0, SENT: 0, OVERDUE: 0, PAID: 0, VOID: 0 };
  let totalInvoiceCount = 0;
  for (const row of invoiceCounts) {
    byStatus[row.status] = row._count._all;
    totalInvoiceCount += row._count._all;
  }
  const unpaidCount = (byStatus.DRAFT || 0) + (byStatus.SENT || 0) + (byStatus.OVERDUE || 0);

  return {
    customer,
    invoices: {
      count: totalInvoiceCount,
      unpaidCount,
      unpaidBalanceCents: invoiceUnpaidSum._sum.amountCents || 0,
      byStatus,
      recent: recentInvoices
    },
    recentInvoiceEvents,
    recentPaymentEvents: recentPaymentEvents.map((e) => ({
      id: e.id,
      type: e.type,
      status: e.status,
      amountCents: e.amountCents,
      currency: e.currency,
      createdAt: e.createdAt
    })),
    smsActivity: {
      totalRecent: recentSms.length,
      latestAt: recentSms[0]?.createdAt || null,
      recent: recentSms.map((m) => ({
        id: m.id,
        campaignId: m.campaignId,
        campaignName: m.campaign?.name || null,
        toNumber: maskValue(m.toNumber, 3, 2),
        status: m.status,
        createdAt: m.createdAt
      }))
    },
    whatsappActivity: {
      threadCount: whatsappThreads.length,
      latestThread: whatsappThreads[0]
        ? {
            id: whatsappThreads[0].id,
            contactNumberMasked: maskValue(whatsappThreads[0].contactNumber, 3, 2),
            lastMessageAt: whatsappThreads[0].lastMessageAt,
            lastStatus: whatsappThreads[0].lastStatus || null
          }
        : null
    },
    emailActivity: latestEmailJobs.map((j) => ({
      id: j.id,
      type: j.type,
      toEmail: maskValue(j.toEmail, 2, 8),
      status: j.status,
      createdAt: j.createdAt,
      sentAt: j.sentAt || null,
      lastErrorCode: j.lastErrorCode || null
    }))
  };
});

const DASHBOARD_CALL_TRAFFIC_CACHE = new Map<string, { at: number; payload: any }>();

function normalizeCallDirection(input: any): "incoming" | "outgoing" | "internal" {
  const numericType = Number(input?.calltype ?? input?.callType ?? input?.type_code ?? input?.direction_code);
  if (numericType === 1) return "internal";
  if (numericType === 2) return "incoming";
  if (numericType === 3) return "outgoing";
  const raw = String(
    input?.direction
      || input?.callDirection
      || input?.disposition
      || input?.call_type
      || input?.type
      || input?.dir
      || ""
  ).toLowerCase();
  if (raw.includes("internal")) return "internal";
  if (raw.includes("in")) return "incoming";
  if (raw.includes("out")) return "outgoing";
  return "outgoing";
}

function extractCallTimestampMs(input: any): number | null {
  const raw = input?.startedAt || input?.start || input?.calldate || input?.createdAt || input?.date || input?.timestamp || input?.end || input?.answeredAt;
  if (!raw) return null;
  if (typeof raw === "number") return raw > 1_000_000_000_000 ? raw : raw * 1000;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
  }
  const text = String(raw).trim();
  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (slashMatch) {
    const [, dd, mm, yyyy, hh, min, ss] = slashMatch;
    const ts = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss || "0"));
    return Number.isFinite(ts) ? ts : null;
  }
  const dashMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dashMatch) {
    const [, yyyy, mm, dd, hh, min, ss] = dashMatch;
    const ts = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss || "0"));
    return Number.isFinite(ts) ? ts : null;
  }
  const ts = new Date(text).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function extractReportItems(report: any): any[] {
  if (Array.isArray(report)) return report;
  const containers = [report, report?.data, report?.result, report?.report, report?.data?.data].filter(Boolean);
  for (const box of containers) {
    if (Array.isArray(box)) return box;
    if (Array.isArray(box?.items)) return box.items;
    if (Array.isArray(box?.rows)) return box.rows;
    if (Array.isArray(box?.records)) return box.records;
    if (Array.isArray(box?.cdr)) return box.cdr;
    if (Array.isArray(box?.cdrs)) return box.cdrs;
    if (Array.isArray(box?.calls)) return box.calls;
    if (Array.isArray(box?.data)) return box.data;
  }
  return [];
}

// ─── CDR tenant rules cache ───────────────────────────────────────────────────
// In-memory cache of CdrTenantRule rows. Refreshed on first use and on every rule write.
let _cdrRulesCache: Array<{ matchType: string; matchValue: string; tenantSlug: string }> | null = null;

async function getCdrTenantRules() {
  if (!_cdrRulesCache) {
    _cdrRulesCache = await db.cdrTenantRule.findMany({
      select: { matchType: true, matchValue: true, tenantSlug: true },
    });
  }
  return _cdrRulesCache;
}

function invalidateCdrRulesCache() {
  _cdrRulesCache = null;
}

/** Resolve a VitalPBX tenantId ("vpbx:{slug}") from CDR numbers using admin-configured rules. */
async function resolveTenantFromRules(fromNumber: string | null, toNumber: string | null): Promise<string | null> {
  const rules = await getCdrTenantRules();
  for (const rule of rules) {
    if (rule.matchType === "did" && toNumber) {
      if (toNumber === rule.matchValue || toNumber.replace(/^\+1/, "") === rule.matchValue) {
        return `vpbx:${rule.tenantSlug}`;
      }
    }
    if (rule.matchType === "from_did" && fromNumber) {
      if (fromNumber === rule.matchValue || fromNumber.replace(/^\+1/, "") === rule.matchValue) {
        return `vpbx:${rule.tenantSlug}`;
      }
    }
    if (rule.matchType === "extension_prefix" && fromNumber) {
      if (fromNumber.startsWith(rule.matchValue)) {
        return `vpbx:${rule.tenantSlug}`;
      }
    }
  }
  return null;
}

// ─── VitalPBX tenant cache for CDR tenant resolution ─────────────────────────
// Caches the VitalPBX tenant list so CDR ingest doesn't hit the API on every call.
// Lookup map keys: lowercased tenant name slug AND numeric tenant ID (both → vpbx:slug).
let _vpbxTenantCache: { entries: Array<{ name: string; numericId: string }>; fetchedAt: number } | null = null;
const VPBX_TENANT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getVpbxTenantLookup(): Promise<Map<string, string>> {
  const now = Date.now();
  if (!_vpbxTenantCache || now - _vpbxTenantCache.fetchedAt > VPBX_TENANT_CACHE_TTL_MS) {
    try {
      // Use the DB-stored PbxInstance (same approach as /admin/pbx/tenants route)
      const instance = await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
      if (!instance) throw new Error("no enabled PbxInstance found");
      const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
      const client = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret });
      const tenants = await client.listTenants();
      _vpbxTenantCache = {
        entries: tenants
          .filter((t: any) => t && typeof t === "object")
          .map((t: any) => ({
            name: String(t.name || "").trim(),
            numericId: String(t.tenant_id ?? t.id ?? "").trim(),
          }))
          .filter((t: any) => t.name),
        fetchedAt: now,
      };
      app.log.debug({ count: _vpbxTenantCache.entries.length }, "cdr-ingest: VitalPBX tenant cache refreshed");
    } catch (err: any) {
      app.log.warn({ err: err?.message }, "cdr-ingest: VitalPBX tenant cache refresh failed");
      if (!_vpbxTenantCache) return new Map();
    }
  }
  const map = new Map<string, string>();
  for (const t of _vpbxTenantCache!.entries) {
    // Key by lowercased name slug → vpbx:name (preserving original case from VitalPBX)
    if (t.name) map.set(t.name.toLowerCase(), `vpbx:${t.name}`);
    // Key by numeric ID string → same vpbx:name
    if (t.numericId && /^\d+$/.test(t.numericId)) map.set(t.numericId, `vpbx:${t.name}`);
  }
  return map;
}

/** Normalize a string for fuzzy tenant slug matching.
 *  Replaces hyphens with underscores and lowercases — so "Relax-Tires" matches "relax_tires". */
function normSlug(s: string): string {
  return s.toLowerCase().replace(/-/g, "_");
}

/** Try to extract a tenantId (vpbx:slug) from Asterisk channel names using VitalPBX tenant lookup.
 *  VitalPBX names PJSIP endpoints like "{numericTenantId}_{tenantSlug}-{uniqueid}"
 *  e.g. "PJSIP/344822_Comfortone-00003060" → match "344822" or "Comfortone" against tenant list.
 *  Also builds a normalized (hyphen→underscore) lookup to handle naming mismatches. */
function resolveTenantFromChannels(channels: string[], tenantMap: Map<string, string>): string | null {
  // Build normalized slug map (handles hyphen/underscore mismatch in endpoint names)
  const normMap = new Map<string, string>();
  for (const [key, val] of tenantMap) {
    normMap.set(normSlug(key), val);
  }

  for (const channel of channels) {
    const m = /PJSIP\/([^-]+(?:-[^-]+)*?)-[\da-f]{8}/i.exec(channel) ??
              /PJSIP\/([^-]+)-/.exec(channel);
    if (!m) continue;
    const endpoint = m[1]!; // e.g. "344822_Comfortone" or "relax_tires"
    // Try exact lookup first
    const full = tenantMap.get(endpoint.toLowerCase()) ?? normMap.get(normSlug(endpoint));
    if (full) return full;
    // Split by underscore and try each part (handles "{numericId}_{slug}")
    for (const part of endpoint.split("_")) {
      if (!part) continue;
      const hit = tenantMap.get(part.toLowerCase()) ?? normMap.get(normSlug(part));
      if (hit) return hit;
    }
    // Also split by hyphen for endpoint names like "Relax-Tires"
    for (const part of endpoint.split("-")) {
      if (!part) continue;
      const hit = tenantMap.get(part.toLowerCase()) ?? normMap.get(normSlug(part));
      if (hit) return hit;
    }
  }
  return null;
}

/** Try to extract a tenantId (vpbx:slug) from AMI dcontext using VitalPBX tenant list.
 *  VitalPBX names contexts like "ext-local-relax_tires", "from-pstn-relax_tires",
 *  "app-queue-relax_tires", "app-dial-relax_tires", etc.
 *  Strategy: check if the dcontext ends with a known tenant slug (case-insensitive + normalized). */
function resolveTenantFromDcontext(dcontext: string | null | undefined, tenantMap: Map<string, string>): string | null {
  if (!dcontext) return null;

  // Build normalized slug map
  const normMap = new Map<string, string>();
  for (const [key, val] of tenantMap) {
    normMap.set(normSlug(key), val);
  }

  const ctx = dcontext.trim();
  // Check all known VitalPBX context prefixes — slug follows the last "-"
  const VPBX_CTX_PREFIXES = [
    "ext-local-", "from-pstn-", "from-internal-", "from-trunk-",
    "outbound-", "from-external-",
    "app-queue-", "app-dial-", "app-ringgroup-", "app-announcement-",
    "app-followme-", "app-blacklist-", "app-voicemail-", "app-dnd-",
    "macro-dial-exec-",
  ];
  for (const pfx of VPBX_CTX_PREFIXES) {
    if (ctx.toLowerCase().startsWith(pfx)) {
      const slug = ctx.slice(pfx.length).trim();
      if (!slug || /^\d+$/.test(slug)) continue;
      // Try exact match first, then normalized
      const hit = tenantMap.get(slug.toLowerCase()) ?? normMap.get(normSlug(slug));
      if (hit) return hit;
      // Also return direct slug if it looks like a real tenant name (not in tenant list yet)
      if (slug.length > 2) return `vpbx:${slug}`;
    }
  }

  // Fallback: check if any tenant slug appears as the last path segment of the context
  // e.g. "custom-context-relax_tires" → "relax_tires"
  const lastSegment = ctx.split("-").pop() ?? "";
  if (lastSegment.length > 2 && !/^\d+$/.test(lastSegment)) {
    const hit = tenantMap.get(lastSegment.toLowerCase()) ?? normMap.get(normSlug(lastSegment));
    if (hit) return hit;
  }

  return null;
}

// ─── Connect CDR ingest ──────────────────────────────────────────────────────
// Internal endpoint: the telephony service POSTs completed call data here.
// No user auth required — secured by a shared CDR_INGEST_SECRET header.
// Performs an upsert by linkedId to prevent duplicate rows.
app.post("/internal/cdr-ingest", async (req, reply) => {
  const secret = process.env.CDR_INGEST_SECRET?.trim();
  const incoming = String((req.headers as Record<string, string | undefined>)["x-cdr-secret"] || "").trim();
  if (secret) {
    if (!incoming) return reply.code(401).send({ error: "missing secret" });
    // Constant-time compare
    const a = Buffer.from(incoming.padEnd(64, "\0").slice(0, 64));
    const b = Buffer.from(secret.padEnd(64, "\0").slice(0, 64));
    if (!timingSafeEqual(a, b)) return reply.code(403).send({ error: "forbidden" });
  }

  const schema = z.object({
    linkedId:    z.string().min(1),
    tenantId:    z.string().nullable().optional(),
    fromNumber:  z.string().nullable().optional(),
    toNumber:    z.string().nullable().optional(),
    direction:   z.enum(["incoming", "outgoing", "internal", "unknown"]),
    disposition: z.enum(["answered", "missed", "busy", "failed", "canceled", "unknown"]),
    startedAt:   z.string().datetime(),
    answeredAt:  z.string().datetime().nullable().optional(),
    endedAt:     z.string().datetime(),
    durationSec: z.number().int().min(0).default(0),
    talkSec:     z.number().int().min(0).default(0),
    queueId:     z.string().nullable().optional(),
    hangupCause: z.string().nullable().optional(),
    channels:    z.array(z.string()).optional().default([]),
    dcontext:    z.string().nullable().optional(),    // AMI Cdr dcontext — "ext-local-{slug}", "app-queue-{slug}", etc.
    accountCode: z.string().nullable().optional(),    // AMI Cdr accountCode — sometimes set to tenant slug
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid payload", issues: parsed.error.issues });
  }
  const d = parsed.data;

  // Multi-strategy tenant resolution (each only runs if previous strategies fail):
  // 1. Trust tenantId from telephony service (resolved via AMI context at call time)
  // 2. dcontext from AMI Cdr event — most reliable: "ext-local-{slug}", "app-queue-{slug}", etc.
  // 3. PJSIP channel endpoint name — "PJSIP/{numericId}_{slug}-{uniqueid}"
  // 4. Admin-configured CdrTenantRule — DID/extension prefix mappings configured in admin UI
  let resolvedTenantId = d.tenantId ?? null;

  if (!resolvedTenantId && (d.dcontext || d.accountCode)) {
    try {
      const tenantMap = await getVpbxTenantLookup();
      const fromDcontext = resolveTenantFromDcontext(d.dcontext, tenantMap);
      if (fromDcontext) {
        resolvedTenantId = fromDcontext;
        app.log.info({ linkedId: d.linkedId, tenantId: resolvedTenantId, dcontext: d.dcontext }, "cdr-ingest: tenantId resolved from dcontext");
      } else if (d.accountCode && d.accountCode.trim() && !/^\d+$/.test(d.accountCode.trim())) {
        // accountCode fallback — some VitalPBX setups use this for tenant slug
        const codeSlug = d.accountCode.trim();
        const hit = tenantMap.get(codeSlug.toLowerCase());
        if (hit) {
          resolvedTenantId = hit;
          app.log.info({ linkedId: d.linkedId, tenantId: resolvedTenantId, accountCode: d.accountCode }, "cdr-ingest: tenantId resolved from accountCode");
        }
      }
    } catch (err: any) {
      app.log.warn({ err: err?.message }, "cdr-ingest: dcontext tenant resolution error (non-fatal)");
    }
  }

  if (!resolvedTenantId && d.channels.length > 0) {
    try {
      const tenantMap = await getVpbxTenantLookup();
      const fromChannels = resolveTenantFromChannels(d.channels, tenantMap);
      if (fromChannels) {
        resolvedTenantId = fromChannels;
        app.log.info({ linkedId: d.linkedId, tenantId: resolvedTenantId }, "cdr-ingest: tenantId resolved from channels");
      }
    } catch (err: any) {
      app.log.warn({ err: err?.message }, "cdr-ingest: channel tenant resolution error (non-fatal)");
    }
  }

  if (!resolvedTenantId) {
    try {
      const fromRules = await resolveTenantFromRules(d.fromNumber ?? null, d.toNumber ?? null);
      if (fromRules) {
        resolvedTenantId = fromRules;
        app.log.info({ linkedId: d.linkedId, tenantId: resolvedTenantId }, "cdr-ingest: tenantId resolved from CdrTenantRule");
      }
    } catch (err: any) {
      app.log.warn({ err: err?.message }, "cdr-ingest: CdrTenantRule lookup error (non-fatal)");
    }
  }

  // Apply deterministic direction override before storage.
  // Multi-leg AMI events can set direction from the wrong channel (e.g. trunk leg
  // of an outbound call reports context=from-trunk → "inbound").  The number-pattern
  // rules are unambiguous: short extension → long PSTN = outgoing, and vice versa.
  const resolvedDirection = canonicalDirection(d.fromNumber, d.toNumber, d.direction, d.dcontext);

  try {
    await db.connectCdr.upsert({
      where: { linkedId: d.linkedId },
      create: {
        linkedId:    d.linkedId,
        tenantId:    resolvedTenantId,
        fromNumber:  d.fromNumber ?? null,
        toNumber:    d.toNumber ?? null,
        direction:   resolvedDirection,
        disposition: d.disposition,
        startedAt:   new Date(d.startedAt),
        answeredAt:  d.answeredAt ? new Date(d.answeredAt) : null,
        endedAt:     new Date(d.endedAt),
        durationSec: d.durationSec,
        talkSec:     d.talkSec,
        queueId:     d.queueId ?? null,
        hangupCause: d.hangupCause ?? null,
        dcontext:    d.dcontext ?? null,
        rawLegCount: 1,
      },
      update: {
        // On duplicate linkedId: update only if incoming data is richer.
        // rawLegCount always increments — each notification represents one channel-leg CDR.
        tenantId:    resolvedTenantId ?? undefined,
        fromNumber:  d.fromNumber ?? undefined,
        toNumber:    d.toNumber ?? undefined,
        direction:   resolvedDirection !== "unknown" ? resolvedDirection : undefined,
        disposition: d.disposition !== "unknown" ? d.disposition : undefined,
        answeredAt:  d.answeredAt ? new Date(d.answeredAt) : undefined,
        durationSec: d.durationSec > 0 ? d.durationSec : undefined,
        talkSec:     d.talkSec > 0 ? d.talkSec : undefined,
        queueId:     d.queueId ?? undefined,
        hangupCause: d.hangupCause ?? undefined,
        dcontext:    d.dcontext ?? undefined,
        rawLegCount: { increment: 1 },
      },
    });
    if (process.env.CDR_PIPELINE_DIAG?.trim() === "1") {
      app.log.info(
        {
          phase: "cdr_ingest_persisted",
          linkedId: d.linkedId,
          tenantId: resolvedTenantId,
          rawDirection: d.direction,
          direction: resolvedDirection,
          directionOverridden: resolvedDirection !== d.direction,
          fromNumber: d.fromNumber ?? null,
          toNumber: d.toNumber ?? null,
          startedAt: d.startedAt,
        },
        "cdr_pipeline_diag"
      );
    }
    return reply.code(200).send({ ok: true });
  } catch (err: any) {
    app.log.error({ linkedId: d.linkedId, err: err?.message }, "cdr-ingest: db error");
    return reply.code(500).send({ error: "db_error" });
  }
});

// ─── Connect CDR KPI totals ───────────────────────────────────────────────────
// Default: source=connect → ConnectCdr only (DB counts).
// source=pbx → reads from background cache (single global PBX query every 30s).
/** Comma-separated tenant names to skip when aggregating VitalPBX CDR (listTenants `name`). Default: smoke,billing,test. Set to empty or "none" to include all. Excluding "vitalpbx" was dropping a large share of traffic vs the real PBX UI. */
function parseVitalpbxCdrAggregateExcludeNames(): Set<string> {
  const env = process.env.VITALPBX_CDR_AGGREGATE_EXCLUDE_NAMES;
  if (env === undefined || env === null) {
    return new Set(["smoke", "billing", "test"]);
  }
  const raw = env.trim();
  if (raw === "" || raw.toLowerCase() === "none") return new Set<string>();
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

const _pbxKpiCache = new Map<string, { ts: number; data: any }>();
const _pbxKpiInflight = new Map<string, Promise<any>>();
const _pbxCdrCache: { ts: number; rows: any[]; byTenant: Map<string, any[]> } = { ts: 0, rows: [], byTenant: new Map() };
const PBX_KPI_BG_INTERVAL_MS = 30_000;
let _pbxBgStarted = false;
let _pbxRefreshRunning = false;
let _pbxTickCount = 0;
let _pbxLastEndSec = 0; // Unix sec of the last data point in cache
let _pbxActiveTenantIds: string[] = []; // Tenants with CDRs
let _pbxIdToName = new Map<string, string>();
let _pbxLinks: Array<{ pbxTenantId: string | null; tenantId: string }> = [];

function classifyRow(r: any): { direction: string; isIncoming: boolean; isMissed: boolean } {
  const ct = Number(r?.calltype ?? r?.callType ?? 0);
  let direction = "unknown";
  let isIncoming = false;
  if (ct === 2) { direction = "incoming"; isIncoming = true; }
  else if (ct === 3) { direction = "outgoing"; }
  else if (ct === 1) { direction = "internal"; }
  else {
    const dir = String(r?.direction || r?.call_type || "").toLowerCase();
    if (dir.includes("in") && !dir.includes("internal")) { direction = "incoming"; isIncoming = true; }
    else if (dir.includes("internal")) { direction = "internal"; }
    else { direction = "outgoing"; }
  }
  const disp = String(r?.disposition || "").toUpperCase();
  const isMissed = disp !== "ANSWERED" && isIncoming;
  return { direction, isIncoming, isMissed };
}


async function refreshPerTenantData(instance: any, auth: any, tz: string, t0: number, deltaOnly = false) {
  const client = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret, timeoutMs: deltaOnly ? 30_000 : 60_000 });

  if (!deltaOnly) {
    const tenantList = await client.listTenants();
    _pbxIdToName = new Map<string, string>();
    const allTenantIds: string[] = [];
    for (const t of tenantList) {
      const id = String((t as any).tenant_id ?? (t as any).id ?? "").trim();
      const name = String((t as any).name ?? "").trim();
      if (id && name) { _pbxIdToName.set(id, name); allTenantIds.push(id); }
    }
    _pbxActiveTenantIds = allTenantIds;
    _pbxLinks = (await db.tenantPbxLink.findMany()).map(l => ({ pbxTenantId: l.pbxTenantId, tenantId: l.tenantId }));
  }

  const perTenantCounts = new Map<string, { incoming: number; outgoing: number; internal: number; missed: number; total: number }>();
  const allRows: any[] = [];
  const activeTids: string[] = [];

  for (const tid of _pbxActiveTenantIds) {
    try {
      const tData = await client.getCdrToday(tid, { timezone: tz, chunkSec: 1800 });
      perTenantCounts.set(tid, { incoming: tData.incoming, outgoing: tData.outgoing, internal: tData.internal, missed: tData.missed, total: tData.total });
      if (tData.total > 0) activeTids.push(tid);
      for (const r of tData.allRawRows) {
        if (!r.tenantid && !r.tenant_id && !r.tenant) r.tenantid = tid;
        allRows.push(r);
      }
    } catch { /* skip */ }
  }
  if (activeTids.length > 0) _pbxActiveTenantIds = activeTids;
  _pbxLastEndSec = Math.floor(Date.now() / 1000);

  const now = Date.now();
  const asOf = new Date().toISOString();

  const pbxToConnect = new Map<string, string>();
  for (const l of _pbxLinks) { if (l.pbxTenantId) pbxToConnect.set(l.pbxTenantId.trim(), l.tenantId); }
  const cdrByConnect = new Map<string, any[]>();
  for (const [tid, counts] of perTenantCounts) {
    const tName = _pbxIdToName.get(tid) || tid;
    const tenantData = {
      incomingToday: counts.incoming, outgoingToday: counts.outgoing, internalToday: counts.internal,
      missedToday: counts.missed, cdrRowsTotalAcrossTenants: counts.total,
      scope: "tenant" as const, tenantsQueried: 1, source: "pbx" as const, asOf, _ts: now,
    };
    const connectId = pbxToConnect.get(tid);
    if (connectId) _pbxKpiCache.set(`pbx:${connectId}`, { ts: now, data: tenantData });
    _pbxKpiCache.set(`pbx:vpbx:${normSlug(tName)}`, { ts: now, data: tenantData });
  }
  const rowsByTenant = new Map<string, any[]>();
  for (const r of allRows) {
    const tid = String(r?.tenantid ?? r?.tenant_id ?? r?.tenant ?? "0").trim();
    if (!rowsByTenant.has(tid)) rowsByTenant.set(tid, []);
    rowsByTenant.get(tid)!.push(r);
  }
  for (const [tid, rows] of rowsByTenant) {
    const connectId = pbxToConnect.get(tid);
    if (connectId) cdrByConnect.set(connectId, rows);
    const tName = _pbxIdToName.get(tid) || tid;
    cdrByConnect.set(`vpbx:${normSlug(tName)}`, rows);
  }
  _pbxCdrCache.ts = now;
  _pbxCdrCache.rows = allRows;
  _pbxCdrCache.byTenant = cdrByConnect;
  app.log.info({ elapsedMs: Date.now() - t0, totalRawRows: allRows.length, tenants: perTenantCounts.size, mode: deltaOnly ? "delta-tenant-cache" : "full-tenant-cache" }, "pbx-kpi-bg: refresh ok");
}

/**
 * Fetch KPI stats directly from the VitalPBX admin dashboard page.
 * VitalPBX's dashboard queries SELECT SUM(IF(calltype=N,1,0)) on the
 * global CDR table — no per-tenant scoping. We scrape those exact numbers
 * so Connect shows the exact same values.
 */
async function fetchPbxDashboardStats(baseUrl: string, appKey: string): Promise<{ incoming: number; outgoing: number; internal: number; transit: number } | null> {
  try {
    const dashUrl = `${baseUrl.replace(/\/+$/, "")}/index.php`;
    const res = await fetch(dashUrl, {
      headers: { "app-key": appKey, accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // VitalPBX 4 dashboard embeds "Calls Traffic Today" stats. Try multiple parsing strategies.
    // Strategy 1: look for JSON data object with call counts
    const jsonMatch = html.match(/"?incoming"?\s*[:=]\s*(\d+)[\s\S]*?"?outgoing"?\s*[:=]\s*(\d+)[\s\S]*?"?internal"?\s*[:=]\s*(\d+)/i);
    if (jsonMatch) {
      return { incoming: Number(jsonMatch[1]), outgoing: Number(jsonMatch[2]), internal: Number(jsonMatch[3]), transit: 0 };
    }

    // Strategy 2: look for the pie chart data pattern (common in VitalPBX 4)
    const pieMatch = html.match(/Outgoing[^0-9]*(\d+)[^0-9]*Incoming[^0-9]*(\d+)[^0-9]*Internal[^0-9]*(\d+)/i)
      || html.match(/Incoming[^0-9]*(\d+)[^0-9]*Outgoing[^0-9]*(\d+)[^0-9]*Internal[^0-9]*(\d+)/i);
    if (pieMatch) {
      const labels = html.match(/Outgoing/i) ? ["outgoing", "incoming", "internal"] : ["incoming", "outgoing", "internal"];
      const vals = [Number(pieMatch[1]), Number(pieMatch[2]), Number(pieMatch[3])];
      const obj = { incoming: 0, outgoing: 0, internal: 0, transit: 0 };
      labels.forEach((l, i) => { (obj as any)[l] = vals[i]; });
      return obj;
    }

    // Strategy 3: look for numeric values near "Outgoing", "Incoming", "Internal" labels
    const extract = (label: string) => {
      const re = new RegExp(`${label}[^0-9]{0,40}?(\\d+)`, "i");
      const m = html.match(re);
      return m ? Number(m[1]) : 0;
    };
    const incoming = extract("Incoming");
    const outgoing = extract("Outgoing");
    const internal = extract("Internal");
    if (incoming > 0 || outgoing > 0) {
      return { incoming, outgoing, internal, transit: 0 };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Alternative: try calling the CDR API WITHOUT a tenant header.
 * If VitalPBX returns global CDRs in admin mode, this gives exact counts.
 */
async function fetchGlobalCdrCounts(
  baseUrl: string,
  appKey: string,
  secret: string | undefined,
  tz: string
): Promise<{ incoming: number; outgoing: number; internal: number; missed: number; total: number; rows: any[] } | null> {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = formatter.formatToParts(now);
    const y = Number(parts.find(p => p.type === "year")!.value);
    const m = Number(parts.find(p => p.type === "month")!.value) - 1;
    const d = Number(parts.find(p => p.type === "day")!.value);
    const startSec = Math.floor(new Date(y, m, d, 0, 0, 0).getTime() / 1000);
    const endSec = Math.floor(Date.now() / 1000);

    const client = getVitalPbxClient({
      baseUrl,
      token: appKey,
      secret,
      timeoutMs: 20_000,
    });

    // Single lightweight global CDR read (no tenant header) to avoid PBX CPU overload.
    // We intentionally avoid multi-page scans in the 30s loop.
    const envelope = await client.callEndpoint<any>("cdr.list", {
      query: {
        limit: 1000,
        sort_by: "date",
        sort_order: "asc",
        start_date: startSec,
        end_date: endSec,
      },
    });
    const data = (envelope as any)?.data ?? envelope;
    const rows = Array.isArray(data?.result)
      ? data.result
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.rows)
          ? data.rows
          : Array.isArray(data)
            ? data
            : [];
    if (rows.length === 0) return null;

    let incoming = 0, outgoing = 0, internal = 0, missed = 0;
    for (const r of rows) {
      // PBX dashboard excludes rows with empty tenant.
      const tenant = String(r?.tenant ?? r?.tenantid ?? r?.tenant_id ?? "").trim();
      if (!tenant) continue;
      const ct = Number(r?.calltype ?? r?.callType ?? 0);
      if (ct === 2) { incoming++; const disp = String(r?.disposition || "").toUpperCase(); if (disp !== "ANSWERED") missed++; }
      else if (ct === 3) outgoing++;
      else if (ct === 1) internal++;
    }
    return { incoming, outgoing, internal, missed, total: incoming + outgoing + internal, rows };
  } catch {
    return null;
  }
}

async function fetchTenantCdrCounts(
  baseUrl: string,
  appKey: string,
  secret: string | undefined,
  timezone: string,
  pbxTenantId: string,
): Promise<{ incoming: number; outgoing: number; internal: number; missed: number; total: number } | null> {
  try {
    const client = getVitalPbxClient({
      baseUrl,
      token: appKey,
      secret,
      timeoutMs: 20_000,
    });
    const data = await client.getCdrToday(pbxTenantId, { timezone, chunkSec: 1800 });
    return {
      incoming: data.incoming,
      outgoing: data.outgoing,
      internal: data.internal,
      missed: data.missed,
      total: data.total,
    };
  } catch {
    return null;
  }
}

async function resolvePbxTenantScope(scopeTenantId: string): Promise<{ pbxTenantId: string | null; scopeLabel: string | null }> {
  if (!scopeTenantId) return { pbxTenantId: null, scopeLabel: null };
  if (scopeTenantId.startsWith("vpbx:")) {
    const slug = normSlug(scopeTenantId.slice(5));
    const instance = await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
    if (!instance) return { pbxTenantId: null, scopeLabel: scopeTenantId };
    const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
    const client = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret, timeoutMs: 20_000 });
    const tenants = await client.listTenants();
    const t = tenants.find((x: any) => normSlug(String(x?.name || "")) === slug);
    const id = t ? String((t as any).tenant_id ?? (t as any).id ?? "").trim() : "";
    return { pbxTenantId: id || null, scopeLabel: scopeTenantId };
  }
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: scopeTenantId }, include: { tenant: true } });
  if (link?.pbxTenantId) return { pbxTenantId: link.pbxTenantId.trim(), scopeLabel: link.tenant?.name ?? scopeTenantId };
  return { pbxTenantId: null, scopeLabel: scopeTenantId };
}

async function fetchLivePbxKpisByScope(params: {
  scopeTenantId: string | null;
  timezone: string;
  asOfIso: string;
}): Promise<any> {
  const { scopeTenantId, timezone, asOfIso } = params;
  const instance = await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  if (!instance) throw new Error("PBX_UNAVAILABLE_NO_INSTANCE");
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);

  if (!scopeTenantId) {
    const live = await fetchGlobalCdrCounts(instance.baseUrl, auth.token, auth.secret, timezone);
    if (!live) throw new Error("PBX_UNAVAILABLE_GLOBAL_FETCH_FAILED");
    return {
      incomingToday: live.incoming,
      outgoingToday: live.outgoing,
      internalToday: live.internal,
      missedToday: live.missed,
      cdrRowsTotalAcrossTenants: live.total,
      scope: "global" as const,
      tenantsQueried: 0,
      source: "pbx-global-cdr",
      asOf: asOfIso,
    };
  }

  const scope = await resolvePbxTenantScope(scopeTenantId);
  if (!scope.pbxTenantId) throw new Error("PBX_UNAVAILABLE_TENANT_MAPPING");
  const live = await fetchTenantCdrCounts(instance.baseUrl, auth.token, auth.secret, timezone, scope.pbxTenantId);
  if (!live) throw new Error("PBX_UNAVAILABLE_TENANT_FETCH_FAILED");
  return {
    incomingToday: live.incoming,
    outgoingToday: live.outgoing,
    internalToday: live.internal,
    missedToday: live.missed,
    cdrRowsTotalAcrossTenants: live.total,
    scope: "tenant" as const,
    tenantId: scopeTenantId,
    tenantsQueried: 1,
    source: "pbx-tenant-cdr",
    asOf: asOfIso,
  };
}

function startPbxKpiBackgroundRefresh() {
  if (_pbxBgStarted) return;
  _pbxBgStarted = true;
  const tz = process.env.PBX_TIMEZONE || "America/New_York";

  const doRefresh = async () => {
    if (_pbxRefreshRunning) return;
    _pbxRefreshRunning = true;
    const t0 = Date.now();
    _pbxTickCount++;

    try {
      const instance = await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
      if (!instance) { app.log.warn("pbx-kpi-bg: no PBX instance"); return; }
      const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);

      // ── PRIMARY: try getting stats directly from PBX dashboard (exact match) ──
      const dashStats = await fetchPbxDashboardStats(instance.baseUrl, auth.token);
      if (dashStats && (dashStats.incoming > 0 || dashStats.outgoing > 0)) {
        const now = Date.now();
        const asOf = new Date().toISOString();
        _pbxKpiCache.set("pbx:global", { ts: now, data: {
          incomingToday: dashStats.incoming, outgoingToday: dashStats.outgoing, internalToday: dashStats.internal,
          missedToday: 0, cdrRowsTotalAcrossTenants: dashStats.incoming + dashStats.outgoing + dashStats.internal + dashStats.transit,
          scope: "global", tenantsQueried: 0, source: "pbx-dashboard", asOf, _ts: now,
        }});
        app.log.info({ elapsedMs: Date.now() - t0, incoming: dashStats.incoming, outgoing: dashStats.outgoing, internal: dashStats.internal, mode: "dashboard-scrape" }, "pbx-kpi-bg: refresh ok");

        return;
      }

      // ── SECONDARY: try global CDR query without tenant header ──
      const globalCdr = await fetchGlobalCdrCounts(instance.baseUrl, auth.token, auth.secret, tz);
      if (globalCdr && globalCdr.total > 0) {
        const now = Date.now();
        const asOf = new Date().toISOString();
        _pbxKpiCache.set("pbx:global", { ts: now, data: {
          incomingToday: globalCdr.incoming, outgoingToday: globalCdr.outgoing, internalToday: globalCdr.internal,
          missedToday: globalCdr.missed, cdrRowsTotalAcrossTenants: globalCdr.total,
          scope: "global", tenantsQueried: 0, source: "pbx-global-cdr", asOf, _ts: now,
        }});
        _pbxCdrCache.ts = now;
        _pbxCdrCache.rows = globalCdr.rows;
        app.log.info({ elapsedMs: Date.now() - t0, incoming: globalCdr.incoming, outgoing: globalCdr.outgoing, internal: globalCdr.internal, total: globalCdr.total, mode: "global-cdr" }, "pbx-kpi-bg: refresh ok");

        return;
      }

      // Keep last-known good PBX global cache; do NOT fall back to Connect or tenant fan-out.
      app.log.warn({ elapsedMs: Date.now() - t0 }, "pbx-kpi-bg: global source unavailable, keeping last global KPI cache");
    } catch (err: any) {
      app.log.warn({ err: err?.message, elapsedMs: Date.now() - t0 }, "pbx-kpi-bg: refresh failed");
    } finally {
      _pbxRefreshRunning = false;
    }
  };

  setTimeout(doRefresh, 0);
  setInterval(doRefresh, PBX_KPI_BG_INTERVAL_MS);
}

/**
 * Diagnostics-only helper — reads from background cache or does a single global query.
 * Used by /admin/diagnostics/pbx-cdr-today-kpis. No per-tenant fan-out.
 */
async function aggregateVitalpbxTodayCallKpis(opts: {
  timezone: string;
  pbxScopeSlug: string | null;
  pbxScopeNumericId: string | null;
  responseTenantId: string | null;
}): Promise<any> {
  // Try cache first
  const cacheKey = opts.responseTenantId
    ? (opts.pbxScopeSlug ? `pbx:vpbx:${normSlug(opts.pbxScopeSlug)}` : `pbx:${opts.responseTenantId}`)
    : "pbx:global";
  const cached = _pbxKpiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 120_000) return cached.data;
  const globalCached = _pbxKpiCache.get("pbx:global");
  if (!opts.responseTenantId && globalCached && Date.now() - globalCached.ts < 120_000) return globalCached.data;
  // Fallback: single global query
  const instance = await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  if (!instance) throw new Error("NO_PBX_INSTANCE");
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const client = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret, timeoutMs: 45_000 });
  const data = await client.getCdrToday(undefined, { timezone: opts.timezone, chunkSec: 7200 });
  return {
    incomingToday: data.incoming, outgoingToday: data.outgoing, internalToday: data.internal,
    missedToday: data.missed, cdrRowsTotalAcrossTenants: data.total,
    scope: "global", tenantsQueried: 1, source: "pbx",
  };
}

app.get("/dashboard/call-kpis", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;

  const query = z.object({
    tenantId: z.string().optional(),
    source: z.enum(["connect", "pbx"]).optional().default("pbx"),
    mode: z.enum(["raw", "canonical"]).optional().default("raw"),
  }).parse(req.query || {});

  const wantPbxAggregate = query.source === "pbx";

  const isSuperAdmin = String(user.role || "").toUpperCase() === "SUPER_ADMIN";
  // tenantId param is only honoured for super admins; regular users get their own tenant
  const scopeTenantId = isSuperAdmin
    ? (query.tenantId && query.tenantId !== "global" ? query.tenantId : null)
    : user.tenantId ?? null;

  const nowUtc = new Date();
  const { timezone, timeWhere } = computePbxLocalDayRangeUtc(nowUtc);

  if (wantPbxAggregate) {
    const cacheKey = `pbx:${scopeTenantId ?? "global"}`;
    const cached = _pbxKpiCache.get(cacheKey);
    // 30s PBX cache to keep data fresh while protecting CPU
    if (cached && Date.now() - cached.ts < 30_000) {
      const { perTenant: _pt, ...rest } = cached.data;
      return reply.send({ ...rest, cached: true, cacheAgeMs: Date.now() - cached.ts });
    }
    try {
      let inflight = _pbxKpiInflight.get(cacheKey);
      if (!inflight) {
        inflight = fetchLivePbxKpisByScope({
          scopeTenantId,
          timezone,
          asOfIso: nowUtc.toISOString(),
        });
        _pbxKpiInflight.set(cacheKey, inflight);
      }
      const payload = await inflight;
      _pbxKpiCache.set(cacheKey, { ts: Date.now(), data: payload });
      return reply.send({ ...payload, cached: false, cacheAgeMs: 0 });
    } catch {
      const prev = _pbxKpiCache.get(cacheKey);
      if (prev) {
        const { perTenant: _pt, ...rest } = prev.data;
        return reply.send({ ...rest, cached: true, cacheAgeMs: Date.now() - prev.ts, stale: true });
      }
      return reply.code(503).send({ error: "PBX source unavailable (live fetch failed). Retrying automatically." });
    } finally {
      _pbxKpiInflight.delete(cacheKey);
    }
  }

  try {
    const tenantClause = scopeTenantId ? { tenantId: scopeTenantId } : {};
    const baseWhere = { ...tenantClause, startedAt: timeWhere };

    const [incoming, outgoing, internal, missed, total] = await Promise.all([
      db.connectCdr.count({ where: { ...baseWhere, direction: "incoming" } }),
      db.connectCdr.count({ where: { ...baseWhere, direction: "outgoing" } }),
      db.connectCdr.count({ where: { ...baseWhere, direction: "internal" } }),
      db.connectCdr.count({ where: { ...baseWhere, direction: "incoming", disposition: "missed" } }),
      db.connectCdr.count({ where: baseWhere }),
    ]);

    // Canonical mode: compute direction-corrected counts via SQL CASE expression.
    // This does NOT write to the DB — it corrects at query time for display only.
    let canonicalCounts: { incoming: number; outgoing: number; internal: number; missed: number; total: number } | null = null;
    if (query.mode === "canonical") {
      const tenantSql = scopeTenantId ? `AND "tenantId" = '${scopeTenantId.replace(/'/g, "''")}'` : "";
      const startSql  = `'${timeWhere.gte.toISOString()}'::timestamptz`;
      const endSql    = `'${timeWhere.lt.toISOString()}'::timestamptz`;
      const dirSql    = cdrCanonicalDirectionSql();

      type CanonRow = { incoming: bigint; outgoing: bigint; internal: bigint; missed: bigint; total: bigint };
      const [cr] = await db.$queryRawUnsafe<CanonRow[]>(`
        WITH c AS (
          SELECT
            (${dirSql}) AS dir,
            disposition
          FROM "ConnectCdr"
          WHERE "startedAt" >= ${startSql} AND "startedAt" < ${endSql}
          ${tenantSql}
        )
        SELECT
          COUNT(*) FILTER (WHERE dir = 'incoming') AS incoming,
          COUNT(*) FILTER (WHERE dir = 'outgoing') AS outgoing,
          COUNT(*) FILTER (WHERE dir = 'internal') AS internal,
          COUNT(*) FILTER (WHERE dir = 'incoming' AND disposition = 'missed') AS missed,
          COUNT(*) AS total
        FROM c
      `);
      if (cr) {
        canonicalCounts = {
          incoming: Number(cr.incoming),
          outgoing: Number(cr.outgoing),
          internal: Number(cr.internal),
          missed:   Number(cr.missed),
          total:    Number(cr.total),
        };
      }
    }

    const base = {
      incomingToday: incoming,
      outgoingToday: outgoing,
      internalToday: internal,
      missedToday: missed,
      callsToday: total,
      scope: scopeTenantId ? "tenant" as const : "global" as const,
      ...(scopeTenantId ? { tenantId: scopeTenantId } : {}),
      asOf: nowUtc.toISOString(),
      source: "connect" as const,
      mode: query.mode,
      ...(wantPbxAggregate ? { pbxFallback: true as const } : {}),
    };

    if (canonicalCounts) {
      return reply.send({
        ...base,
        canonical: canonicalCounts,
        // When canonical mode is active, expose corrected values as the primary KPIs
        // so the dashboard can display them directly; raw values remain available.
        raw: { incomingToday: incoming, outgoingToday: outgoing, internalToday: internal, missedToday: missed },
        incomingToday: canonicalCounts.incoming,
        outgoingToday: canonicalCounts.outgoing,
        internalToday: canonicalCounts.internal,
        missedToday:   canonicalCounts.missed,
      });
    }

    return reply.send(base);
  } catch (err: any) {
    app.log.error({ err: err?.message }, "call-kpis: db error");
    return reply.code(500).send({ error: "db_error" });
  }
});

// ─── CDR Tenant Mapping Rules (admin) ────────────────────────────────────────
// Lets super-admins configure DID/extension patterns → VitalPBX tenant slug mappings.
// These rules are used by /internal/cdr-ingest to assign tenantId when AMI events
// don't carry enough tenant information.
//
// GET  /admin/cdr/tenant-rules           → list all rules
// POST /admin/cdr/tenant-rules           → create or update a rule (upsert by matchType+matchValue)
// DELETE /admin/cdr/tenant-rules/:id     → delete a rule
// POST /admin/cdr/tenant-rules/backfill  → retroactively apply rules to existing CDR rows with tenantId=null

app.get("/admin/cdr/tenant-rules", async (req, reply) => {
  const admin = await requirePermission(req, reply, (u) => isRole(u, ["SUPER_ADMIN"]));
  if (!admin) return;
  const rules = await db.cdrTenantRule.findMany({ orderBy: { createdAt: "asc" } });
  return { rules };
});

app.post("/admin/cdr/tenant-rules", async (req, reply) => {
  const admin = await requirePermission(req, reply, (u) => isRole(u, ["SUPER_ADMIN"]));
  if (!admin) return;
  const input = z.object({
    matchType:   z.enum(["did", "from_did", "extension_prefix"]),
    matchValue:  z.string().min(1).max(30),
    tenantSlug:  z.string().min(1).max(100),
    description: z.string().max(200).optional(),
  }).parse(req.body || {});

  const rule = await db.cdrTenantRule.upsert({
    where: { matchType_matchValue: { matchType: input.matchType, matchValue: input.matchValue } },
    create: { ...input },
    update: { tenantSlug: input.tenantSlug, description: input.description ?? undefined },
  });
  invalidateCdrRulesCache();
  return { ok: true, rule };
});

app.delete("/admin/cdr/tenant-rules/:id", async (req, reply) => {
  const admin = await requirePermission(req, reply, (u) => isRole(u, ["SUPER_ADMIN"]));
  if (!admin) return;
  const { id } = req.params as { id: string };
  await db.cdrTenantRule.delete({ where: { id } }).catch(() => null);
  invalidateCdrRulesCache();
  return { ok: true };
});

// Retroactively apply current rules to ConnectCdr rows that still have tenantId=null.
// Returns the number of rows updated.
app.post("/admin/cdr/tenant-rules/backfill", async (req, reply) => {
  const admin = await requirePermission(req, reply, (u) => isRole(u, ["SUPER_ADMIN"]));
  if (!admin) return;

  // Pre-fetch VitalPBX tenant map once for the whole backfill
  let tenantMap: Map<string, string>;
  try {
    tenantMap = await getVpbxTenantLookup();
  } catch {
    tenantMap = new Map();
  }

  // Process in batches to avoid loading too many rows at once.
  // Uses all resolution strategies: dcontext, channels, admin rules.
  let updated = 0;
  let cursor: string | undefined;
  while (true) {
    const batch = await db.connectCdr.findMany({
      where: { tenantId: null },
      take: 200,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: "asc" },
      select: { id: true, fromNumber: true, toNumber: true, hangupCause: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const row of batch) {
      // Admin-configured DID/extension rules only. Does NOT fix direction or totals — use
      // POST /admin/cdr/fix-directions for misclassified ConnectCdr; optional PBX KPI compare: ?source=pbx + CALL_KPIS_USE_VITALPBX_API=true.
      const tenantId = await resolveTenantFromRules(row.fromNumber, row.toNumber);
      if (tenantId) {
        await db.connectCdr.update({ where: { id: row.id }, data: { tenantId } });
        updated++;
      }
    }
  }

  app.log.info({ updated }, "cdr: tenant rules backfill complete");
  return reply.send({ ok: true, updated });
});

// ─── Fix CDR directions ───────────────────────────────────────────────────────
// POST /admin/cdr/fix-directions?scope=today|all&dryRun=true
// Re-evaluates direction for every ConnectCdr row using canonicalDirection() rules:
//   • from=extension(2-6), to=external(10+) → outgoing  ← primary bug fix
//   • from=external(10+), to=extension(2-6) → incoming
//   • from=extension(2-6), to=extension(2-6) → internal
// Rows that already have the correct direction are skipped.
// dryRun=true (default) only counts; does not write.
app.post("/admin/cdr/fix-directions", async (req, reply) => {
  const admin = await requirePermission(req, reply, (u) => isRole(u, ["SUPER_ADMIN"]));
  if (!admin) return;

  const query = z.object({
    scope: z.enum(["today", "all"]).optional().default("today"),
    dryRun: z.enum(["true", "false"]).optional().default("true"),
  }).parse(req.query || {});

  const isDryRun = query.dryRun !== "false";

  const whereBase = query.scope === "today" ? (() => {
    const { timeWhere } = computePbxLocalDayRangeUtc();
    return { startedAt: timeWhere };
  })() : {};

  const rows = await db.connectCdr.findMany({
    where: whereBase,
    select: { id: true, linkedId: true, fromNumber: true, toNumber: true, direction: true, dcontext: true },
  });

  const changes: Array<{ id: string; linkedId: string; from: string | null; to: string | null; was: string; becomes: string }> = [];

  for (const row of rows) {
    const becomes = canonicalDirection(row.fromNumber, row.toNumber, row.direction, row.dcontext);
    if (becomes !== row.direction) {
      changes.push({ id: row.id, linkedId: row.linkedId, from: row.fromNumber, to: row.toNumber, was: row.direction, becomes });
    }
  }

  let fixed = 0;
  if (!isDryRun) {
    for (const ch of changes) {
      await db.connectCdr.update({ where: { id: ch.id }, data: { direction: ch.becomes } });
      fixed++;
      app.log.info({ linkedId: ch.linkedId, from: ch.from, to: ch.to, was: ch.was, becomes: ch.becomes }, "cdr fix-directions: applied");
    }
    app.log.info({ fixed, scope: query.scope }, "cdr: fix-directions complete");
  }

  const summary = changes.reduce<Record<string, number>>((acc, c) => {
    const k = `${c.was}→${c.becomes}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return reply.send({
    ok: true,
    dryRun: isDryRun,
    scope: query.scope,
    rowsScanned: rows.length,
    wouldFix: changes.length,
    fixed: isDryRun ? 0 : fixed,
    summary,
    samples: changes.slice(0, 20).map((c) => ({ linkedId: c.linkedId, from: c.from, to: c.to, was: c.was, becomes: c.becomes })),
  });
});

app.get("/dashboard/call-traffic", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  const query = z.object({
    scope: z.enum(["GLOBAL", "TENANT"]).optional(),
    windowMinutes: z.coerce.number().int().min(15).max(1440).optional()
  }).parse(req.query || {});

  const isSuperAdmin = String(user.role || "").toUpperCase() === "SUPER_ADMIN";
  const scope = query.scope === "GLOBAL" && isSuperAdmin ? "GLOBAL" : "TENANT";
  const windowMinutes = query.windowMinutes || 1440;
  const bucketMinutes = windowMinutes >= 720 ? 30 : windowMinutes >= 180 ? 15 : 5;
  const bucketCount = Math.max(1, Math.ceil(windowMinutes / bucketMinutes));
  const nowMs = Date.now();
  const sinceMs = nowMs - windowMinutes * 60 * 1000;
  const cacheKey = `${scope}:${scope === "TENANT" ? user.tenantId : "all"}:${windowMinutes}`;
  const cached = DASHBOARD_CALL_TRAFFIC_CACHE.get(cacheKey);
  if (cached && nowMs - cached.at < 120_000) return cached.payload;

  const normalizedRows: Array<{ ts: number; direction: "incoming" | "outgoing" | "internal" }> = [];
  let dbSourceRows = 0;
  let connectCdrSourceRows = 0;
  let rawRowsSeen = 0;
  let parsedRowsSeen = 0;
  const dbCallRows = await db.callRecord.findMany({
    where: scope === "GLOBAL" && isSuperAdmin
      ? { startedAt: { gte: new Date(sinceMs), lte: new Date(nowMs) } }
      : { tenantId: user.tenantId, startedAt: { gte: new Date(sinceMs), lte: new Date(nowMs) } },
    orderBy: { startedAt: "desc" },
    take: 5000
  });
  for (const row of dbCallRows) {
    const ts = row.startedAt.getTime();
    if (!Number.isFinite(ts)) continue;
    normalizedRows.push({
      ts,
      direction: normalizeCallDirection({ direction: row.direction })
    });
  }
  dbSourceRows = normalizedRows.length;

  // Second source: ConnectCdr (AMI / telephony ingest) — never VitalPBX REST cdr.list.
  if (normalizedRows.length === 0) {
    const connectRows = await db.connectCdr.findMany({
      where:
        scope === "GLOBAL" && isSuperAdmin
          ? { startedAt: { gte: new Date(sinceMs), lte: new Date(nowMs) } }
          : { tenantId: user.tenantId, startedAt: { gte: new Date(sinceMs), lte: new Date(nowMs) } },
      select: { startedAt: true, direction: true },
      orderBy: { startedAt: "desc" },
      take: 5000
    });
    connectCdrSourceRows = connectRows.length;
    for (const row of connectRows) {
      const ts = row.startedAt.getTime();
      if (!Number.isFinite(ts)) continue;
      normalizedRows.push({
        ts,
        direction: normalizeCallDirection({ direction: row.direction })
      });
      parsedRowsSeen += 1;
    }
  }

  const points = Array.from({ length: bucketCount }).map((_, idx) => {
    const bucketTs = new Date(sinceMs + idx * bucketMinutes * 60 * 1000);
    return {
      label: `${String(bucketTs.getHours()).padStart(2, "0")}:${String(bucketTs.getMinutes()).padStart(2, "0")}`,
      incoming: 0,
      outgoing: 0,
      internal: 0
    };
  });

  let incoming = 0;
  let outgoing = 0;
  let internal = 0;
  for (const row of normalizedRows) {
    if (row.direction === "incoming") incoming += 1;
    if (row.direction === "outgoing") outgoing += 1;
    if (row.direction === "internal") internal += 1;
    const bucketIndex = Math.floor((row.ts - sinceMs) / (bucketMinutes * 60 * 1000));
    if (bucketIndex >= 0 && bucketIndex < points.length) {
      points[bucketIndex][row.direction] += 1;
    }
  }

  const payload = {
    scope,
    windowMinutes,
    bucketMinutes,
    totals: {
      made: incoming + outgoing + internal,
      incoming,
      outgoing,
      internal,
      activeNow: normalizedRows.filter((row) => row.ts >= nowMs - 5 * 60 * 1000).length
    },
    points,
    updatedAt: new Date(nowMs).toISOString()
  };
  app.log.info(
    {
      scope,
      role: user.role,
      tenantId: user.tenantId,
      dbSourceRows,
      connectCdrSourceRows,
      rawRowsSeen,
      parsedRowsSeen,
      rowCount: normalizedRows.length,
      totals: payload.totals
    },
    "dashboard_call_traffic"
  );
  DASHBOARD_CALL_TRAFFIC_CACHE.set(cacheKey, { at: nowMs, payload });
  return payload;
});

app.get("/dashboard/summary", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const query = z.object({ range: z.enum(["24h", "7d", "30d"]).optional() }).parse(req.query || {});
  const { key: range, since } = resolveDashboardRange(query.range);

  try {
  const [
    invoicesAll,
    invoicesPaidInRange,
    paymentFailures,
    smsCampaignsSent,
    whatsAppInbound,
    whatsAppOutbound,
    emailFailed,
    emailQueued,
    overdueByCustomer,
    blockedCampaigns,
    failedEmailJobs,
    inboundFollowupThreads
  ] = await Promise.all([
    db.invoice.findMany({ where: { tenantId: admin.tenantId }, select: { id: true, status: true, customerId: true, amountCents: true } }),
    db.invoice.count({ where: { tenantId: admin.tenantId, status: "PAID", paidAt: { gte: since } } }),
    db.paymentEvent.findMany({
      where: { tenantId: admin.tenantId, status: "FAILED", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, type: true, createdAt: true, amountCents: true, currency: true }
    }),
    db.smsCampaign.count({ where: { tenantId: admin.tenantId, status: "SENT", createdAt: { gte: since } } }),
    db.whatsAppMessage.count({ where: { tenantId: admin.tenantId, direction: "INBOUND", createdAt: { gte: since } } }),
    db.whatsAppMessage.count({ where: { tenantId: admin.tenantId, direction: "OUTBOUND", createdAt: { gte: since } } }),
    db.emailJob.count({ where: { tenantId: admin.tenantId, status: "FAILED", createdAt: { gte: since } } }),
    db.emailJob.count({ where: { tenantId: admin.tenantId, status: "QUEUED", createdAt: { gte: since } } }),
    db.invoice.groupBy({
      by: ["customerId"],
      where: { tenantId: admin.tenantId, status: "OVERDUE", customerId: { not: null } },
      _count: { _all: true },
      _sum: { amountCents: true }
    }),
    db.smsCampaign.findMany({
      where: { tenantId: admin.tenantId, OR: [{ status: "PAUSED" }, { status: "FAILED" }, { status: "NEEDS_APPROVAL" }, { holdReason: { not: null } }] },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, name: true, status: true, holdReason: true, createdAt: true }
    }),
    db.emailJob.findMany({
      where: { tenantId: admin.tenantId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, toEmail: true, lastErrorCode: true, createdAt: true }
    }),
    db.whatsAppThread.findMany({
      where: { tenantId: admin.tenantId, lastDirection: "INBOUND", lastMessageAt: { gte: since } },
      orderBy: { lastMessageAt: "desc" },
      take: 10,
      select: { id: true, customerId: true, contactName: true, contactNumber: true, lastMessageAt: true, lastStatus: true }
    })
  ]);

  const unpaidInvoicesCount = invoicesAll.filter((r) => r.status === "DRAFT" || r.status === "SENT" || r.status === "OVERDUE").length;
  const overdueInvoicesCount = invoicesAll.filter((r) => r.status === "OVERDUE").length;
  const customerIds = overdueByCustomer.map((r) => r.customerId).filter(Boolean) as string[];
  const overdueCustomers = customerIds.length
    ? await db.customer.findMany({ where: { tenantId: admin.tenantId, id: { in: customerIds } }, select: { id: true, displayName: true, primaryEmail: true } })
    : [];
  const overdueCustomerMap = new Map(overdueCustomers.map((c) => [c.id, c]));

  return {
    range,
    invoiceSummary: {
      unpaidCount: unpaidInvoicesCount,
      overdueCount: overdueInvoicesCount,
      paidInRangeCount: invoicesPaidInRange
    },
    paymentSummary: {
      recentFailureCount: paymentFailures.length,
      recentFailures: paymentFailures.map((f) => ({
        id: f.id,
        type: f.type,
        amountCents: f.amountCents,
        currency: f.currency,
        createdAt: f.createdAt
      }))
    },
    messagingSummary: {
      smsCampaignsSentInRange: smsCampaignsSent,
      blockedOrSuspendedCampaigns: blockedCampaigns.length
    },
    whatsappSummary: {
      inboundCount: whatsAppInbound,
      outboundCount: whatsAppOutbound
    },
    emailSummary: {
      failedCount: emailFailed,
      queuedCount: emailQueued
    },
    customerAttentionSummary: {
      overdueCustomerCount: overdueByCustomer.length
    },
    attention: {
      overdueCustomers: overdueByCustomer.map((row) => {
        const customer = overdueCustomerMap.get(row.customerId || "");
        return {
          customerId: row.customerId,
          displayName: customer?.displayName || "Unknown customer",
          primaryEmail: customer?.primaryEmail || null,
          overdueInvoiceCount: row._count._all,
          overdueAmountCents: row._sum.amountCents || 0
        };
      }),
      failedEmailJobs: failedEmailJobs.map((e) => ({
        id: e.id,
        type: e.type,
        toEmailMasked: maskValue(e.toEmail, 2, 8),
        lastErrorCode: e.lastErrorCode || null,
        createdAt: e.createdAt
      })),
      blockedCampaigns: blockedCampaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        holdReason: c.holdReason || null,
        createdAt: c.createdAt
      })),
      whatsappInboundNeedsFollowup: inboundFollowupThreads.map((t) => ({
        threadId: t.id,
        customerId: t.customerId || null,
        contactName: t.contactName || null,
        contactNumberMasked: maskValue(t.contactNumber, 3, 2),
        lastStatus: t.lastStatus || null,
        lastMessageAt: t.lastMessageAt
      }))
    }
  };
  } catch (err: any) {
    app.log.warn({ err: err?.message || err, tenantId: admin.tenantId }, "dashboard/summary failed");
    return reply.status(200).send({
      range: "24h",
      invoiceSummary: { unpaidCount: 0, overdueCount: 0, paidInRangeCount: 0 },
      paymentSummary: { recentFailureCount: 0, recentFailures: [] },
      messagingSummary: { smsCampaignsSentInRange: 0, blockedOrSuspendedCampaigns: 0 },
      whatsappSummary: { inboundCount: 0, outboundCount: 0 },
      emailSummary: { failedCount: 0, queuedCount: 0 },
      customerAttentionSummary: { overdueCustomerCount: 0 },
      attention: { overdueCustomers: [], failedEmailJobs: [], blockedCampaigns: [], whatsappInboundNeedsFollowup: [] }
    });
  }
});

app.get("/dashboard/activity", async (req, reply) => {
  const admin = await requirePermission(req, reply, canViewCustomers);
  if (!admin) return;
  const query = z.object({ range: z.enum(["24h", "7d", "30d"]).optional() }).parse(req.query || {});
  const { key: range, since } = resolveDashboardRange(query.range);

  const [invoiceEvents, paymentFailures, smsCampaigns, waInbound, emailFailures, customers] = await Promise.all([
    db.invoiceEvent.findMany({
      where: { tenantId: admin.tenantId, createdAt: { gte: since }, type: { in: ["CREATED", "PAID"] } },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { invoiceId: true, type: true, createdAt: true }
    }),
    db.paymentEvent.findMany({
      where: { tenantId: admin.tenantId, status: "FAILED", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { id: true, createdAt: true, amountCents: true, currency: true, subscriptionId: true }
    }),
    db.smsCampaign.findMany({
      where: { tenantId: admin.tenantId, status: "SENT", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { id: true, name: true, createdAt: true }
    }),
    db.whatsAppMessage.findMany({
      where: { tenantId: admin.tenantId, direction: "INBOUND", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { id: true, threadId: true, createdAt: true }
    }),
    db.emailJob.findMany({
      where: { tenantId: admin.tenantId, status: "FAILED", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { id: true, type: true, createdAt: true }
    }),
    db.customer.findMany({
      where: { tenantId: admin.tenantId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { id: true, displayName: true, createdAt: true }
    })
  ]);

  const items: Array<{ type: string; timestamp: Date; label: string; link: string }> = [];
  for (const e of invoiceEvents) {
    if (e.type === "CREATED") {
      items.push({ type: "INVOICE_CREATED", timestamp: e.createdAt, label: `Invoice created`, link: `/dashboard/billing/invoices/${e.invoiceId}` });
    } else if (e.type === "PAID") {
      items.push({ type: "INVOICE_PAID", timestamp: e.createdAt, label: `Invoice paid`, link: `/dashboard/billing/invoices/${e.invoiceId}` });
    }
  }
  for (const e of paymentFailures) {
    items.push({
      type: "PAYMENT_FAILED",
      timestamp: e.createdAt,
      label: `Payment failed${e.amountCents ? ` ($${(Number(e.amountCents) / 100).toFixed(2)})` : ""}`,
      link: e.subscriptionId ? `/dashboard/billing/invoices/${e.subscriptionId}` : "/dashboard/billing/invoices"
    });
  }
  for (const s of smsCampaigns) items.push({ type: "SMS_CAMPAIGN_SENT", timestamp: s.createdAt, label: `SMS campaign sent: ${s.name}`, link: `/dashboard/sms/campaigns/${s.id}` });
  for (const w of waInbound) items.push({ type: "WHATSAPP_INBOUND", timestamp: w.createdAt, label: "WhatsApp inbound message", link: `/dashboard/whatsapp/${w.threadId}` });
  for (const e of emailFailures) items.push({ type: "EMAIL_FAILED", timestamp: e.createdAt, label: `Email failed: ${e.type}`, link: "/dashboard/settings/email" });
  for (const c of customers) items.push({ type: "CUSTOMER_CREATED", timestamp: c.createdAt, label: `Customer created: ${c.displayName}`, link: `/dashboard/customers/${c.id}` });

  items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return {
    range,
    items: items.slice(0, 120).map((i) => ({
      type: i.type,
      timestamp: i.timestamp,
      label: i.label,
      link: i.link
    }))
  };
});

app.get("/search/global", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  const query = z.object({ q: z.string().min(2) }).parse(req.query || {});
  const q = query.q.trim();

  const [customers, invoices, extensions, numbers] = await Promise.all([
    db.customer.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { displayName: { contains: q, mode: "insensitive" } },
          { primaryEmail: { contains: q, mode: "insensitive" } },
          { primaryPhone: { contains: q, mode: "insensitive" } },
          { whatsappNumber: { contains: q, mode: "insensitive" } }
        ]
      },
      take: 20
    }),
    db.invoice.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { id: { contains: q, mode: "insensitive" } },
          { customerEmail: { contains: q, mode: "insensitive" } },
          { customerPhone: { contains: q, mode: "insensitive" } }
        ]
      },
      take: 20
    }),
    db.extension.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { ext: { contains: q, mode: "insensitive" } },
          { label: { contains: q, mode: "insensitive" } }
        ]
      },
      take: 20
    }),
    db.phoneNumber.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { phoneNumber: { contains: q, mode: "insensitive" } },
          { label: { contains: q, mode: "insensitive" } }
        ]
      },
      take: 20
    })
  ]);

  return {
    q,
    customers: customers.map((r) => ({ id: r.id, displayName: r.displayName, primaryPhone: maskValue(r.primaryPhone, 3, 2), link: `/dashboard/customers/${r.id}` })),
    invoices: invoices.map((r) => ({ id: r.id, status: r.status, amountCents: r.amountCents, link: `/dashboard/billing/invoices/${r.id}` })),
    extensions: extensions.map((r) => ({ id: r.id, ext: r.ext, label: r.label, link: `/dashboard/extensions` })),
    numbers: numbers.map((r) => ({ id: r.id, phoneNumber: maskValue(r.phoneNumber, 3, 2), link: `/dashboard/numbers` }))
  };
});

app.get("/billing/invoices", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const rows = await db.invoice.findMany({
    where: { tenantId: admin.tenantId },
    include: { customer: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" }
  });
  return rows.map((r) => ({
    ...r,
    customer: r.customer ? { id: r.customer.id, displayName: r.customer.displayName } : null
  }));
});

app.get("/billing/invoices/summary", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const rows = await db.invoice.findMany({ where: { tenantId: admin.tenantId } });
  const byStatus: Record<string, number> = { DRAFT: 0, SENT: 0, OVERDUE: 0, PAID: 0, VOID: 0 };
  let totalCents = 0;
  let paidCents = 0;
  let outstandingCents = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    totalCents += r.amountCents || 0;
    if (r.status === "PAID") paidCents += r.amountCents || 0;
    if (r.status === "SENT" || r.status === "OVERDUE") outstandingCents += r.amountCents || 0;
  }
  return {
    totalInvoices: rows.length,
    byStatus,
    totals: { totalCents, paidCents, outstandingCents }
  };
});

app.post("/billing/invoices/overdue/run", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  await processInvoiceOverdueBatch();
  return { ok: true };
});

app.get("/billing/invoices/:id", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const row = await db.invoice.findFirst({
    where: { id, tenantId: admin.tenantId },
    include: {
      events: { orderBy: { createdAt: "asc" }, take: 200 },
      customer: true
    }
  });
  if (!row) return reply.status(404).send({ error: "invoice_not_found" });
  const paymentAttempts = await db.paymentEvent.findMany({
    where: { tenantId: admin.tenantId, subscriptionId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, type: true, status: true, providerEventId: true, amountCents: true, currency: true, createdAt: true }
  });
  return { ...row, paymentAttempts };
});

app.get("/billing/invoices/:id/events", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const row = await db.invoice.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!row) return reply.status(404).send({ error: "invoice_not_found" });
  return db.invoiceEvent.findMany({ where: { invoiceId: id, tenantId: admin.tenantId }, orderBy: { createdAt: "asc" } });
});

app.post("/billing/invoices", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;

  const input = z.object({
    customerId: z.string().optional(),
    customerEmail: z.string().email().optional(),
    customerPhone: z.string().min(5).max(40).optional().nullable(),
    amountCents: z.number().int().positive(),
    currency: z.string().min(3).max(3).default("USD"),
    dueAt: z.string().datetime().optional(),
    sendEmail: z.boolean().default(true)
  }).parse(req.body || {});

  const selectedCustomer = input.customerId
    ? await db.customer.findFirst({ where: { id: input.customerId, tenantId: admin.tenantId } })
    : null;
  if (input.customerId && !selectedCustomer) {
    return reply.status(404).send({ error: "CUSTOMER_NOT_FOUND" });
  }
  const resolvedEmail = input.customerEmail || selectedCustomer?.primaryEmail || null;
  if (!resolvedEmail) {
    return reply.status(400).send({ error: "CUSTOMER_EMAIL_REQUIRED" });
  }
  const resolvedPhone = normalizeContactNumber(input.customerPhone) || selectedCustomer?.primaryPhone || selectedCustomer?.whatsappNumber || null;

  const tokenRaw = randomBytes(18).toString("hex");
  const payToken = `inv_${tokenRaw}`;
  const payUrl = `https://app.connectcomunications.com/pay/invoice/${payToken}`;

  const invoice = await db.invoice.create({
    data: {
      tenantId: admin.tenantId,
      customerId: selectedCustomer?.id || null,
      customerEmail: resolvedEmail,
      customerPhone: resolvedPhone,
      amountCents: input.amountCents,
      currency: input.currency,
      status: input.sendEmail ? "SENT" : "DRAFT",
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      payToken,
      payTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      externalPaymentLink: payUrl
    }
  });

  await logInvoiceEvent({
    tenantId: admin.tenantId,
    invoiceId: invoice.id,
    type: "CREATED",
    payload: { amountCents: invoice.amountCents, currency: invoice.currency, dueAt: invoice.dueAt?.toISOString() || null, sendEmail: input.sendEmail }
  });
  if (input.sendEmail) {
    await queueInvoiceCreatedEmail({ tenantId: admin.tenantId, invoiceId: invoice.id, to: invoice.customerEmail, amountCents: invoice.amountCents, payUrl });
    await logInvoiceEvent({ tenantId: admin.tenantId, invoiceId: invoice.id, type: "SENT", payload: { payUrl } });
  }
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "INVOICE_CREATED", entityType: "Invoice", entityId: invoice.id });
  return invoice;
});

app.post("/billing/invoices/:id/send", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const invoice = await db.invoice.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!invoice) return reply.status(404).send({ error: "invoice_not_found" });
  if (invoice.status === "PAID") return reply.status(400).send({ error: "INVOICE_ALREADY_PAID" });
  if (invoice.status === "VOID") return reply.status(400).send({ error: "INVOICE_VOIDED" });

  const payToken = invoice.payToken || `inv_${randomBytes(18).toString("hex")}`;
  const payUrl = `https://app.connectcomunications.com/pay/invoice/${payToken}`;
  const updated = await db.invoice.update({ where: { id: invoice.id }, data: { status: "SENT", payToken, payTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), externalPaymentLink: payUrl } });
  await queueInvoiceCreatedEmail({ tenantId: admin.tenantId, invoiceId: updated.id, to: updated.customerEmail, amountCents: updated.amountCents, payUrl });
  await logInvoiceEvent({ tenantId: admin.tenantId, invoiceId: updated.id, type: "SENT", payload: { payUrl } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "INVOICE_SENT", entityType: "Invoice", entityId: updated.id });
  return updated;
});

app.post("/billing/invoices/:id/void", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ reason: z.string().min(2).optional() }).parse(req.body || {});
  const invoice = await db.invoice.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!invoice) return reply.status(404).send({ error: "invoice_not_found" });
  if (invoice.status === "PAID") return reply.status(400).send({ error: "INVOICE_ALREADY_PAID" });
  if (invoice.status === "VOID") return { ok: true, invoice };

  const updated = await db.invoice.update({
    where: { id: invoice.id },
    data: { status: "VOID", lastFailureReason: input.reason || "VOIDED_BY_ADMIN" }
  });
  await logInvoiceEvent({ tenantId: admin.tenantId, invoiceId: updated.id, type: "VOIDED", payload: { reason: input.reason || null } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "INVOICE_VOIDED", entityType: "Invoice", entityId: updated.id });
  return { ok: true, invoice: updated };
});

app.post("/billing/invoices/:id/remind", async (req, reply) => {
  const admin = await requirePermission(req, reply, canManageBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const invoice = await db.invoice.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!invoice) return reply.status(404).send({ error: "invoice_not_found" });
  if (invoice.status === "PAID") return reply.status(400).send({ error: "INVOICE_ALREADY_PAID" });
  if (invoice.status === "VOID") return reply.status(400).send({ error: "INVOICE_VOIDED" });
  const now = Date.now();
  const recentReminder = await db.invoiceEvent.findFirst({
    where: {
      invoiceId: invoice.id,
      type: { in: ["REMINDER_SENT", "OVERDUE_REMINDER_SENT"] },
      createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) }
    },
    orderBy: { createdAt: "desc" }
  });
  if (recentReminder) return reply.status(429).send({ error: "REMINDER_THROTTLED", nextAllowedAt: new Date(recentReminder.createdAt.getTime() + 24 * 60 * 60 * 1000) });

  const payUrl = invoice.externalPaymentLink || (invoice.payToken ? `https://app.connectcomunications.com/pay/invoice/${invoice.payToken}` : null);
  if (!payUrl) return reply.status(400).send({ error: "PAY_LINK_MISSING" });
  await queueInvoiceReminderEmail({
    tenantId: admin.tenantId,
    invoiceId: invoice.id,
    to: invoice.customerEmail,
    amountCents: invoice.amountCents,
    payUrl,
    overdue: invoice.status === "OVERDUE"
  });
  await logInvoiceEvent({
    tenantId: admin.tenantId,
    invoiceId: invoice.id,
    type: invoice.status === "OVERDUE" ? "OVERDUE_REMINDER_SENT" : "REMINDER_SENT",
    payload: { payUrl }
  });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "INVOICE_REMINDER_SENT", entityType: "Invoice", entityId: invoice.id });
  return { ok: true };
});

app.get("/billing/invoices/pay/:token", async (req, reply) => {
  const { token } = req.params as { token: string };
  const invoice = await db.invoice.findFirst({ where: { payToken: token } });
  if (!invoice) return reply.status(404).send({ error: "invoice_not_found" });
  if (invoice.payTokenExpiresAt && invoice.payTokenExpiresAt.getTime() < Date.now()) return reply.status(410).send({ error: "invoice_token_expired" });
  const canPay = invoice.status !== "PAID" && invoice.status !== "VOID";
  const state = invoice.status === "PAID"
    ? "paid"
    : invoice.status === "VOID"
      ? "void"
      : invoice.status === "OVERDUE"
        ? "overdue"
        : "unpaid";
  return {
    invoiceId: invoice.id,
    amountCents: invoice.amountCents,
    currency: invoice.currency,
    status: invoice.status,
    state,
    canPay,
    dueAt: invoice.dueAt,
    payToken: invoice.payToken,
    externalPaymentLink: invoice.externalPaymentLink || null
  };
});

app.post("/billing/invoices/pay/:token/hosted-session", async (req, reply) => {
  const { token } = req.params as { token: string };
  const invoice = await db.invoice.findFirst({ where: { payToken: token } });
  if (!invoice) return reply.status(404).send({ error: "invoice_not_found" });
  if (invoice.status === "PAID") return reply.status(400).send({ error: "INVOICE_ALREADY_PAID" });
  if (invoice.status === "VOID") return reply.status(400).send({ error: "INVOICE_VOIDED" });
  if (invoice.payTokenExpiresAt && invoice.payTokenExpiresAt.getTime() < Date.now()) return reply.status(410).send({ error: "invoice_token_expired" });

  let tenantSola;
  try {
    tenantSola = await getTenantSolaConfig(invoice.tenantId, { requireEnabled: true, allowFallbackEnv: false });
  } catch (e: any) {
    return reply.status(400).send({ error: String(e?.code || "NOT_CONFIGURED") });
  }

  const hosted = await getSolaAdapter(tenantSola.adapterConfig).createHostedSession({
    tenantId: invoice.tenantId,
    subscriptionId: invoice.id,
    planCode: "INVOICE_PAYMENT",
    amountCents: invoice.amountCents,
    successUrl: `https://app.connectcomunications.com/pay/invoice/${token}?result=success`,
    cancelUrl: `https://app.connectcomunications.com/pay/invoice/${token}?result=cancel`
  });

  await db.invoice.update({ where: { id: invoice.id }, data: { externalPaymentLink: hosted.redirectUrl, providerInvoiceRef: hosted.providerSessionId || invoice.providerInvoiceRef || null } });
  await logInvoiceEvent({
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    type: "PAYMENT_STARTED",
    payload: { providerInvoiceRef: hosted.providerSessionId || null }
  });
  return { redirectUrl: hosted.redirectUrl };
});

app.post("/billing/invoices/:id/simulate-webhook", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const { id } = req.params as { id: string };
  const input = z.object({ status: z.enum(["SUCCEEDED", "FAILED"]) }).parse(req.body || {});
  const invoice = await db.invoice.findFirst({ where: { id, tenantId: admin.tenantId } });
  if (!invoice) return reply.status(404).send({ error: "invoice_not_found" });

  if (input.status === "SUCCEEDED") {
    const updated = await db.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: new Date(), lastFailureReason: null } });
    await queueReceiptEmail({ tenantId: admin.tenantId, to: updated.customerEmail, amountCents: updated.amountCents, periodEnd: new Date(), receiptId: updated.id });
    await logInvoiceEvent({ tenantId: admin.tenantId, invoiceId: updated.id, type: "PAID", payload: { simulated: true } });
    await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "INVOICE_PAYMENT_SUCCEEDED", entityType: "Invoice", entityId: updated.id });
    return { ok: true, invoice: updated };
  }

  const retryUrl = `https://app.connectcomunications.com/pay/invoice/${invoice.payToken}`;
  const updated = await db.invoice.update({ where: { id: invoice.id }, data: { status: invoice.status === "OVERDUE" ? "OVERDUE" : "SENT", lastFailureReason: "SIMULATED_FAILURE" } });
  await queueInvoiceDeclineEmail({ tenantId: admin.tenantId, invoiceId: updated.id, to: updated.customerEmail, amountCents: updated.amountCents, retryUrl });
  await logInvoiceEvent({ tenantId: admin.tenantId, invoiceId: updated.id, type: "DECLINED", payload: { simulated: true } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "INVOICE_PAYMENT_FAILED", entityType: "Invoice", entityId: updated.id });
  return { ok: true, invoice: updated };
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

  let tenantSola;
  try {
    tenantSola = await getTenantSolaConfig(admin.tenantId, { requireEnabled: true, allowFallbackEnv: false });
  } catch (e: any) {
    const code = String(e?.code || "NOT_CONFIGURED");
    const status = code === "SOLA_NOT_ENABLED" ? 400 : 404;
    return reply.status(status).send({ error: code, message: "Configure and enable Billing > SOLA settings before starting checkout." });
  }

  let hosted;
  try {
    hosted = await getSolaAdapter(tenantSola.adapterConfig).createHostedSession({
      tenantId: admin.tenantId,
      subscriptionId: sub.id,
      planCode: BILLING_PLAN_CODE,
      amountCents: BILLING_PLAN_PRICE_CENTS,
      successUrl: "https://app.connectcomunications.com/dashboard/billing?checkout=success",
      cancelUrl: "https://app.connectcomunications.com/dashboard/billing?checkout=cancel"
    });
  } catch (e: any) {
    const code = String(e?.code || "SOLA_REQUEST_FAILED");
    return reply.status(400).send({ error: code });
  }

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

  let tenantSola;
  try {
    tenantSola = await getTenantSolaConfig(admin.tenantId, { requireEnabled: true, allowFallbackEnv: false });
  } catch (e: any) {
    const code = String(e?.code || "NOT_CONFIGURED");
    const status = code === "SOLA_NOT_ENABLED" ? 400 : 404;
    return reply.status(status).send({ error: code, message: "Configure and enable Billing > SOLA settings before canceling subscription." });
  }

  if (sub.providerSubscriptionId) {
    try { await getSolaAdapter(tenantSola.adapterConfig).cancelSubscription(sub.providerSubscriptionId, input.cancelAtPeriodEnd); } catch {}
  }
  const nextStatus = input.cancelAtPeriodEnd ? sub.status : "CANCELED";
  const updated = await db.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: input.cancelAtPeriodEnd, status: nextStatus } });
  await audit({ tenantId: admin.tenantId, actorUserId: admin.sub, action: "BILLING_SUBSCRIPTION_CANCELED", entityType: "Subscription", entityId: updated.id });
  return { success: true, status: updated.status, cancelAtPeriodEnd: updated.cancelAtPeriodEnd };
});

app.get("/admin/billing/tenants", async (req, reply) => {
  const admin = await requirePermission(req, reply, canAccessAdminBilling);
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
  const admin = await requirePermission(req, reply, canAccessAdminBilling);
  if (!admin) return;
  const { id } = req.params as { id: string };

  const tenant = await db.tenant.findUnique({ where: { id }, include: { subscription: true } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const recentEvents = await db.paymentEvent.findMany({ where: { tenantId: id }, orderBy: { receivedAt: "desc" }, take: 20 });
  return { tenantId: tenant.id, tenantName: tenant.name, smsSuspended: tenant.smsSuspended, subscription: tenant.subscription, events: recentEvents };
});

app.post("/admin/billing/tenants/:id/override-status", async (req, reply) => {
  const admin = await requirePermission(req, reply, canAccessAdminBilling);
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

app.post("/webhooks/whatsapp/twilio/status", async (req, reply) => {
  const payload = (req.body || {}) as Record<string, any>;
  const accountSid = String(payload.AccountSid || payload.accountSid || "").trim();
  const messageSid = String(payload.MessageSid || payload.SmsSid || payload.messageSid || "").trim();
  const statusRaw = String(payload.MessageStatus || payload.SmsStatus || payload.status || "").trim().toLowerCase();
  const body = String(payload.Body || payload.body || "").trim();
  const from = String(payload.From || payload.from || "").trim();
  const to = String(payload.To || payload.to || "").trim();

  let tenantId: string | null = null;
  if (accountSid) {
    const rows = await db.whatsAppProviderConfig.findMany({ where: { provider: "WHATSAPP_TWILIO" } });
    for (const row of rows) {
      try {
        const creds = decryptJson<WhatsAppTwilioCredentialPayload>(row.credentialsEncrypted);
        if (creds.accountSid === accountSid) {
          tenantId = row.tenantId;
          break;
        }
      } catch {
        // skip broken credential rows
      }
    }
  }

  if (tenantId) {
    const direction = statusRaw === "received" || (body && !statusRaw) ? "INBOUND" : "OUTBOUND";
    const contactNumber = direction === "INBOUND" ? from : to;
    const thread = await upsertWhatsAppThread({
      tenantId,
      providerType: "WHATSAPP_TWILIO",
      contactNumber,
      lastDirection: direction,
      lastStatus: statusRaw || (direction === "INBOUND" ? "INBOUND" : "QUEUED"),
      lastMessagePreview: body ? body.slice(0, 160) : null
    });

    if (messageSid) {
      const mappedStatus = statusRaw === "failed" || statusRaw === "undelivered"
        ? "FAILED"
        : statusRaw === "delivered"
          ? "DELIVERED"
          : statusRaw === "sent" || statusRaw === "accepted"
            ? "SENT"
            : direction === "INBOUND"
              ? "INBOUND"
              : "QUEUED";

      const updated = await updateWhatsAppMessageStatus({
        providerType: "WHATSAPP_TWILIO",
        externalMessageId: messageSid,
        status: mappedStatus,
        errorCode: mappedStatus === "FAILED" ? String(payload.ErrorCode || payload.error_code || "DELIVERY_FAILED") : null,
        metadata: payload,
        deliveredAt: mappedStatus === "DELIVERED" ? new Date() : null
      });
      if (!updated && (direction === "INBOUND" || body)) {
        await createWhatsAppMessage({
          tenantId,
          threadId: thread.id,
          providerType: "WHATSAPP_TWILIO",
          direction: direction as "INBOUND" | "OUTBOUND",
          fromNumber: from,
          toNumber: to,
          body: body || `[status:${mappedStatus}]`,
          externalMessageId: messageSid,
          status: mappedStatus,
          errorCode: mappedStatus === "FAILED" ? String(payload.ErrorCode || payload.error_code || "DELIVERY_FAILED") : null,
          metadata: payload,
          deliveredAt: mappedStatus === "DELIVERED" ? new Date() : null
        });
      }
    } else if (direction === "INBOUND" && body) {
      await createWhatsAppMessage({
        tenantId,
        threadId: thread.id,
        providerType: "WHATSAPP_TWILIO",
        direction: "INBOUND",
        fromNumber: from,
        toNumber: to,
        body,
        status: "INBOUND",
        metadata: payload
      });
    }
    await audit({ tenantId, action: "WHATSAPP_TWILIO_WEBHOOK_RECEIVED", entityType: "Tenant", entityId: tenantId });
  }
  return { ok: true, provider: "WHATSAPP_TWILIO", tenantMatched: !!tenantId, to: maskValue(to, 2, 2), from: maskValue(from, 2, 2) };
});

app.get("/webhooks/whatsapp/meta", async (req, reply) => {
  const q = z.object({ "hub.mode": z.string().optional(), "hub.verify_token": z.string().optional(), "hub.challenge": z.string().optional() }).parse(req.query || {});
  if (String(q["hub.mode"] || "") !== "subscribe") return reply.status(400).send({ error: "INVALID_MODE" });

  const verifyToken = String(q["hub.verify_token"] || "");
  if (!verifyToken) return reply.status(403).send({ error: "INVALID_VERIFY_TOKEN" });

  const rows = await db.whatsAppProviderConfig.findMany({ where: { provider: "WHATSAPP_META", isEnabled: true } });
  for (const row of rows) {
    try {
      const creds = decryptJson<WhatsAppMetaCredentialPayload>(row.credentialsEncrypted);
      if (creds.verifyToken === verifyToken) {
        return reply.send(String(q["hub.challenge"] || ""));
      }
    } catch {
      // skip broken credential rows
    }
  }

  return reply.status(403).send({ error: "INVALID_VERIFY_TOKEN" });
});

app.post("/webhooks/whatsapp/meta", async (req, reply) => {
  const body = req.body as any;
  const entry = Array.isArray(body?.entry) ? body.entry[0] : null;
  const changes = Array.isArray(entry?.changes) ? entry.changes[0] : null;
  const value = changes?.value || {};
  const metadata = value?.metadata || {};
  const phoneNumberId = String(metadata?.phone_number_id || "").trim();

  let tenantId: string | null = null;
  if (phoneNumberId) {
    const rows = await db.whatsAppProviderConfig.findMany({ where: { provider: "WHATSAPP_META" } });
    for (const row of rows) {
      try {
        const creds = decryptJson<WhatsAppMetaCredentialPayload>(row.credentialsEncrypted);
        if (creds.phoneNumberId === phoneNumberId) {
          tenantId = row.tenantId;
          break;
        }
      } catch {
        // skip broken credential rows
      }
    }
  }

  if (tenantId) {
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
    const displayNumber = String(metadata?.display_phone_number || "").trim();

    for (const m of messages) {
      const from = String(m?.from || "").trim();
      const textBody = String(m?.text?.body || m?.button?.text || "").trim();
      const extId = String(m?.id || "").trim();
      const thread = await upsertWhatsAppThread({
        tenantId,
        providerType: "WHATSAPP_META",
        contactNumber: from,
        lastDirection: "INBOUND",
        lastStatus: "INBOUND",
        lastMessagePreview: textBody.slice(0, 160)
      });
      await createWhatsAppMessage({
        tenantId,
        threadId: thread.id,
        providerType: "WHATSAPP_META",
        direction: "INBOUND",
        fromNumber: from,
        toNumber: displayNumber || `meta:${phoneNumberId}`,
        body: textBody || "[non-text message]",
        externalMessageId: extId || null,
        status: "INBOUND",
        metadata: m
      });
    }

    for (const s of statuses) {
      const extId = String(s?.id || "").trim();
      if (!extId) continue;
      const mappedStatus = String(s?.status || "").toLowerCase() === "failed"
        ? "FAILED"
        : String(s?.status || "").toLowerCase() === "delivered"
          ? "DELIVERED"
          : String(s?.status || "").toLowerCase() === "sent"
            ? "SENT"
            : "QUEUED";
      await updateWhatsAppMessageStatus({
        providerType: "WHATSAPP_META",
        externalMessageId: extId,
        status: mappedStatus,
        errorCode: mappedStatus === "FAILED" ? String(s?.errors?.[0]?.code || "DELIVERY_FAILED") : null,
        metadata: s,
        deliveredAt: mappedStatus === "DELIVERED" ? new Date() : null
      });
    }

    await audit({ tenantId, action: "WHATSAPP_META_WEBHOOK_RECEIVED", entityType: "Tenant", entityId: tenantId });
  }

  return { ok: true, provider: "WHATSAPP_META", tenantMatched: !!tenantId };
});

app.post("/webhooks/sola-cardknox", async (req, reply) => {
  const ip = String((req.headers["x-forwarded-for"] || req.ip || "")).split(",")[0].trim();
  if (!checkBillingRateLimit(`webhook:${ip}`, 240, 60 * 1000)) {
    return reply.status(429).send({ error: "RATE_LIMITED" });
  }

  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  const envAdapter = getSolaAdapter();

  let event;
  try {
    event = envAdapter.parseWebhookEvent(rawBody);
  } catch {
    return reply.status(400).send({ error: "invalid_payload" });
  }
  if (!event.eventId) return reply.status(400).send({ error: "missing_event_id" });

  const seen = await db.paymentEvent.findFirst({ where: { provider: "SOLA_CARDKNOX", providerEventId: event.eventId } });
  if (seen) return { ok: true, deduped: true };

  const invoiceToken = String((event.payload as any)?.invoiceToken || (event.payload as any)?.xInvoiceToken || "").trim();
  let invoice = invoiceToken ? await db.invoice.findFirst({ where: { payToken: invoiceToken } }) : null;
  if (!invoice && event.providerSubscriptionId) {
    invoice = await db.invoice.findFirst({ where: { OR: [{ providerInvoiceRef: event.providerSubscriptionId }, { id: event.providerSubscriptionId }] } });
  }

  if (invoice) {
    let verifyAdapter = envAdapter;
    try {
      const tenantSola = await getTenantSolaConfig(invoice.tenantId, { requireEnabled: false, allowFallbackEnv: true });
      verifyAdapter = getSolaAdapter(tenantSola.adapterConfig);
    } catch {
      verifyAdapter = envAdapter;
    }

    const validSignature = verifyAdapter.verifyWebhook(req.headers as any, rawBody) || envAdapter.verifyWebhook(req.headers as any, rawBody);
    if (!validSignature) return reply.status(403).send({ error: "invalid_signature" });

    await db.paymentEvent.create({
      data: {
        tenantId: invoice.tenantId,
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
      const updated = await db.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: new Date(), lastFailureReason: null } });
      await queueReceiptEmail({ tenantId: updated.tenantId, to: updated.customerEmail, amountCents: updated.amountCents, periodEnd: new Date(), receiptId: updated.id });
      await logInvoiceEvent({ tenantId: updated.tenantId, invoiceId: updated.id, type: "PAID", payload: { providerEventId: event.eventId } });
      await audit({ tenantId: updated.tenantId, action: "INVOICE_PAYMENT_SUCCEEDED", entityType: "Invoice", entityId: updated.id });
      return { ok: true, invoiceId: updated.id, invoiceStatus: updated.status };
    }

    if (event.status === "FAILED") {
      const retryUrl = `https://app.connectcomunications.com/pay/invoice/${invoice.payToken}`;
      const updated = await db.invoice.update({
        where: { id: invoice.id },
        data: {
          status: invoice.status === "OVERDUE" ? "OVERDUE" : "SENT",
          lastFailureReason: event.type || "payment_failed"
        }
      });
      await queueInvoiceDeclineEmail({ tenantId: updated.tenantId, invoiceId: updated.id, to: updated.customerEmail, amountCents: updated.amountCents, retryUrl });
      await logInvoiceEvent({ tenantId: updated.tenantId, invoiceId: updated.id, type: "DECLINED", payload: { providerEventId: event.eventId } });
      await audit({ tenantId: updated.tenantId, action: "INVOICE_PAYMENT_FAILED", entityType: "Invoice", entityId: updated.id });
      return { ok: true, invoiceId: updated.id, invoiceStatus: updated.status };
    }

    return { ok: true, invoiceId: invoice.id, ignoredStatus: event.status };
  }

  const sub = await db.subscription.findFirst({
    where: {
      OR: [
        event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : undefined,
        event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : undefined
      ].filter(Boolean) as any
    }
  });
  if (!sub) return { ok: true, unmatched: true };

  let verifyAdapter = envAdapter;
  try {
    const tenantSola = await getTenantSolaConfig(sub.tenantId, { requireEnabled: false, allowFallbackEnv: true });
    verifyAdapter = getSolaAdapter(tenantSola.adapterConfig);
  } catch {
    verifyAdapter = envAdapter;
  }

  const validSignature = verifyAdapter.verifyWebhook(req.headers as any, rawBody) || envAdapter.verifyWebhook(req.headers as any, rawBody);
  if (!validSignature) {
    return reply.status(403).send({ error: "invalid_signature" });
  }

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

const emailJobTimer = setInterval(() => {
  processEmailJobsBatch().catch((e) => app.log.error({ err: e }, "email job processor failed"));
}, 15_000);
emailJobTimer.unref();

const invoiceOverdueTimer = setInterval(() => {
  processInvoiceOverdueBatch().catch((e) => app.log.error({ err: e }, "invoice overdue processor failed"));
}, 60_000);
invoiceOverdueTimer.unref();

async function processIvrScheduleBatch(): Promise<void> {
  const now = new Date();
  const rows = await db.ivrSchedule.findMany({
    where: {
      enabled: true,
      startTime: { lte: new Date(now.getTime() + 60_000) },
      endTime: { gte: new Date(now.getTime() - 60_000) }
    },
    take: 100
  });
  for (const row of rows) {
    const link = await db.tenantPbxLink.findUnique({ where: { tenantId: row.tenantId }, include: { pbxInstance: true } });
    if (!link) continue;
    await queuePbxJob({
      tenantId: row.tenantId,
      pbxInstanceId: link.pbxInstanceId,
      type: "IVR_RECORDING_SWITCH",
      payload: { ivrId: row.ivrId, recordingId: row.recordingId, scheduleId: row.id },
      lastError: null
    });
  }
}

async function processAutomationRulesBatch(): Promise<void> {
  const rules = await db.automationRule.findMany({ where: { isEnabled: true }, take: 200 });
  if (rules.length === 0) return;
  const since = new Date(Date.now() - 90_000);
  for (const rule of rules) {
    if (rule.triggerType === "NEW_CUSTOMER") {
      const customers = await db.customer.findMany({ where: { tenantId: rule.tenantId, createdAt: { gte: since } }, take: 10 });
      for (const customer of customers) {
        if (rule.actionType === "TAG_CUSTOMER") {
          const payload = (rule.actionPayload || {}) as any;
          const nextTags = Array.isArray(customer.tags) ? [...customer.tags] : [];
          if (payload?.tag && !nextTags.includes(payload.tag)) nextTags.push(payload.tag);
          await db.customer.update({ where: { id: customer.id }, data: { tags: nextTags as any } });
        } else if (rule.actionType === "CREATE_TASK") {
          await db.customerTask.create({
            data: {
              tenantId: customer.tenantId,
              customerId: customer.id,
              title: String(((rule.actionPayload || {}) as any).title || "Follow up new customer"),
              body: String(((rule.actionPayload || {}) as any).body || ""),
              createdByUserId: rule.createdByUserId
            }
          });
        }
      }
    }
  }
}

const ivrScheduleTimer = setInterval(() => {
  processIvrScheduleBatch().catch((e) => app.log.error({ err: e }, "ivr schedule processor failed"));
}, 60_000);
ivrScheduleTimer.unref();

const automationRuleTimer = setInterval(() => {
  processAutomationRulesBatch().catch((e) => app.log.error({ err: e }, "automation rule processor failed"));
}, 60_000);
automationRuleTimer.unref();


// ─────────────────────────────────────────────────────────────────────────────
// PBX LIVE METRICS ENDPOINTS
// VitalPBX REST API v2 /api/v2/cdr = completed calls (written on hangup).
// Active calls require Asterisk ARI; set PBX_ARI_USER + PBX_ARI_PASS.
//
// CACHING STRATEGY
//   live-combined:<tenantId>  TTL 10 s   per-tenant CDR + ARI fetch result
//   admin-live-combined       TTL 30 s   all-tenant aggregation
//   resources:<tenantId>:<r>  TTL 120 s  extension/trunk/queue list proxies
//
// INFLIGHT DEDUPLICATION
//   PBX_LIVE_INFLIGHT prevents parallel requests from triggering duplicate
//   VitalPBX API calls.  All concurrent requests for the same key wait on the
//   same Promise and share the result.
// ─────────────────────────────────────────────────────────────────────────────

const PBX_LIVE_CACHE = new Map<string, { at: number; payload: any }>();
const PBX_LIVE_INFLIGHT = new Map<string, Promise<any>>();
const PBX_LIVE_TTL_COMBINED  = 120_000;  // 2 min  per-tenant combined (ARI + DB KPIs)
const PBX_LIVE_TTL_ADMIN     = 300_000;  // 5 min  admin all-tenant aggregation
const PBX_LIVE_TTL_RESOURCES = 120_000; // 120 s extension/trunk/queue lists

function normalizePbxActiveCall(raw: any, tenantId?: string | null): {
  channelId: string;
  tenantId: string | null;
  direction: "incoming" | "outgoing" | "internal";
  caller: string;
  callee: string;
  extension: string | null;
  startedAt: string | null;
  durationSeconds: number;
  state: string;
  queue: string | null;
  bridgeId?: string;
  bridgeChannelCount?: number;
} {
  const state = String(raw?.state || raw?.channelstate_text || raw?.status || "Up").toLowerCase();
  const caller = String(raw?.caller?.number || raw?.callerid_num || raw?.src || raw?.from || "");
  const callee = String(raw?.connected?.number || raw?.exten || raw?.dst || raw?.to || "");
  const creationTime = raw?.creationtime || raw?.start || raw?.calldate || null;
  const durationSec = raw?.duration != null ? Number(raw.duration) : raw?.creationtime
    ? Math.floor((Date.now() - new Date(raw.creationtime).getTime()) / 1000)
    : 0;
  const ctx = String(raw?.dialplan?.context || raw?.context || "");
  const exten = String(raw?.dialplan?.exten || raw?.exten || "");
  const callerIdNum = String(raw?.caller?.number || raw?.callerid_num || raw?.src || raw?.from || "");
  const direction = inferPbxLiveDirection(ctx, exten, callerIdNum);
  return {
    channelId: String(raw?.id || raw?.channel || raw?.uniqueid || `ch-${Math.random().toString(36).slice(2)}`),
    tenantId: tenantId || null,
    direction,
    caller,
    callee,
    extension: callee || caller || null,
    startedAt: creationTime ? new Date(creationTime).toISOString() : null,
    durationSeconds: Math.max(0, durationSec),
    state,
    queue: raw?.queue || null,
    ...(raw?.bridgeId != null ? { bridgeId: String(raw.bridgeId) } : {}),
    ...(raw?.bridgeChannelCount != null ? { bridgeChannelCount: Number(raw.bridgeChannelCount) } : {})
  };
}

// ─── Per-tenant fetch with inflight dedup ────────────────────────────────────
// Live "today" totals come from ConnectCdr (AMI/telephony ingest) — NOT VitalPBX REST cdr.list.
// Active channels + registration counts use Asterisk ARI HTTP only (same host; not the Vital app API).
// All concurrent requests for the same tenant key share one Promise.

/** Full calendar day in PBX_TIMEZONE as UTC half-open interval [start, end). Matches dashboard/call-kpis Connect counts. */
function computePbxLocalDayRangeUtc(nowUtc: Date = new Date()): {
  timezone: string;
  todayStr: string;
  dayStartUtc: Date;
  dayEndUtc: Date;
  timeWhere: { gte: Date; lt: Date };
} {
  const timezone = process.env.PBX_TIMEZONE?.trim() || "UTC";
  const todayStr = nowUtc.toLocaleDateString("en-CA", { timeZone: timezone });
  const [y, mo, d] = todayStr.split("-").map(Number);
  const noonUtc = Date.UTC(y!, mo! - 1, d!, 12, 0, 0, 0);
  const noonLocal = new Date(noonUtc).toLocaleTimeString("en-US", {
    timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false
  });
  const [hStr, mStr] = noonLocal.split(":");
  const offsetMs = ((Number(hStr ?? 0) * 60) + Number(mStr ?? 0)) * 60 * 1000;
  const dayStartUtc = new Date(noonUtc - offsetMs);
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  return {
    timezone,
    todayStr,
    dayStartUtc,
    dayEndUtc,
    timeWhere: { gte: dayStartUtc, lt: dayEndUtc },
  };
}

/** tenantKey: real tenant id, vpbx:* slug id, or "global" for all rows in DB. */
async function getConnectCdrTodayKpisForLiveDashboard(tenantKey: string): Promise<{
  callsToday: number;
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  answeredToday: number;
  missedToday: number;
}> {
  const { timeWhere } = computePbxLocalDayRangeUtc();
  const tenantClause = tenantKey === "global" ? {} : { tenantId: tenantKey };
  const base = { ...tenantClause, startedAt: timeWhere };
  const [incoming, outgoing, internal, missed, answered, total] = await Promise.all([
    db.connectCdr.count({ where: { ...base, direction: "incoming" } }),
    db.connectCdr.count({ where: { ...base, direction: "outgoing" } }),
    db.connectCdr.count({ where: { ...base, direction: "internal" } }),
    db.connectCdr.count({ where: { ...base, direction: "incoming", disposition: "missed" } }),
    db.connectCdr.count({ where: { ...base, disposition: "answered" } }),
    db.connectCdr.count({ where: base }),
  ]);
  return {
    callsToday: total,
    incomingToday: incoming,
    outgoingToday: outgoing,
    internalToday: internal,
    answeredToday: answered,
    missedToday: missed,
  };
}

type PbxLiveResult = {
  callsToday: number;
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  answeredToday: number;
  missedToday: number;
  activeCalls: number;
  activeCallsSource: "ari" | "unavailable";
  activeCallsList: ReturnType<typeof normalizePbxActiveCall>[];
  registeredEndpoints: number | null;
  unregisteredEndpoints: number | null;
  tenantId: string;
  lastUpdatedAt: string;
};

async function fetchAriSliceForPbxLive(
  client: VitalPbxClient,
  tenantLabel: string
): Promise<Pick<PbxLiveResult, "activeCallsList" | "activeCallsSource" | "registeredEndpoints" | "unregisteredEndpoints">> {
  const ariUser = process.env.PBX_ARI_USER || "";
  const ariPass = process.env.PBX_ARI_PASS || "";
  let activeCallsList: ReturnType<typeof normalizePbxActiveCall>[] = [];
  let activeCallsSource: "ari" | "unavailable" = "unavailable";
  let registeredEndpoints: number | null = null;
  let unregisteredEndpoints: number | null = null;
  if (ariUser && ariPass) {
    const [bridged, endpointCounts] = await Promise.all([
      client.getAriBridgedActiveCalls(ariUser, ariPass).catch(() => null),
      client.getAriEndpointCounts(ariUser, ariPass).catch(() => null)
    ]);
    if (bridged) {
      activeCallsSource = "ari";
      activeCallsList = bridged.bridges.map((b) =>
        normalizePbxActiveCall(
          {
            id: b.sourceKind === "bridge" ? `bridge:${b.bridgeId}` : b.bridgeId,
            state: "Up",
            caller: { number: b.caller },
            connected: { number: b.callee },
            dialplan: {
              context: b.dialplanContext ?? "",
              exten: b.dialplanExten ?? ""
            },
            bridgeId: b.bridgeId,
            bridgeChannelCount: b.channelCount
          },
          tenantLabel
        )
      );
      if (
        bridged.debug.totalBridges > 0 &&
        bridged.debug.qualifyingBridges === 0 &&
        bridged.debug.orphanLegCalls === 0
      ) {
        app.log.warn(
          {
            tenantLabel,
            activeCalls: bridged.activeCalls,
            verification: bridged.verification
          },
          "pbx_live:ari_bridged_active_all_bridges_excluded"
        );
      } else if (process.env.PBX_ARI_BRIDGED_VERIFY_LOG?.toLowerCase() === "true") {
        app.log.info({ tenantLabel, verification: bridged.verification }, "pbx_live:ari_bridged_active_verify");
      }
    }
    if (endpointCounts) {
      registeredEndpoints = endpointCounts.registered;
      unregisteredEndpoints = endpointCounts.unregistered;
    }
  }
  return { activeCallsList, activeCallsSource, registeredEndpoints, unregisteredEndpoints };
}

async function fetchPbxLiveSummaryForLink(
  link: { pbxInstance: { baseUrl: string; apiAuthEncrypted: string }; pbxTenantId?: string | null },
  tenantId: string
): Promise<PbxLiveResult> {
  let auth: { token: string; secret?: string };
  try {
    auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  } catch (err: any) {
    const e = new Error(err?.message || "Failed to decrypt PBX credentials") as Error & { code?: string };
    e.code = "PBX_DECRYPT_FAILED";
    throw e;
  }
  if (!auth?.token?.trim()) {
    const e = new Error("PBX API token is missing") as Error & { code?: string };
    e.code = "PBX_MISSING_TOKEN";
    throw e;
  }
  const client = getVitalPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret });

  const kpi = await getConnectCdrTodayKpisForLiveDashboard(tenantId);
  const {
    activeCallsList,
    activeCallsSource,
    registeredEndpoints,
    unregisteredEndpoints
  } = await fetchAriSliceForPbxLive(client, tenantId);

  return {
    callsToday: kpi.callsToday,
    incomingToday: kpi.incomingToday,
    outgoingToday: kpi.outgoingToday,
    internalToday: kpi.internalToday,
    answeredToday: kpi.answeredToday,
    missedToday: kpi.missedToday,
    activeCalls: activeCallsList.length,
    activeCallsSource,
    activeCallsList,
    registeredEndpoints,
    unregisteredEndpoints,
    tenantId,
    lastUpdatedAt: new Date().toISOString()
  };
}

// Returns the cached per-tenant result, or fires exactly one fetch (inflight-deduped).
async function getPbxLiveCombined(
  link: { pbxInstance: { baseUrl: string; apiAuthEncrypted: string }; pbxTenantId?: string | null },
  tenantId: string
): Promise<PbxLiveResult> {
  const key = `live-combined:${tenantId}`;
  const cached = PBX_LIVE_CACHE.get(key);
  if (cached && Date.now() - cached.at < PBX_LIVE_TTL_COMBINED) return cached.payload as PbxLiveResult;

  // Inflight dedup: if a fetch is already running for this tenant, wait for it.
  const inflight = PBX_LIVE_INFLIGHT.get(key);
  if (inflight) return inflight;

  const promise = fetchPbxLiveSummaryForLink(link, tenantId).then((result) => {
    PBX_LIVE_CACHE.set(key, { at: Date.now(), payload: result });
    PBX_LIVE_INFLIGHT.delete(key);
    return result;
  }).catch((err) => {
    PBX_LIVE_INFLIGHT.delete(key);
    throw err;
  });
  PBX_LIVE_INFLIGHT.set(key, promise);
  return promise;
}

// Admin-level aggregation across all tenant links — one Promise per cycle.
async function getAdminPbxLiveCombined(): Promise<{
  totalCallsToday: number;
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  answeredToday: number;
  missedToday: number;
  totalActiveCalls: number;
  activeTenantsCount: number;
  topTenants: Array<{ tenantId: string; callsToday: number; incomingToday: number; outgoingToday: number; internalToday: number; activeCalls: number; activeCallsSource: string }>;
  allActiveCalls: ReturnType<typeof normalizePbxActiveCall>[];
  lastUpdatedAt: string;
}> {
  const key = "admin-live-combined";
  const cached = PBX_LIVE_CACHE.get(key);
  if (cached && Date.now() - cached.at < PBX_LIVE_TTL_ADMIN) return cached.payload;

  const inflight = PBX_LIVE_INFLIGHT.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const enabledInstances = await db.pbxInstance.findMany({
      where: { isEnabled: true },
      take: 10
    });

    const links = await db.tenantPbxLink.findMany({
      where: { pbxInstanceId: { in: enabledInstances.map(i => i.id) } },
      include: { pbxInstance: true },
      take: 200
    });

    const PER_FETCH_MS = 6000;
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

    // Today totals: single Connect DB read (AMI-ingested CDR) — never VitalPBX REST cdr.list.
    const g = await getConnectCdrTodayKpisForLiveDashboard("global");

    const uniqueInstances = new Map<string, typeof links[0]>();
    for (const link of links) {
      if (!uniqueInstances.has(link.pbxInstance.id)) {
        uniqueInstances.set(link.pbxInstance.id, link);
      }
    }

    const allActiveCalls: ReturnType<typeof normalizePbxActiveCall>[] = [];
    const seenChannel = new Set<string>();
    for (const [, repLink] of uniqueInstances) {
      try {
        let auth: { token: string; secret?: string };
        auth = decryptJson<{ token: string; secret?: string }>(repLink.pbxInstance.apiAuthEncrypted);
        if (!auth?.token?.trim()) continue;
        const client = getVitalPbxClient({
          baseUrl: repLink.pbxInstance.baseUrl,
          token: auth.token,
          secret: auth.secret
        });
        const slice = await withTimeout(fetchAriSliceForPbxLive(client, "global"), PER_FETCH_MS);
        for (const ch of slice.activeCallsList) {
          if (seenChannel.has(ch.channelId)) continue;
          seenChannel.add(ch.channelId);
          allActiveCalls.push(ch);
        }
      } catch {
        // best-effort per instance
      }
    }

    const timezone = process.env.PBX_TIMEZONE?.trim() || "UTC";
    const nowUtc = new Date();
    const todayStr = nowUtc.toLocaleDateString("en-CA", { timeZone: timezone });
    const [y, mo, d] = todayStr.split("-").map(Number);
    const noonUtc = Date.UTC(y!, mo! - 1, d!, 12, 0, 0, 0);
    const noonLocal = new Date(noonUtc).toLocaleTimeString("en-US", {
      timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false
    });
    const [hStr, mStr] = noonLocal.split(":");
    const offsetMs = ((Number(hStr ?? 0) * 60) + Number(mStr ?? 0)) * 60 * 1000;
    const dayStartUtc = new Date(noonUtc - offsetMs);
    const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
    const timeWhere = { gte: dayStartUtc, lt: dayEndUtc };

    const grouped = await db.connectCdr.groupBy({
      by: ["tenantId"],
      where: { startedAt: timeWhere, tenantId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 12
    });

    const topIds = grouped.map((row) => row.tenantId!).filter(Boolean).slice(0, 10);
    const perTenant: Array<{ tenantId: string; callsToday: number; incomingToday: number; outgoingToday: number; internalToday: number; activeCalls: number; activeCallsSource: string }> = [];
    for (const tid of topIds) {
      const k = await getConnectCdrTodayKpisForLiveDashboard(tid);
      perTenant.push({
        tenantId: tid,
        callsToday: k.callsToday,
        incomingToday: k.incomingToday,
        outgoingToday: k.outgoingToday,
        internalToday: k.internalToday,
        activeCalls: allActiveCalls.filter((c) => c.tenantId === tid).length,
        activeCallsSource: allActiveCalls.length > 0 ? "ari" : "unavailable"
      });
    }

    const tenantsWithCallsToday = links.length;
    const topTenants = perTenant;

    const result = {
      totalCallsToday: g.callsToday,
      incomingToday: g.incomingToday,
      outgoingToday: g.outgoingToday,
      internalToday: g.internalToday,
      answeredToday: g.answeredToday,
      missedToday: g.missedToday,
      totalActiveCalls: allActiveCalls.length,
      activeTenantsCount: tenantsWithCallsToday,
      topTenants,
      allActiveCalls,
      lastUpdatedAt: new Date().toISOString()
    };
    PBX_LIVE_CACHE.set(key, { at: Date.now(), payload: result });
    PBX_LIVE_INFLIGHT.delete(key);
    return result;
  })().catch((err) => { PBX_LIVE_INFLIGHT.delete(key); throw err; });

  PBX_LIVE_INFLIGHT.set(key, promise);
  return promise;
}

// ─── Tenant endpoints ─────────────────────────────────────────────────────────

function requirePbxLink(reply: any) {
  return reply.status(404).send({ error: "PBX_NOT_LINKED", message: "No active PBX link for this tenant." });
}

// GET /pbx/live/diagnostics — link/decrypt, ConnectCdr today counts, ARI reachability (no VitalPBX REST CDR)
app.get("/pbx/live/diagnostics", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId: user.tenantId },
    include: { pbxInstance: true }
  });

  if (!link) {
    return reply.send({
      step: "link",
      ok: false,
      message: "No PBX link configured for this tenant.",
      hasLink: false,
      isEnabled: false,
      baseUrlHost: null,
      code: "PBX_NOT_LINKED"
    });
  }
  if (!link.pbxInstance.isEnabled) {
    return reply.send({
      step: "link",
      ok: false,
      message: "PBX instance is disabled.",
      hasLink: true,
      isEnabled: false,
      baseUrlHost: (() => {
        try { return new URL(link.pbxInstance.baseUrl).hostname; } catch { return null; }
      })(),
      code: "PBX_INSTANCE_DISABLED"
    });
  }

  let baseUrlHost: string | null = null;
  try {
    baseUrlHost = new URL(link.pbxInstance.baseUrl).hostname;
  } catch {
    return reply.send({
      step: "link",
      ok: false,
      message: "Invalid PBX base URL format.",
      hasLink: true,
      isEnabled: true,
      baseUrlHost: null,
      code: "PBX_INVALID_BASE_URL"
    });
  }

  let auth: { token: string; secret?: string };
  try {
    auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  } catch (err: any) {
    app.log.warn({ err: String(err?.message || err), tenantId: user.tenantId }, "pbx_diagnostics_decrypt_failed");
    return reply.send({
      step: "decrypt",
      ok: false,
      message: err?.message || "Failed to decrypt PBX credentials (wrong key or corrupted data).",
      baseUrlHost,
      code: "PBX_DECRYPT_FAILED"
    });
  }
  if (!auth?.token?.trim()) {
    return reply.send({
      step: "decrypt",
      ok: false,
      message: "PBX API token is missing after decrypt.",
      baseUrlHost,
      code: "PBX_MISSING_TOKEN"
    });
  }

  try {
    const kpi = await getConnectCdrTodayKpisForLiveDashboard(user.tenantId);
    const client = getVitalPbxClient({
      baseUrl: link.pbxInstance.baseUrl,
      token: auth.token,
      secret: auth.secret
    });
    const ari = await fetchAriSliceForPbxLive(client, user.tenantId);
    const ariOk = ari.activeCallsSource === "ari";
    return reply.send({
      step: "ok",
      ok: true,
      message: ariOk
        ? "ConnectCdr today KPIs + ARI reachable (no VitalPBX REST CDR used)."
        : "ConnectCdr today KPIs loaded; ARI not configured or unreachable.",
      baseUrlHost,
      pbxTenantId: link.pbxTenantId ?? null,
      timezone: process.env.PBX_TIMEZONE?.trim() || "UTC",
      incomingToday: kpi.incomingToday,
      outgoingToday: kpi.outgoingToday,
      internalToday: kpi.internalToday,
      missedToday: kpi.missedToday,
      answeredToday: kpi.answeredToday,
      callsToday: kpi.callsToday,
      ariBridgedActiveCalls: ari.activeCallsList.length,
      code: "OK"
    });
  } catch (err: any) {
    const code = err?.code || "DIAGNOSTICS_FAILED";
    const message = err?.message ? String(err.message) : "Diagnostics failed.";
    app.log.warn({ err: message, code, baseUrlHost, tenantId: user.tenantId }, "pbx_diagnostics_failed");
    return reply.send({
      step: "reach",
      ok: false,
      message,
      baseUrlHost,
      pbxTenantId: link.pbxTenantId ?? null,
      code
    });
  }
});

// GET /pbx/live/combined — single call returns both summary + active calls (preferred)
app.get("/pbx/live/combined", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  // SUPER_ADMIN with vpbx: tenant context: use first enabled instance scoped to that tenant.
  const pbxTenantOverride = (req as any).pbxTenantOverride as string | undefined;
  if (pbxTenantOverride && isRole(user, ["SUPER_ADMIN"])) {
    const overrideInstance = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
    if (!overrideInstance) return requirePbxLink(reply);
    const syntheticLink = {
      pbxInstance: { baseUrl: overrideInstance.baseUrl, apiAuthEncrypted: overrideInstance.apiAuthEncrypted },
      pbxTenantId: pbxTenantOverride
    };
    try {
      const r = await getPbxLiveCombined(syntheticLink, `vpbx:${pbxTenantOverride}`);
      return {
        summary: { tenantId: pbxTenantOverride, callsToday: r.callsToday, incomingToday: r.incomingToday, outgoingToday: r.outgoingToday, internalToday: r.internalToday, answeredToday: r.answeredToday, missedToday: r.missedToday, activeCalls: r.activeCalls, activeCallsSource: r.activeCallsSource, registeredEndpoints: r.registeredEndpoints, unregisteredEndpoints: r.unregisteredEndpoints, lastUpdatedAt: r.lastUpdatedAt },
        activeCalls: { calls: r.activeCallsList, source: r.activeCallsSource, lastUpdatedAt: r.lastUpdatedAt }
      };
    } catch (err: any) {
      return reply.status(502).send({ error: err?.code || "PBX_UNAVAILABLE", message: String(err?.message || "PBX data unavailable") });
    }
  }

  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId: user.tenantId },
    include: { pbxInstance: true }
  });
  if (!link || !link.pbxInstance.isEnabled) return requirePbxLink(reply);

  try {
    const r = await getPbxLiveCombined(link, user.tenantId);
    return {
      summary: {
        tenantId: user.tenantId,
        callsToday: r.callsToday,
        incomingToday: r.incomingToday,
        outgoingToday: r.outgoingToday,
        internalToday: r.internalToday,
        answeredToday: r.answeredToday,
        missedToday: r.missedToday,
        activeCalls: r.activeCalls,
        activeCallsSource: r.activeCallsSource,
        registeredEndpoints: r.registeredEndpoints,
        unregisteredEndpoints: r.unregisteredEndpoints,
        lastUpdatedAt: r.lastUpdatedAt
      },
      activeCalls: {
        calls: r.activeCallsList,
        source: r.activeCallsSource,
        lastUpdatedAt: r.lastUpdatedAt
      }
    };
  } catch (err: any) {
    app.log.warn({ err: String(err?.message || err), code: err?.code }, "pbx_live_combined_error");
    return reply.status(502).send({ error: err?.code || "PBX_UNAVAILABLE", message: String(err?.message || "PBX data unavailable") });
  }
});

// GET /pbx/live/summary — kept for compatibility; reads from shared cache
app.get("/pbx/live/summary", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId: user.tenantId },
    include: { pbxInstance: true }
  });
  if (!link || !link.pbxInstance.isEnabled) return requirePbxLink(reply);

  try {
    const r = await getPbxLiveCombined(link, user.tenantId);
    return {
      tenantId: user.tenantId,
      callsToday: r.callsToday,
      incomingToday: r.incomingToday,
      outgoingToday: r.outgoingToday,
      internalToday: r.internalToday,
      answeredToday: r.answeredToday,
      missedToday: r.missedToday,
      activeCalls: r.activeCalls,
      activeCallsSource: r.activeCallsSource,
      lastUpdatedAt: r.lastUpdatedAt
    };
  } catch (err: any) {
    return reply.status(502).send({ error: err?.code || "PBX_UNAVAILABLE", message: String(err?.message || "PBX data unavailable") });
  }
});

// GET /pbx/live/active-calls — kept for compatibility; reads from shared cache
app.get("/pbx/live/active-calls", async (req, reply) => {
  const user = await requirePermission(req, reply, canViewCustomers);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId: user.tenantId },
    include: { pbxInstance: true }
  });
  if (!link || !link.pbxInstance.isEnabled) {
    return { calls: [], source: "unavailable", message: "No active PBX link." };
  }

  try {
    const r = await getPbxLiveCombined(link, user.tenantId);
    return { calls: r.activeCallsList, source: r.activeCallsSource, lastUpdatedAt: r.lastUpdatedAt };
  } catch {
    return { calls: [], source: "unavailable", lastUpdatedAt: new Date().toISOString() };
  }
});

// ─── Admin endpoints ──────────────────────────────────────────────────────────

// GET /admin/pbx/live/combined — single request for admin dashboard (preferred)
app.get("/admin/pbx/live/combined", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  try {
    const r = await getAdminPbxLiveCombined();
    return {
      summary: {
        totalCallsToday: r.totalCallsToday,
        incomingToday: r.incomingToday,
        outgoingToday: r.outgoingToday,
        internalToday: r.internalToday,
        answeredToday: r.answeredToday,
        missedToday: r.missedToday,
        totalActiveCalls: r.totalActiveCalls,
        activeTenantsCount: r.activeTenantsCount,
        topTenants: r.topTenants,
        lastUpdatedAt: r.lastUpdatedAt
      },
      activeCalls: {
        calls: r.allActiveCalls,
        source: r.allActiveCalls.length > 0 ? "ari" : "unavailable",
        lastUpdatedAt: r.lastUpdatedAt
      }
    };
  } catch (err: any) {
    return reply.status(502).send({ error: "PBX_UNAVAILABLE", message: String(err?.message || "Aggregation failed") });
  }
});

// GET /admin/pbx/live/summary — reads from shared admin aggregation cache
app.get("/admin/pbx/live/summary", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  try {
    const r = await getAdminPbxLiveCombined();
    return {
      totalCallsToday: r.totalCallsToday,
      incomingToday: r.incomingToday,
      outgoingToday: r.outgoingToday,
      internalToday: r.internalToday,
      answeredToday: r.answeredToday,
      missedToday: r.missedToday,
      totalActiveCalls: r.totalActiveCalls,
      activeTenantsCount: r.activeTenantsCount,
      topTenants: r.topTenants,
      lastUpdatedAt: r.lastUpdatedAt
    };
  } catch (err: any) {
    return reply.status(502).send({ error: "PBX_UNAVAILABLE", message: String(err?.message || "Aggregation failed") });
  }
});

// GET /admin/diagnostics/ari-bridged-active-calls — temporary VitalPBX parity verification (super-admin only).
// Query: ?pbxInstanceId=... optional; defaults to most recently updated enabled instance.
app.get("/admin/diagnostics/ari-bridged-active-calls", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  const q = z.object({ pbxInstanceId: z.string().optional() }).parse(req.query || {});

  const instance = q.pbxInstanceId
    ? await db.pbxInstance.findFirst({ where: { id: q.pbxInstanceId, isEnabled: true } })
    : await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });

  if (!instance) {
    return reply.code(404).send({ error: "NO_PBX_INSTANCE", message: "No matching enabled PBX instance." });
  }

  const ariUser = process.env.PBX_ARI_USER || "";
  const ariPass = process.env.PBX_ARI_PASS || "";
  if (!ariUser || !ariPass) {
    return reply.code(503).send({
      error: "ARI_NOT_CONFIGURED",
      message: "Set PBX_ARI_USER and PBX_ARI_PASS on the API service."
    });
  }

  try {
    const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
    const client = getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret });
    const result = await client.getAriBridgedActiveCalls(ariUser, ariPass);
    if (!result) {
      return reply.code(502).send({
        error: "ARI_FETCH_FAILED",
        message: "Could not read /ari/bridges and /ari/channels from ARI."
      });
    }

    let pbxBaseUrlHost: string | null = null;
    try {
      pbxBaseUrlHost = new URL(instance.baseUrl).hostname;
    } catch {
      pbxBaseUrlHost = null;
    }

    return reply.send({
      asOf: new Date().toISOString(),
      pbxInstanceId: instance.id,
      pbxBaseUrlHost,
      summaryRows: result.bridges,
      rawBridgeCount: result.verification.rawBridgeCount,
      rawChannelCount: result.verification.rawChannelCount,
      qualifyingBridgeCount: result.verification.qualifyingBridgeCount,
      bridgeBackedCallCount: result.verification.bridgeBackedCallCount,
      orphanLegCallCount: result.verification.orphanLegCallCount,
      finalActiveCalls: result.verification.finalActiveCalls,
      qualifyingBridges: result.verification.qualifyingBridges,
      excludedBridges: result.verification.excludedBridges,
      orphanLegs: result.verification.orphanLegs
    });
  } catch (err: any) {
    app.log.warn({ err: String(err?.message), instanceId: instance.id }, "admin_diagnostics_ari_bridged_active_failed");
    return reply.code(502).send({ error: "DIAGNOSTICS_FAILED", message: String(err?.message || err) });
  }
});

// GET /admin/diagnostics/pbx-cdr-today-kpis — VitalPBX dashboard-equivalent "today" totals (cdr.list + calltype), super-admin only.
// Does not require CALL_KPIS_USE_VITALPBX_API (explicit read-only diagnostic).
app.get("/admin/diagnostics/pbx-cdr-today-kpis", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  const q = z.object({ tenantId: z.string().optional() }).parse(req.query || {});
  const scopeTenantId = q.tenantId && q.tenantId !== "global" ? q.tenantId : null;

  let pbxSlug: string | null = null;
  let pbxNum: string | null = null;
  if (scopeTenantId) {
    if (scopeTenantId.startsWith("vpbx:")) {
      pbxSlug = scopeTenantId.slice(5);
    } else {
      const link = await db.tenantPbxLink.findUnique({ where: { tenantId: scopeTenantId } });
      pbxNum = link?.pbxTenantId?.trim() || null;
      if (!pbxNum) {
        const t = await db.tenant.findUnique({ where: { id: scopeTenantId }, select: { name: true } });
        pbxSlug = t?.name?.trim() || null;
      }
    }
  }

  const timezone = process.env.PBX_TIMEZONE?.trim() || "UTC";
  try {
    const agg = await aggregateVitalpbxTodayCallKpis({
      timezone,
      pbxScopeSlug: pbxSlug,
      pbxScopeNumericId: pbxNum,
      responseTenantId: scopeTenantId,
    });
    return reply.send({
      asOf: new Date().toISOString(),
      timezone,
      pbxDashboardDefinition: {
        api: "VitalPBX REST v2 cdr.list (paged)",
        directionMapping:
          "calltype 1=internal, 2=incoming, 3=outgoing; see VitalPbxClient.getCdrToday in @connect/integrations",
        timeWindow:
          "Unix start_date/end_date for local calendar day with end = min(now, end of local day); same as VitalPBX UI CDR today",
      },
      ...agg,
    });
  } catch (err: any) {
    app.log.warn({ err: String(err?.message) }, "admin_diagnostics_pbx_cdr_today_kpis_failed");
    return reply.code(502).send({ error: "PBX_CDR_TODAY_FAILED", message: String(err?.message || err) });
  }
});

// GET /admin/diagnostics/connect-cdr-today-breakdown — ConnectCdr direction counts + samples (same day window as live KPI cards).
app.get("/admin/diagnostics/connect-cdr-today-breakdown", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;

  const q = z.object({ tenantId: z.string().optional() }).parse(req.query || {});
  const scopeTenantId = q.tenantId && q.tenantId !== "global" ? q.tenantId : null;
  const { timezone, todayStr, dayStartUtc, dayEndUtc, timeWhere } = computePbxLocalDayRangeUtc();
  const baseWhere = scopeTenantId ? { tenantId: scopeTenantId, startedAt: timeWhere } : { startedAt: timeWhere };

  const grouped = await db.connectCdr.groupBy({
    by: ["direction"],
    where: baseWhere,
    _count: { _all: true },
  });
  const countsByDirection: Record<string, number> = {};
  for (const g of grouped) {
    countsByDirection[g.direction] = g._count._all;
  }

  const totalRows = await db.connectCdr.count({ where: baseWhere });
  const tenantIdNullCount = await db.connectCdr.count({
    where: { ...baseWhere, tenantId: null },
  });

  let heuristicNotOutgoingShortFromLongToCount = 0;
  let heuristicSamples: Array<{
    id: string;
    linkedId: string;
    tenantId: string | null;
    fromNumber: string | null;
    toNumber: string | null;
    direction: string;
    disposition: string;
    startedAt: Date;
    durationSec: number;
  }> = [];

  try {
    if (scopeTenantId) {
      const hc = await db.$queryRaw<[{ c: bigint }]>`
        SELECT COUNT(*)::bigint AS c FROM "ConnectCdr"
        WHERE "startedAt" >= ${dayStartUtc} AND "startedAt" < ${dayEndUtc}
        AND "tenantId" = ${scopeTenantId}
        AND direction <> 'outgoing'
        AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
        AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) >= 10
      `;
      heuristicNotOutgoingShortFromLongToCount = Number(hc[0]?.c ?? 0);
      heuristicSamples = await db.$queryRaw`
        SELECT id, "linkedId", "tenantId", "fromNumber", "toNumber", direction, disposition, "startedAt", "durationSec"
        FROM "ConnectCdr"
        WHERE "startedAt" >= ${dayStartUtc} AND "startedAt" < ${dayEndUtc}
        AND "tenantId" = ${scopeTenantId}
        AND direction <> 'outgoing'
        AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
        AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) >= 10
        ORDER BY "startedAt" DESC
        LIMIT 15
      `;
    } else {
      const hc = await db.$queryRaw<[{ c: bigint }]>`
        SELECT COUNT(*)::bigint AS c FROM "ConnectCdr"
        WHERE "startedAt" >= ${dayStartUtc} AND "startedAt" < ${dayEndUtc}
        AND direction <> 'outgoing'
        AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
        AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) >= 10
      `;
      heuristicNotOutgoingShortFromLongToCount = Number(hc[0]?.c ?? 0);
      heuristicSamples = await db.$queryRaw`
        SELECT id, "linkedId", "tenantId", "fromNumber", "toNumber", direction, disposition, "startedAt", "durationSec"
        FROM "ConnectCdr"
        WHERE "startedAt" >= ${dayStartUtc} AND "startedAt" < ${dayEndUtc}
        AND direction <> 'outgoing'
        AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
        AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) >= 10
        ORDER BY "startedAt" DESC
        LIMIT 15
      `;
    }
  } catch (err: any) {
    app.log.warn({ err: String(err?.message) }, "connect_cdr_today_breakdown_heuristic_query_failed");
  }

  const outgoingSamples = await db.connectCdr.findMany({
    where: { ...baseWhere, direction: "outgoing" },
    orderBy: { startedAt: "desc" },
    take: 15,
    select: {
      id: true,
      linkedId: true,
      tenantId: true,
      fromNumber: true,
      toNumber: true,
      direction: true,
      disposition: true,
      startedAt: true,
      durationSec: true,
    },
  });

  const tenantKey = scopeTenantId ?? "global";
  const liveDashboardKpis = await getConnectCdrTodayKpisForLiveDashboard(tenantKey);

  return reply.send({
    asOf: new Date().toISOString(),
    timezone,
    todayStr,
    dayStartUtc: dayStartUtc.toISOString(),
    dayEndUtc: dayEndUtc.toISOString(),
    scope: scopeTenantId ? "tenant" : "global",
    tenantId: scopeTenantId,
    countsByDirection,
    totalRows,
    tenantIdNullCount,
    heuristicNotOutgoingShortFromLongToCount,
    heuristicNote:
      "Rows with short from (2–6 digits) and long to (10+ digits) but direction != outgoing — likely misclassified outbound or ambiguous local numbers.",
    outgoingSamples,
    heuristicMisclassifiedCandidates: heuristicSamples,
    liveDashboardKpis,
  });
});

/** PBX REST row → join key (Asterisk linkedid when present; else uniqueid). */
function pbxCdrRowLinkedKey(row: any): string {
  const v = row?.linkedid ?? row?.linked_id ?? row?.uniqueid ?? row?.unique_id;
  if (v == null || String(v).trim() === "") return "";
  return String(v).trim();
}

function pbxCdrDirectionFromRow(r: any): "incoming" | "outgoing" | "internal" | "unknown" {
  const ct = Number(r?.calltype ?? r?.callType ?? 0);
  if (ct === 1) return "internal";
  if (ct === 2) return "incoming";
  if (ct === 3) return "outgoing";
  const dir = String(r?.direction || r?.call_type || "").toLowerCase();
  if (dir.includes("in") && !dir.includes("internal")) return "incoming";
  if (dir.includes("internal")) return "internal";
  if (dir.includes("out")) return "outgoing";
  return "unknown";
}

async function runCdrPipelineReconciliation(params: {
  scopeTenantId: string | null;
  pbxSlug: string | null;
  pbxNum: string | null;
  dayStartUtc: Date;
  dayEndExclusive: Date;
  timezone: string;
  todayStr: string;
}): Promise<Record<string, unknown>> {
  const timeWhere = { gte: params.dayStartUtc, lt: params.dayEndExclusive };
  const baseWhere = params.scopeTenantId
    ? { tenantId: params.scopeTenantId, startedAt: timeWhere }
    : { startedAt: timeWhere };

  const instance = await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  if (!instance) throw new Error("NO_PBX_INSTANCE");
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  // Use a longer timeout for reconciliation CDR fetches (PBX_RECONCILIATION_TIMEOUT_MS,
  // default 45s) so chunked gesheft fetches don't time out at the standard 10s limit.
  const reconciliationTimeoutMs = Number(process.env.PBX_RECONCILIATION_TIMEOUT_MS || 45000);
  const client = getVitalPbxClient({
    baseUrl: instance.baseUrl,
    token: auth.token,
    secret: auth.secret,
    timeoutMs: reconciliationTimeoutMs,
  });

  const tenants = await client.listTenants();
  const excludeNames = parseVitalpbxCdrAggregateExcludeNames();
  type Tgt = { id: string; name: string };
  const targets: Tgt[] = [];
  for (const t of tenants) {
    const name = String((t as { name?: string }).name || "").trim();
    const id = String((t as { tenant_id?: string; id?: string }).tenant_id ?? (t as { id?: string }).id ?? "").trim();
    if (!id || !name) continue;
    if (excludeNames.has(name.toLowerCase())) continue;
    if (params.pbxNum) {
      if (id !== params.pbxNum) continue;
    } else if (params.pbxSlug) {
      if (normSlug(name) !== normSlug(params.pbxSlug)) continue;
    }
    targets.push({ id, name });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = Math.floor(params.dayStartUtc.getTime() / 1000);
  const endSec = Math.min(nowSec, Math.max(startSec, Math.floor((params.dayEndExclusive.getTime() - 1) / 1000)));

  const paginationNotesByTenant: Record<string, string | undefined> = {};
  let pbxRawRowTotal = 0;
  const mergedPbxRows: any[] = [];
  const tenantFetchErrors: Record<string, string> = {};
  // Fetch CDR rows for each tenant. Use chunked (hourly) fetching to avoid timeouts on
  // high-volume tenants (e.g. gesheft) where a full-day API query exceeds PBX_TIMEOUT_MS.
  // Tenants are processed in batches of 4 (reduced from 6) to limit concurrent PBX load.
  const batchSize = 4;
  for (let i = 0; i < targets.length; i += batchSize) {
    const slice = targets.slice(i, i + batchSize);
    const parts = await Promise.all(
      slice.map(async ({ id, name }) => {
        try {
          // First try the direct (non-chunked) fetch — faster for small tenants
          const pack = await client.getCdrRowsForWindow(id, startSec, endSec, { maxPages: 25, pageLimit: 800 });
          paginationNotesByTenant[name] = pack.paginationNotes;
          return { id, name, pack: { rows: pack.rows, rawRowCountFromApi: pack.rawRowCountFromApi }, error: null };
        } catch (directErr: any) {
          // If the direct fetch timed out, retry with hourly chunked fetching
          if (String(directErr?.message || directErr).includes("timed out") || String(directErr?.message || directErr).includes("timeout")) {
            try {
              const chunked = await client.getCdrRowsForWindowChunked(id, startSec, endSec, {
                maxPages: 10,
                pageLimit: 400,
                chunkSec: 1800, // 30-minute chunks (smaller = less likely to timeout)
              });
              if (chunked.chunkErrors.length > 0) {
                const errSummary = chunked.chunkErrors.map(e => `[${e.chunkStart}-${e.chunkEnd}]: ${e.error}`).join("; ");
                paginationNotesByTenant[name] = `chunked fetch; ${chunked.chunkCount} chunks; ${chunked.chunkErrors.length} chunk errors: ${errSummary}`;
                tenantFetchErrors[name] = `partial: ${chunked.chunkErrors.length}/${chunked.chunkCount} chunks failed`;
              } else {
                paginationNotesByTenant[name] = `chunked fetch; ${chunked.chunkCount} 1-hour chunks; direct fetch timed out`;
              }
              return { id, name, pack: { rows: chunked.rows, rawRowCountFromApi: chunked.rawRowCountFromApi }, error: null };
            } catch (chunkedErr: any) {
              const msg = String(chunkedErr?.message || chunkedErr);
              tenantFetchErrors[name] = `chunked fallback failed: ${msg}`;
              return { id, name, pack: { rows: [] as any[], rawRowCountFromApi: 0 }, error: msg };
            }
          }
          const msg = String(directErr?.message || directErr);
          tenantFetchErrors[name] = msg;
          return { id, name, pack: { rows: [] as any[], rawRowCountFromApi: 0 }, error: msg };
        }
      })
    );
    for (const { id, name, pack } of parts) {
      pbxRawRowTotal += pack.rawRowCountFromApi;
      for (const r of pack.rows) {
        mergedPbxRows.push({ ...r, _pbxTenantId: id, _pbxTenantName: name });
      }
    }
  }

  let pbxRowsWithoutJoinKey = 0;
  const canonicalByLinked = new Map<string, any>();
  for (const r of mergedPbxRows) {
    const key = pbxCdrRowLinkedKey(r);
    if (!key) {
      pbxRowsWithoutJoinKey++;
      continue;
    }
    const prev = canonicalByLinked.get(key);
    if (!prev) {
      canonicalByLinked.set(key, r);
      continue;
    }
    const score = (x: any) => Number(x?.billsec ?? x?.duration ?? 0);
    if (score(r) >= score(prev)) canonicalByLinked.set(key, r);
  }

  const pbxCanonicalTotal = canonicalByLinked.size;
  const pbxByDir = { incoming: 0, outgoing: 0, internal: 0, unknown: 0 };
  for (const r of canonicalByLinked.values()) {
    const d = pbxCdrDirectionFromRow(r);
    pbxByDir[d]++;
  }

  const connectRows: Array<{
    linkedId: string;
    tenantId: string | null;
    direction: string;
    fromNumber: string | null;
    toNumber: string | null;
    startedAt: Date;
    rawLegCount: number;
  }> = await db.connectCdr.findMany({
    where: baseWhere,
    select: {
      linkedId: true,
      tenantId: true,
      direction: true,
      fromNumber: true,
      toNumber: true,
      startedAt: true,
      rawLegCount: true,
    },
  });

  const connectTotal = connectRows.length;
  const connectByDir = { incoming: 0, outgoing: 0, internal: 0, unknown: 0 };
  let connectTenantNull = 0;
  let connectDirectionUnknown = 0;
  let connectRawLegTotal = 0;
  for (const c of connectRows) {
    const d = c.direction as keyof typeof connectByDir;
    if (d in connectByDir) connectByDir[d]++;
    if (c.tenantId == null) connectTenantNull++;
    if (c.direction === "unknown") connectDirectionUnknown++;
    connectRawLegTotal += c.rawLegCount;
  }

  const tenantKey = params.scopeTenantId ?? "global";
  const kpiTenantClause = tenantKey === "global" ? {} : { tenantId: tenantKey };
  const [kpiIncoming, kpiOutgoing, kpiInternal] = await Promise.all([
    db.connectCdr.count({ where: { ...kpiTenantClause, startedAt: timeWhere, direction: "incoming" } }),
    db.connectCdr.count({ where: { ...kpiTenantClause, startedAt: timeWhere, direction: "outgoing" } }),
    db.connectCdr.count({ where: { ...kpiTenantClause, startedAt: timeWhere, direction: "internal" } }),
  ]);

  const connectLinkedIds = new Set(connectRows.map((c) => c.linkedId));
  const missingKeys: string[] = [];
  for (const k of canonicalByLinked.keys()) {
    if (!connectLinkedIds.has(k)) missingKeys.push(k);
  }

  const onlyConnectKeys: string[] = [];
  for (const c of connectRows) {
    if (!canonicalByLinked.has(c.linkedId)) onlyConnectKeys.push(c.linkedId);
  }

  type MisRow = {
    linkedId: string;
    from: string | null;
    to: string | null;
    startedAt: string;
    expectedDirection: string;
    actualDirection: string;
    pbxTenantName?: string;
    tenantId: string | null;
  };

  const misclassified: MisRow[] = [];
  for (const c of connectRows) {
    const pbx = canonicalByLinked.get(c.linkedId);
    if (!pbx) continue;
    const exp = pbxCdrDirectionFromRow(pbx);
    if (c.direction === "unknown" || exp === "unknown") continue;
    if (exp !== c.direction) {
      misclassified.push({
        linkedId: c.linkedId,
        from: c.fromNumber ?? (String(pbx?.src ?? pbx?.source ?? "").trim() || null),
        to: c.toNumber ?? (String(pbx?.dst ?? pbx?.destination ?? "").trim() || null),
        startedAt: c.startedAt.toISOString(),
        expectedDirection: exp,
        actualDirection: c.direction,
        pbxTenantName: pbx?._pbxTenantName,
        tenantId: c.tenantId,
      });
    }
  }

  const pbxTime = (r: any): string => {
    const raw = r?.date ?? r?.calldate ?? r?.start ?? r?.time;
    if (raw == null) return "";
    if (typeof raw === "number") {
      const ms = raw < 1e12 ? raw * 1000 : raw;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? "" : d.toISOString();
    }
    const d = new Date(String(raw));
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };

  const missingByPbxDir = { incoming: 0, outgoing: 0, internal: 0, unknown: 0 };
  const missingSamples: MisRow[] = [];
  for (const k of missingKeys) {
    const r = canonicalByLinked.get(k)!;
    const d = pbxCdrDirectionFromRow(r);
    missingByPbxDir[d]++;
    if (missingSamples.length < 12) {
      missingSamples.push({
        linkedId: k,
        from: String(r?.src ?? r?.source ?? "") || null,
        to: String(r?.dst ?? r?.destination ?? "") || null,
        startedAt: pbxTime(r),
        expectedDirection: d,
        actualDirection: "(no ConnectCdr row)",
        pbxTenantName: r?._pbxTenantName,
        tenantId: null,
      });
    }
  }

  const nullTenantSamples = connectRows
    .filter((c) => c.tenantId == null)
    .slice(0, 12)
    .map((c) => ({
      linkedId: c.linkedId,
      from: c.fromNumber,
      to: c.toNumber,
      startedAt: c.startedAt.toISOString(),
      expectedDirection: "(n/a)",
      actualDirection: c.direction,
      tenantId: null as string | null,
    }));

  let dupLinkedGroups = 0;
  let dupExtraRows = 0;
  try {
    const dupRaw = params.scopeTenantId
      ? await db.$queryRaw<Array<{ linkedId: string; c: bigint }>>`
          SELECT "linkedId", COUNT(*)::bigint AS c FROM "ConnectCdr"
          WHERE "startedAt" >= ${params.dayStartUtc} AND "startedAt" < ${params.dayEndExclusive}
            AND "tenantId" = ${params.scopeTenantId}
          GROUP BY "linkedId" HAVING COUNT(*) > 1
        `
      : await db.$queryRaw<Array<{ linkedId: string; c: bigint }>>`
          SELECT "linkedId", COUNT(*)::bigint AS c FROM "ConnectCdr"
          WHERE "startedAt" >= ${params.dayStartUtc} AND "startedAt" < ${params.dayEndExclusive}
          GROUP BY "linkedId" HAVING COUNT(*) > 1
        `;
    dupLinkedGroups = dupRaw.length;
    dupExtraRows = dupRaw.reduce((acc: number, row: { c: bigint }) => acc + Math.max(0, Number(row.c) - 1), 0);
  } catch {
    dupLinkedGroups = 0;
    dupExtraRows = 0;
  }

  let heuristicShortFromLongNotOutgoing = 0;
  let heuristicLongFromShortNotIncoming = 0;
  try {
    if (params.scopeTenantId) {
      const [h1] = await db.$queryRaw<[{ c: bigint }]>`
        SELECT COUNT(*)::bigint AS c FROM "ConnectCdr"
        WHERE "startedAt" >= ${params.dayStartUtc} AND "startedAt" < ${params.dayEndExclusive}
          AND "tenantId" = ${params.scopeTenantId}
          AND direction <> 'outgoing'
          AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
          AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) >= 10
      `;
      const [h2] = await db.$queryRaw<[{ c: bigint }]>`
        SELECT COUNT(*)::bigint AS c FROM "ConnectCdr"
        WHERE "startedAt" >= ${params.dayStartUtc} AND "startedAt" < ${params.dayEndExclusive}
          AND "tenantId" = ${params.scopeTenantId}
          AND direction <> 'incoming'
          AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) >= 10
          AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
      `;
      heuristicShortFromLongNotOutgoing = Number(h1?.c ?? 0);
      heuristicLongFromShortNotIncoming = Number(h2?.c ?? 0);
    } else {
      const [h1] = await db.$queryRaw<[{ c: bigint }]>`
        SELECT COUNT(*)::bigint AS c FROM "ConnectCdr"
        WHERE "startedAt" >= ${params.dayStartUtc} AND "startedAt" < ${params.dayEndExclusive}
          AND direction <> 'outgoing'
          AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
          AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) >= 10
      `;
      const [h2] = await db.$queryRaw<[{ c: bigint }]>`
        SELECT COUNT(*)::bigint AS c FROM "ConnectCdr"
        WHERE "startedAt" >= ${params.dayStartUtc} AND "startedAt" < ${params.dayEndExclusive}
          AND direction <> 'incoming'
          AND LENGTH(REGEXP_REPLACE(COALESCE("fromNumber", ''), '[^0-9]', '', 'g')) >= 10
          AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber", ''), '[^0-9]', '', 'g')) BETWEEN 2 AND 6
      `;
      heuristicShortFromLongNotOutgoing = Number(h1?.c ?? 0);
      heuristicLongFromShortNotIncoming = Number(h2?.c ?? 0);
    }
  } catch {
    /* optional diagnostics */
  }

  const kpiExclusionVsPersisted = 0;

  const section3TopLossPoints = [
    { cause: "pbx_canonical_row_missing_in_ConnectCdr", count: missingKeys.length, note: "PBX cdr.list row (by linkedid|uniqueid) with no matching ConnectCdr.linkedId — ingest skipped, wrong key, or telephony never posted." },
    { cause: "direction_mismatch_pbx_calltype_vs_ConnectCdr", count: misclassified.length, note: "Same linkedId; PBX calltype direction differs from Connect direction (excludes unknown on either side)." },
    { cause: "ConnectCdr_tenantId_null", count: connectTenantNull, note: "Persisted rows missing tenant — global KPI counts them; per-tenant dashboard omits them." },
    { cause: "ConnectCdr_direction_unknown", count: connectDirectionUnknown, note: "Ingest marked direction unknown." },
    { cause: "duplicate_linkedId_groups", count: dupLinkedGroups, note: "Schema has unique linkedId — expect 0 unless constraint bypassed." },
    { cause: "heuristic_short_from_long_to_not_outgoing", count: heuristicShortFromLongNotOutgoing, note: "Possible outbound misclassified as incoming/internal." },
    { cause: "heuristic_long_from_short_to_not_incoming", count: heuristicLongFromShortNotIncoming, note: "Possible inbound misclassified." },
    { cause: "ConnectCdr_only_not_in_pbx_window", count: onlyConnectKeys.length, note: "LinkedIds in Connect but not in PBX pull — timezone/window, tenant scope, or REST vs AMI id mismatch." },
    { cause: "pbx_rows_without_join_key", count: pbxRowsWithoutJoinKey, note: "PBX rows missing linkedid and uniqueid — cannot join to Connect." },
    { cause: "kpi_query_exclusion", count: kpiExclusionVsPersisted, note: "Reserved; 0 when KPI uses same startedAt window as this diagnostic." },
  ].sort((a, b) => b.count - a.count);

  const section5MinimalFixPlanOrdered = [
    ...(parseVitalpbxCdrAggregateExcludeNames().has("vitalpbx")
      ? ["Unset VITALPBX_CDR_AGGREGATE_EXCLUDE_NAMES vitalpbx if that tenant carries production traffic."]
      : []),
    ...(missingKeys.length > 0
      ? ["Trace telephony CdrNotifier skip reasons and POST /internal/cdr-ingest reachability for missing linkedIds."]
      : []),
    ...(misclassified.length > 0 ? ["Align inferDirection / AMI classification with VitalPBX calltype for the sample linkedIds."] : []),
    ...(connectTenantNull > 0 ? ["Improve dcontext/channel/CdrTenantRule resolution so tenantId is set before persist."] : []),
    ...(heuristicShortFromLongNotOutgoing > 0 ? ["Review outbound legs stored as incoming using heuristic samples."] : []),
    "Confirm PBX REST totals match VitalPBX UI for the same window; if not, pagination or tenant list is still wrong.",
  ];

  const funnelDir = (dir: "incoming" | "outgoing" | "internal") => ({
    pbxCanonical: pbxByDir[dir],
    connectPersisted: connectByDir[dir],
    kpiCounted: dir === "incoming" ? kpiIncoming : dir === "outgoing" ? kpiOutgoing : kpiInternal,
    missingVersusConnect: missingByPbxDir[dir],
  });

  return {
    section1_timeWindow: {
      timezone: params.timezone,
      todayStr: params.todayStr,
      dayStartUtc: params.dayStartUtc.toISOString(),
      dayEndExclusiveUtc: params.dayEndExclusive.toISOString(),
      pbxApiStartSec: startSec,
      pbxApiEndSec: endSec,
      pbxSource: "VitalPBX REST v2 cdr.list (paged per tenant; join key linkedid || uniqueid)",
      tenantsTargeted: targets.map((t) => t.name),
      tenantExcludePolicy: "VITALPBX_CDR_AGGREGATE_EXCLUDE_NAMES (default smoke,billing,test — vitalpbx not excluded by default)",
      paginationNotesByTenant,
      tenantFetchErrors,
    },
    section1_totals: {
      pbxRawRowsFromApi: pbxRawRowTotal,
      pbxCanonicalCalls: pbxCanonicalTotal,
      pbxByDirection: pbxByDir,
      connectCdrRows: connectTotal,
      connectRawLegTotal,                    // SUM(rawLegCount) — PBX-style channel-leg count from Connect
      connectLegsPerCall: connectTotal > 0 ? Math.round((connectRawLegTotal / connectTotal) * 100) / 100 : null,
      connectByDirection: connectByDir,
      kpiQuerySameWindow: { incoming: kpiIncoming, outgoing: kpiOutgoing, internal: kpiInternal },
    },
    section2_missingCallFunnel: {
      incoming: funnelDir("incoming"),
      outgoing: funnelDir("outgoing"),
      internal: funnelDir("internal"),
      evidenceNote:
        "Reached ingest is not counted here (no request log). Rows missing from ConnectCdr are bucket A/B until ingest logs prove otherwise.",
    },
    section3_topLossPoints: section3TopLossPoints,
    section4_sampleMismatches: {
      missingFromConnect: missingSamples.slice(0, 10),
      misclassified: misclassified.slice(0, 10),
      tenantNull: nullTenantSamples.slice(0, 10),
      onlyInConnectLinkedIdsSample: onlyConnectKeys.slice(0, 10),
    },
    section5_minimalFixPlanOrdered: section5MinimalFixPlanOrdered,
    counts: {
      missingPbxCanonicalNotInConnect: missingKeys.length,
      misclassifiedDirection: misclassified.length,
      connectTenantIdNull: connectTenantNull,
      connectOnlyRows: onlyConnectKeys.length,
      duplicateLinkedIdGroups: dupLinkedGroups,
      duplicateExtraRows: dupExtraRows,
    },
  };
}

// GET /admin/diagnostics/cdr-pipeline-reconciliation — PBX cdr.list vs ConnectCdr (super-admin, heavy).
app.get("/admin/diagnostics/cdr-pipeline-reconciliation", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  const q = z
    .object({
      tenantId: z.string().optional(),
      startIso: z.string().optional(),
      endIso: z.string().optional(),
      // Convenience: Unix-second timestamps accepted in addition to ISO strings
      startSec: z.coerce.number().int().optional(),
      endSec: z.coerce.number().int().optional(),
      // Direct PBX tenant slug override (bypasses tenantId lookup)
      pbxSlug: z.string().optional(),
      pbxNum: z.string().optional(),
    })
    .parse(req.query || {});

  const scopeTenantId = q.tenantId && q.tenantId !== "global" ? q.tenantId : null;
  let pbxSlug: string | null = q.pbxSlug?.trim() || null;
  let pbxNum: string | null = q.pbxNum?.trim() || null;
  if (!pbxSlug && !pbxNum && scopeTenantId) {
    if (scopeTenantId.startsWith("vpbx:")) {
      pbxSlug = scopeTenantId.slice(5);
    } else {
      const link = await db.tenantPbxLink.findUnique({ where: { tenantId: scopeTenantId } });
      pbxNum = link?.pbxTenantId?.trim() || null;
      if (!pbxNum) {
        const t = await db.tenant.findUnique({ where: { id: scopeTenantId }, select: { name: true } });
        pbxSlug = t?.name?.trim() || null;
      }
    }
  }

  let dayStartUtc: Date;
  let dayEndExclusive: Date;
  let timezone: string;
  let todayStr: string;
  if (q.startSec && q.endSec) {
    dayStartUtc = new Date(q.startSec * 1000);
    dayEndExclusive = new Date(q.endSec * 1000);
    timezone = process.env.PBX_TIMEZONE?.trim() || "UTC";
    todayStr = dayStartUtc.toISOString().slice(0, 10);
  } else if (q.startIso && q.endIso) {
    dayStartUtc = new Date(q.startIso);
    dayEndExclusive = new Date(q.endIso);
    if (Number.isNaN(dayStartUtc.getTime()) || Number.isNaN(dayEndExclusive.getTime())) {
      return reply.code(400).send({ error: "INVALID_ISO_RANGE" });
    }
    timezone = process.env.PBX_TIMEZONE?.trim() || "UTC";
    todayStr = dayStartUtc.toISOString().slice(0, 10);
  } else {
    const r = computePbxLocalDayRangeUtc();
    dayStartUtc = r.dayStartUtc;
    dayEndExclusive = r.dayEndUtc;
    timezone = r.timezone;
    todayStr = r.todayStr;
  }

  try {
    const body = await runCdrPipelineReconciliation({
      scopeTenantId,
      pbxSlug,
      pbxNum,
      dayStartUtc,
      dayEndExclusive,
      timezone,
      todayStr,
    });
    return reply.send({ asOf: new Date().toISOString(), ...body });
  } catch (err: any) {
    app.log.warn({ err: String(err?.message) }, "admin_diagnostics_cdr_pipeline_reconciliation_failed");
    return reply.code(502).send({ error: "CDR_PIPELINE_RECONCILIATION_FAILED", message: String(err?.message || err) });
  }
});

// ─── Dashboard Reconciliation ─────────────────────────────────────────────────
// GET /admin/diagnostics/dashboard-reconciliation
// Returns a side-by-side comparison of Connect Raw vs Connect Canonical (direction-corrected)
// KPI counts for the same time window used by /dashboard/call-kpis.
// Designed to be fast (DB-only, no PBX API calls) and safe to poll regularly.
app.get("/admin/diagnostics/dashboard-reconciliation", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;

  const q = z.object({
    tenantId: z.string().optional(),
    startIso: z.string().optional(),
    endIso: z.string().optional(),
  }).parse(req.query || {});

  const scopeTenantId = q.tenantId && q.tenantId !== "global" ? q.tenantId : null;

  let timeWhere: { gte: Date; lt: Date };
  let timezone: string;
  let todayStr: string;
  if (q.startIso && q.endIso) {
    const s = new Date(q.startIso);
    const e = new Date(q.endIso);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      return reply.code(400).send({ error: "INVALID_ISO_RANGE" });
    }
    timeWhere = { gte: s, lt: e };
    timezone = process.env.PBX_TIMEZONE?.trim() || "UTC";
    todayStr = s.toISOString().slice(0, 10);
  } else {
    const r = computePbxLocalDayRangeUtc();
    timeWhere = r.timeWhere;
    timezone = r.timezone;
    todayStr = r.todayStr;
  }

  try {
    const tenantClause = scopeTenantId ? { tenantId: scopeTenantId } : {};
    const baseWhere = { ...tenantClause, startedAt: timeWhere };

    // Raw counts — as stored in DB
    const [rawIncoming, rawOutgoing, rawInternal, rawUnknown, rawMissed, rawTotal] = await Promise.all([
      db.connectCdr.count({ where: { ...baseWhere, direction: "incoming" } }),
      db.connectCdr.count({ where: { ...baseWhere, direction: "outgoing" } }),
      db.connectCdr.count({ where: { ...baseWhere, direction: "internal" } }),
      db.connectCdr.count({ where: { ...baseWhere, direction: "unknown" } }),
      db.connectCdr.count({ where: { ...baseWhere, direction: "incoming", disposition: "missed" } }),
      db.connectCdr.count({ where: baseWhere }),
    ]);

    // Canonical counts — direction-corrected via SQL CASE
    const tenantSql = scopeTenantId ? `AND "tenantId" = '${scopeTenantId.replace(/'/g, "''")}'` : "";
    const startSql  = `'${timeWhere.gte.toISOString()}'::timestamptz`;
    const endSql    = `'${timeWhere.lt.toISOString()}'::timestamptz`;
    const dirSql    = cdrCanonicalDirectionSql();

    type CanonAgg = { incoming: bigint; outgoing: bigint; internal: bigint; unknown: bigint; missed: bigint; total: bigint };
    const [cr] = await db.$queryRawUnsafe<CanonAgg[]>(`
      WITH c AS (
        SELECT
          (${dirSql}) AS dir,
          disposition
        FROM "ConnectCdr"
        WHERE "startedAt" >= ${startSql} AND "startedAt" < ${endSql}
        ${tenantSql}
      )
      SELECT
        COUNT(*) FILTER (WHERE dir = 'incoming') AS incoming,
        COUNT(*) FILTER (WHERE dir = 'outgoing') AS outgoing,
        COUNT(*) FILTER (WHERE dir = 'internal') AS internal,
        COUNT(*) FILTER (WHERE dir = 'unknown')  AS unknown,
        COUNT(*) FILTER (WHERE dir = 'incoming' AND disposition = 'missed') AS missed,
        COUNT(*) AS total
      FROM c
    `);

    const canon = cr ? {
      incoming: Number(cr.incoming),
      outgoing: Number(cr.outgoing),
      internal: Number(cr.internal),
      unknown:  Number(cr.unknown),
      missed:   Number(cr.missed),
      total:    Number(cr.total),
    } : null;

    // Direction-misclassified rows (raw direction != canonical direction)
    type CandidateRow = { id: string; linkedId: string; fromNumber: string | null; toNumber: string | null; direction: string; dcontext: string | null };
    const candidateRows: CandidateRow[] = await db.connectCdr.findMany({
      where: baseWhere,
      select: { id: true, linkedId: true, fromNumber: true, toNumber: true, direction: true, dcontext: true },
    });
    type MismatchRow = CandidateRow & { canonical: string };
    const directionMismatches: MismatchRow[] = candidateRows
      .map((r: CandidateRow): MismatchRow => ({ ...r, canonical: canonicalDirection(r.fromNumber, r.toNumber, r.direction, r.dcontext) }))
      .filter((r: MismatchRow) => r.canonical !== r.direction);

    const mismatchSummary = directionMismatches.reduce<Record<string, number>>((acc: Record<string, number>, r: MismatchRow) => {
      const k = `${r.direction}→${r.canonical}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

    // Null-tenant rows
    const nullTenantCount = await db.connectCdr.count({ where: { ...baseWhere, tenantId: null } });

    // Edge-case counts: rows excluded from canonical override due to ambiguous numbers
    // Feature-code calls: to = 1–4 digits (voicemail shortcuts, transfer codes)
    const featureCodeCount = candidateRows.filter((r: CandidateRow) => {
      const toD = (r.toNumber ?? "").replace(/\D/g, "");
      return toD.length >= 1 && toD.length <= 4;
    }).length;
    // Ambiguous local-PSTN calls: extension → 7–9 digit number (may be outgoing, but excluded
    // from canonical override to avoid false positives with 7-digit PBX extension IDs)
    const ambiguousLocalCount = candidateRows.filter((r: CandidateRow) => {
      const fromD = (r.fromNumber ?? "").replace(/\D/g, "");
      const toD   = (r.toNumber   ?? "").replace(/\D/g, "");
      const fromIsExt = fromD.length >= 2 && fromD.length <= 6;
      return fromIsExt && toD.length >= 7 && toD.length <= 9;
    }).length;

    return reply.send({
      asOf: new Date().toISOString(),
      window: {
        start: timeWhere.gte.toISOString(),
        end: timeWhere.lt.toISOString(),
        timezone,
        todayStr,
        scope: scopeTenantId ?? "global",
      },
      raw: {
        incoming: rawIncoming,
        outgoing: rawOutgoing,
        internal: rawInternal,
        unknown: rawUnknown,
        missed: rawMissed,
        total: rawTotal,
      },
      canonical: canon,
      delta: canon ? {
        incoming: canon.incoming - rawIncoming,
        outgoing: canon.outgoing - rawOutgoing,
        internal: canon.internal - rawInternal,
        total: canon.total - rawTotal,
        note: "canonical - raw; positive = direction-corrected rows were added to this bucket",
      } : null,
      directionMismatches: {
        count: directionMismatches.length,
        summary: mismatchSummary,
        note: directionMismatches.length === 0
          ? "No mismatches — all stored directions match canonical rules. Backfill is not needed."
          : "Rows where stored direction differs from canonical. Run POST /admin/cdr/fix-directions?dryRun=false&scope=all to apply.",
        samples: directionMismatches.slice(0, 20).map((r: MismatchRow) => ({
          linkedId: r.linkedId,
          from: r.fromNumber,
          to: r.toNumber,
          storedDir: r.direction,
          canonicalDir: r.canonical,
        })),
      },
      edgeCases: {
        ambiguousLocalCalls: {
          count: ambiguousLocalCount,
          note: "Calls from a short extension to a 7–9 digit number. Not auto-reclassified as outgoing because 7-digit numbers are ambiguous (some PBX deployments use 7-digit extension IDs). These may be local PSTN outgoing calls; review manually if needed.",
        },
        featureCodeCalls: {
          count: featureCodeCount,
          note: "Calls to 1–4 digit destinations (voicemail shortcuts, transfer codes, etc). Direction left as stored; these are typically not real calls to external parties.",
        },
      },
      nullTenantRows: nullTenantCount,
      countingModelNote: [
        "Connect stores one row per linked call (deduplicated by linkedId).",
        "The PBX CDR database stores one record per channel leg.",
        "A single logical call (e.g. inbound → IVR → queue → extension) creates 3–5 CDR records in Asterisk but only 1 row in Connect.",
        "Therefore Connect totals will be lower than PBX dashboard totals even after direction correction.",
        "This is expected and not a bug — it reflects different counting models (calls vs call-legs).",
      ].join(" "),
      backfillNote: directionMismatches.length > 0
        ? "Apply direction fixes: POST /admin/cdr/fix-directions?dryRun=false&scope=all"
        : "No backfill needed — stored directions match canonical rules.",
    });
  } catch (err: any) {
    app.log.error({ err: err?.message }, "admin_diagnostics_dashboard_reconciliation: error");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err?.message || err) });
  }
});

// ── GET /admin/diagnostics/raw-vs-deduped ─────────────────────────────────────
// Compares Connect's raw CDR leg count (SUM rawLegCount) vs unique logical calls
// (COUNT *) for the current day window.
// Provides PBX-style raw counting parity validation without touching PBX API.
// rawLegCount on each ConnectCdr row is incremented once per CdrNotifier notification —
// i.e. once per AMI Cdr event (one per Asterisk channel leg). SUM should approximate
// the PBX dashboard's raw CDR row count.
app.get("/admin/diagnostics/raw-vs-deduped", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;

  const q = z.object({
    tenantId: z.string().optional(),
    startIso: z.string().optional(),
    endIso:   z.string().optional(),
    startSec: z.coerce.number().int().optional(),
    endSec:   z.coerce.number().int().optional(),
    limit:    z.coerce.number().int().min(1).max(100).optional(),
  }).parse(req.query || {});

  const scopeTenantId = q.tenantId && q.tenantId !== "global" ? q.tenantId : null;

  let startUtc: Date;
  let endUtc: Date;
  let timezone: string;
  let windowStr: string;
  if (q.startSec && q.endSec) {
    startUtc   = new Date(q.startSec * 1000);
    endUtc     = new Date(q.endSec * 1000);
    timezone   = process.env.PBX_TIMEZONE?.trim() || "UTC";
    windowStr  = `${startUtc.toISOString()} → ${endUtc.toISOString()}`;
  } else if (q.startIso && q.endIso) {
    startUtc   = new Date(q.startIso);
    endUtc     = new Date(q.endIso);
    if (Number.isNaN(startUtc.getTime()) || Number.isNaN(endUtc.getTime())) {
      return reply.code(400).send({ error: "INVALID_ISO_RANGE" });
    }
    timezone   = process.env.PBX_TIMEZONE?.trim() || "UTC";
    windowStr  = `${startUtc.toISOString()} → ${endUtc.toISOString()}`;
  } else {
    const r    = computePbxLocalDayRangeUtc();
    startUtc   = r.dayStartUtc;
    endUtc     = r.dayEndUtc;
    timezone   = r.timezone;
    windowStr  = `${r.todayStr} (${timezone})`;
  }

  const timeWhere = { gte: startUtc, lt: endUtc };
  const baseWhere = scopeTenantId ? { tenantId: scopeTenantId, startedAt: timeWhere } : { startedAt: timeWhere };

  try {
    // Aggregate: total raw legs, unique calls, direction breakdown
    type AggRow = {
      uniqueCalls: bigint; rawLegTotal: bigint;
      rawLegIncoming: bigint; rawLegOutgoing: bigint; rawLegInternal: bigint; rawLegUnknown: bigint;
      dedupIncoming: bigint; dedupOutgoing: bigint; dedupInternal: bigint; dedupUnknown: bigint;
      nullTenantCount: bigint; multiLegCount: bigint; maxLegs: bigint;
    };
    const agg: AggRow[] = scopeTenantId
      ? await db.$queryRaw<AggRow[]>`
          SELECT
            COUNT(*) AS "uniqueCalls",
            SUM("rawLegCount") AS "rawLegTotal",
            SUM(CASE WHEN direction = 'incoming' THEN "rawLegCount" ELSE 0 END) AS "rawLegIncoming",
            SUM(CASE WHEN direction = 'outgoing' THEN "rawLegCount" ELSE 0 END) AS "rawLegOutgoing",
            SUM(CASE WHEN direction = 'internal' THEN "rawLegCount" ELSE 0 END) AS "rawLegInternal",
            SUM(CASE WHEN direction NOT IN ('incoming','outgoing','internal') THEN "rawLegCount" ELSE 0 END) AS "rawLegUnknown",
            COUNT(CASE WHEN direction = 'incoming' THEN 1 END) AS "dedupIncoming",
            COUNT(CASE WHEN direction = 'outgoing' THEN 1 END) AS "dedupOutgoing",
            COUNT(CASE WHEN direction = 'internal' THEN 1 END) AS "dedupInternal",
            COUNT(CASE WHEN direction NOT IN ('incoming','outgoing','internal') THEN 1 END) AS "dedupUnknown",
            COUNT(CASE WHEN "tenantId" IS NULL THEN 1 END) AS "nullTenantCount",
            COUNT(CASE WHEN "rawLegCount" > 1 THEN 1 END) AS "multiLegCount",
            MAX("rawLegCount") AS "maxLegs"
          FROM "ConnectCdr"
          WHERE "startedAt" >= ${startUtc} AND "startedAt" < ${endUtc} AND "tenantId" = ${scopeTenantId}
        `
      : await db.$queryRaw<AggRow[]>`
          SELECT
            COUNT(*) AS "uniqueCalls",
            SUM("rawLegCount") AS "rawLegTotal",
            SUM(CASE WHEN direction = 'incoming' THEN "rawLegCount" ELSE 0 END) AS "rawLegIncoming",
            SUM(CASE WHEN direction = 'outgoing' THEN "rawLegCount" ELSE 0 END) AS "rawLegOutgoing",
            SUM(CASE WHEN direction = 'internal' THEN "rawLegCount" ELSE 0 END) AS "rawLegInternal",
            SUM(CASE WHEN direction NOT IN ('incoming','outgoing','internal') THEN "rawLegCount" ELSE 0 END) AS "rawLegUnknown",
            COUNT(CASE WHEN direction = 'incoming' THEN 1 END) AS "dedupIncoming",
            COUNT(CASE WHEN direction = 'outgoing' THEN 1 END) AS "dedupOutgoing",
            COUNT(CASE WHEN direction = 'internal' THEN 1 END) AS "dedupInternal",
            COUNT(CASE WHEN direction NOT IN ('incoming','outgoing','internal') THEN 1 END) AS "dedupUnknown",
            COUNT(CASE WHEN "tenantId" IS NULL THEN 1 END) AS "nullTenantCount",
            COUNT(CASE WHEN "rawLegCount" > 1 THEN 1 END) AS "multiLegCount",
            MAX("rawLegCount") AS "maxLegs"
          FROM "ConnectCdr"
          WHERE "startedAt" >= ${startUtc} AND "startedAt" < ${endUtc}
        `;

    const a = agg[0];
    const uniqueCalls   = Number(a?.uniqueCalls ?? 0);
    const rawLegTotal   = Number(a?.rawLegTotal ?? 0);
    const multiLegCount = Number(a?.multiLegCount ?? 0);
    const maxLegs       = Number(a?.maxLegs ?? 0);
    const legsPerCall   = uniqueCalls > 0 ? Math.round((rawLegTotal / uniqueCalls) * 100) / 100 : null;

    // Top linkedIds with the most legs (multi-leg calls = best examples)
    const topMultiLeg = await db.connectCdr.findMany({
      where: { ...baseWhere, rawLegCount: { gt: 1 } },
      orderBy: { rawLegCount: "desc" },
      take: Number(q.limit ?? 10),
      select: {
        linkedId: true,
        rawLegCount: true,
        fromNumber: true,
        toNumber: true,
        direction: true,
        tenantId: true,
        durationSec: true,
        disposition: true,
        startedAt: true,
      },
    });

    // Distribution of rawLegCount values
    type DistRow = { legs: number; count: bigint };
    const distribution: DistRow[] = scopeTenantId
      ? await db.$queryRaw<DistRow[]>`
          SELECT "rawLegCount" AS legs, COUNT(*) AS count
          FROM "ConnectCdr"
          WHERE "startedAt" >= ${startUtc} AND "startedAt" < ${endUtc} AND "tenantId" = ${scopeTenantId}
          GROUP BY "rawLegCount" ORDER BY "rawLegCount" ASC LIMIT 20
        `
      : await db.$queryRaw<DistRow[]>`
          SELECT "rawLegCount" AS legs, COUNT(*) AS count
          FROM "ConnectCdr"
          WHERE "startedAt" >= ${startUtc} AND "startedAt" < ${endUtc}
          GROUP BY "rawLegCount" ORDER BY "rawLegCount" ASC LIMIT 20
        `;

    return reply.send({
      asOf: new Date().toISOString(),
      window: windowStr,
      scope: scopeTenantId ?? "global",
      // ── Core parity numbers ───────────────────────────────────────────────
      connectUniqueCalls: uniqueCalls,
      connectRawLegTotal: rawLegTotal,
      legsPerCall,
      multiLegCalls: multiLegCount,
      singleLegCalls: uniqueCalls - multiLegCount,
      maxLegsOnOneCall: maxLegs,
      // ── Direction breakdown ───────────────────────────────────────────────
      byDirection: {
        rawLegs: {
          incoming: Number(a?.rawLegIncoming ?? 0),
          outgoing: Number(a?.rawLegOutgoing ?? 0),
          internal: Number(a?.rawLegInternal ?? 0),
          unknown:  Number(a?.rawLegUnknown  ?? 0),
        },
        uniqueCalls: {
          incoming: Number(a?.dedupIncoming ?? 0),
          outgoing: Number(a?.dedupOutgoing ?? 0),
          internal: Number(a?.dedupInternal ?? 0),
          unknown:  Number(a?.dedupUnknown  ?? 0),
        },
      },
      nullTenantCalls: Number(a?.nullTenantCount ?? 0),
      // ── Leg count distribution ────────────────────────────────────────────
      legCountDistribution: distribution.map((r) => ({
        legs: Number(r.legs),
        calls: Number(r.count),
      })),
      // ── Examples of multi-leg calls ───────────────────────────────────────
      topMultiLegExamples: topMultiLeg.map((r) => ({
        linkedId: r.linkedId,
        rawLegs: r.rawLegCount,
        fromNumber: r.fromNumber,
        toNumber: r.toNumber,
        direction: r.direction,
        tenantId: r.tenantId,
        durationSec: r.durationSec,
        disposition: r.disposition,
        startedAt: r.startedAt.toISOString(),
      })),
      // ── Explanation ───────────────────────────────────────────────────────
      explanation: [
        `Connect stores one row per linkedId (logical call). rawLegCount on each row counts how many AMI Cdr events (channel legs) were received for that call.`,
        `connectRawLegTotal (${rawLegTotal}) is the PBX-style raw CDR count — this should approximate the PBX dashboard total.`,
        `connectUniqueCalls (${uniqueCalls}) is Connect's deduplicated logical call count.`,
        legsPerCall !== null
          ? `Average ${legsPerCall}× legs per logical call — consistent with Asterisk generating ${legsPerCall}× CDR records per call through IVR/queue/extension routing.`
          : "No calls in window.",
        `Note: rawLegCount only counts since the rawLegCount column was added (migration 20260330100000). Historical rows default to 1.`,
      ].join(" "),
    });
  } catch (err: any) {
    app.log.error({ err: err?.message }, "admin_diagnostics_raw_vs_deduped: error");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err?.message || err) });
  }
});

// GET /admin/pbx/live/active-calls — reads from shared admin aggregation cache
app.get("/admin/pbx/live/active-calls", async (req, reply) => {
  const user = await requireSuperAdmin(req, reply);
  if (!user) return;
  if (!ensureCredentialCrypto(reply)) return;

  try {
    const r = await getAdminPbxLiveCombined();
    return {
      calls: r.allActiveCalls,
      source: r.allActiveCalls.length > 0 ? "ari" : "unavailable",
      lastUpdatedAt: r.lastUpdatedAt
    };
  } catch {
    return { calls: [], source: "unavailable", lastUpdatedAt: new Date().toISOString() };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// END PBX LIVE METRICS
// ─────────────────────────────────────────────────────────────────────────────

// ── Startup telephony/WebRTC config validation ────────────────────────────────
// Runs just before listen so logs appear during startup, not at module load.
const port = Number(process.env.PORT || 3001);
(async () => {
  // Validate and log telephony env vars at startup.
  // This makes missing-config problems immediately visible in container logs.
  const missingAtStart: string[] = [];

  if (!pbxWsEndpoint) {
    missingAtStart.push("PBX_WS_ENDPOINT");
    app.log.warn(
      "PBX_WS_ENDPOINT is NOT set — browser/mobile WebRTC will not know where to connect. " +
      "Set PBX_WS_ENDPOINT=wss://209.145.60.79:8089/ws"
    );
  } else {
    // Reject insecure or stale endpoints
    if (pbxWsEndpoint.startsWith("ws://")) {
      app.log.warn({ pbxWsEndpoint }, "PBX_WS_ENDPOINT uses insecure ws:// — browsers require wss://");
    } else if (pbxWsEndpoint.includes(":8088") || pbxWsEndpoint.includes(":5060")) {
      app.log.warn({ pbxWsEndpoint }, "PBX_WS_ENDPOINT port looks stale — expected :8089/ws");
    } else {
      app.log.info({ pbxWsEndpoint }, "PBX WebSocket endpoint OK");
    }
  }

  if (!turnServerEnv) {
    app.log.warn(
      "TURN_SERVER is NOT set — audio will likely fail for users behind strict/symmetric NAT. " +
      "Install coturn on the backend server and set TURN_SERVER, TURN_USERNAME, TURN_PASSWORD."
    );
  } else {
    app.log.info(
      { turnServer: turnServerEnv, turnUsername: turnUsernameEnv ? "(set)" : "(not set)", turnPassword: turnPasswordEnv ? "(set)" : "(not set)" },
      "TURN server configured"
    );
  }

  app.log.info(
    { stunServer: stunServerEnv },
    "STUN server configured"
  );

  if (missingAtStart.length > 0) {
    app.log.warn({ missingAtStart }, "WebRTC provisioning is INCOMPLETE — see warnings above");
  } else {
    app.log.info("WebRTC telephony env config OK");
  }

  await app.listen({ host: "0.0.0.0", port });
  startPbxKpiBackgroundRefresh();
})().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
