import { randomUUID } from "crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { db, claimNotification } from "@connect/db";
import { decryptJson } from "@connect/security";
import {
  normalizeProviderError,
  SmsProvider,
  TwilioCredentials,
  TwilioSmsProvider,
  VoipMsCredentials,
  VoipMsSmsProvider,
  SolaCardknoxAdapter,
  WirePbxClient,
} from "@connect/integrations";
import {
  runDunningSweepEligibility,
  consumeSkipNextRetryFlag,
  applyDunningAfterAutopayFailure,
  readDunningSlice,
} from "../../api/src/billing/billingDunning";
import { chargeBillingInvoice } from "../../api/src/billing/solaBillingPayments";
import { billingLiveChargesDisabled } from "../../api/src/billing/solaBillingPayments";
import {
  clearInvoiceDunningMetadata,
  queueAutopayReminderEmailOnce,
  queueInvoiceSentOnFinalize,
} from "../../api/src/billing/billingEmailLifecycle";
import { sweepMissingReceiptEmails } from "../../api/src/billing/receiptReconciliation";
import { autopayPeriodInvoiceWhere } from "../../api/src/billing/autopayCycle";
import { createBillingInvoice, createBillingInvoiceRowWithUniqueNumber } from "../../api/src/billing/invoiceEngine";
import { findPaidBillingPeriodCoverage } from "../../api/src/billing/billingPeriodGuards";
import { consumeScheduledPlanChange } from "../../api/src/billing/billingScheduledPlanConsume";
import { isFcmDirectConfigured, sendFcmDirectData, buildFcmDataFromPayload } from "../../api/src/fcmDirect";
import { processConnectChatSmsJob } from "./connectChatSmsJob";
import { runVoicemailSyncCycle } from "./voicemailSyncCycle";
import { runNotificationReconcileCycle, runNotificationCanaryCycle } from "./notificationReconciler";
import { runCallQualityAggregateCycle } from "./callQualityAggregator";
import { runWakeCanaryEnrollCycle } from "./wakeCanaryEnrollCycle";
import { startVoicemailSpoolReconcileLoop } from "./voicemailSpoolReconcileCycle";
import { startPbxWebrtcDriftReconcileLoop } from "./pbxWebrtcDriftReconcileCycle";
import { runVoipMsInboundSyncCycle, runVoipMsMmsMirrorBackfill, SmsPushInput } from "./voipMsInboundSyncJob";
import { buildBillingSchedule, type BillingSchedule } from "./billingSchedule";
import {
  isConnectMohRuntimeClass,
  isNativeMohRuntimeClass,
  isValidMohRuntimeClass,
  normalizeMohRuntimeClass as normalizeSharedMohRuntimeClass,
  pickCanonicalTenantSlug,
  buildExpoPushV2Item,
  EXPO_PUSH_USER_ALERT_TYPES,
  buildGlobalDefaultKey,
  buildSourcePublishKeys,
  computeActiveScheduleOverrides,
  computeActiveAdminOverrides,
  buildAdminOverlayKeysForTenant,
  adminOverlayKeyIdsForTenant,
  adminOverlayKeyIdsForExtension,
  selectAdminFallbackTenantClass,
  buildAdminFallbackTenantClassKeys,
  computeForwardKeyClears,
  visibleMohCatalogForTenant,
  planMissingMohProfiles,
  type ScheduleRuleRow,
  type StaticSourcePolicy,
  type AdminScheduleRow,
  type ActiveAdminOverride,
  type AdminFallbackCandidate,
  type MohAstDbKey,
  decideAdminAlert,
  ADMIN_ALERT_DAILY_WINDOW_MS,
} from "@connect/shared";
import {
  isApnsVoipConfigured,
  sendApnsVoipPush,
  isApnsAlertConfigured,
  sendUserAlertApnsPushes,
  type ApnsVoipCallPayload,
} from "@connect/shared/apnsVoipPush";
import { processCrmEmailSendJob } from "./crmEmailSend";
import { processCrmEmailSyncJob } from "./crmEmailSync";
import { processCrmBulkEmailJob } from "./crmBulkEmailJob";
import { registerWhatsAppInboundWorker } from "./whatsappInboundJob";
import { registerWhatsAppStatusWorker } from "./whatsappStatusJob";

registerWhatsAppInboundWorker();
registerWhatsAppStatusWorker();

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });
const emailSyncQueue = new Queue("crm-email-sync", { connection: redis });

// ── Admin alert email mirror ─────────────────────────────────────────────────
// Every db.alert row the worker creates is also emailed to the operator inbox
// (same recipient + EmailJob queue as the API's sendAdminAlert — the API's
// email-job processor picks up rows this worker inserts). Owner decision
// 2026-07-30: ALL alerts — device registration, PBX/voice diagnostics,
// billing — go to ADMIN_ALERT_EMAIL. A per-key cooldown keeps a long outage
// from flooding the inbox (the alert row is still created every cycle; only
// the email is throttled).
const ADMIN_ALERT_EMAIL = (process.env.ADMIN_ALERT_EMAIL || "tod10950@gmail.com").trim();
const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";
const ADMIN_ALERT_EMAIL_COOLDOWN_MS = Math.max(5, Number(process.env.ADMIN_ALERT_EMAIL_COOLDOWN_MIN || 60)) * 60_000;
const adminAlertEmailLastSentAt = new Map<string, number>();
function escapeAlertHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function queueAdminAlertEmail(key: string, subject: string, lines: string[]): Promise<void> {
  try {
    if (!ADMIN_ALERT_EMAIL) return;
    const now = Date.now();
    // Fast path only — this map dies with the process, and a restart used to
    // re-arm every alert. The database read below is the authority, and it is
    // shared with the API so both processes draw on ONE mailbox budget.
    if (now - (adminAlertEmailLastSentAt.get(key) ?? 0) < ADMIN_ALERT_EMAIL_COOLDOWN_MS) return;
    adminAlertEmailLastSentAt.set(key, now);
    // Bound the cooldown map — keys are per endpoint/tenant and accumulate.
    if (adminAlertEmailLastSentAt.size > 5000) {
      for (const [k, ts] of adminAlertEmailLastSentAt) {
        if (now - ts > ADMIN_ALERT_EMAIL_COOLDOWN_MS) adminAlertEmailLastSentAt.delete(k);
      }
    }

    const fullSubject = `[Connect Alert] ${subject}`;
    const windowStart = new Date(now - ADMIN_ALERT_DAILY_WINDOW_MS);
    const [previous, sentLast24h] = await Promise.all([
      db.emailJob.findFirst({
        where: { type: "ADMIN_ALERT", subject: fullSubject, createdAt: { gte: windowStart } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      db.emailJob.count({ where: { type: "ADMIN_ALERT", createdAt: { gte: windowStart } } }),
    ]);
    const decision = decideAdminAlert({
      now,
      lastSentAtMs: previous ? previous.createdAt.getTime() : null,
      cooldownMs: ADMIN_ALERT_EMAIL_COOLDOWN_MS,
      sentLast24h,
    });
    if (!decision.send) {
      console.log(`[ADMIN_ALERT] suppressed (${decision.reason}, ${sentLast24h} in 24h) key=${key} subject=${subject}`);
      return;
    }

    const textBody = lines.join("\n");
    const htmlBody = `<div style="font-family:monospace;white-space:pre-wrap">${lines.map(escapeAlertHtml).join("<br/>")}</div>`;
    // ADMIN_ALERT_TENANT_ID is the same synthetic tenant the API's admin
    // alerts ride on; fall back to skipping (log only) if the row is missing
    // so a FK failure can never break the alert cycle itself.
    await db.emailJob.create({
      data: {
        tenantId: ADMIN_ALERT_TENANT_ID,
        type: "ADMIN_ALERT",
        toEmail: ADMIN_ALERT_EMAIL,
        subject: `[Connect Alert] ${subject}`,
        htmlBody,
        textBody,
        status: "QUEUED",
        attempts: 0,
        nextRunAt: new Date(),
      },
    });
    console.log(`[ADMIN_ALERT] email queued key=${key} subject=${subject}`);
  } catch (e: any) {
    console.error(`[ADMIN_ALERT] email queue failed key=${key}: ${String(e?.message || e).slice(0, 200)}`);
  }
}

const providerCache = new Map<string, { provider: SmsProvider; expiresAt: number }>();
const providerCacheTtlMs = 60_000;
const smsProviderTestMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
const mobilePushSimulate = (process.env.MOBILE_PUSH_SIMULATE || "false").toLowerCase() === "true";

// ── Boot assertion: is the direct-FCM call-wake channel actually armed? ──────
// ⛔ The worker's direct-FCM sender (see sendPushToUserDevices) shipped
// 2026-07-31 and did NOT send a single direct push for the six days that
// followed: the container had no FCM_SERVICE_ACCOUNT_PATH and no mount for the
// credential, so `isFcmDirectConfigured()` returned false every time and every
// call-critical push silently fell back to the Expo relay — the exact
// deprioritized channel the direct sender exists to bypass.
//
// It went unnoticed because the fallback is by design silent and per-push.
// Say it ONCE, loudly, at boot instead. This is deliberately a `console.error`
// on the unconfigured branch: it is a call-reliability regression for every
// Android device on the fleet, not a debug detail.
{
  const fcmPath =
    process.env.FCM_SERVICE_ACCOUNT_PATH ||
    "/opt/connectcomms/env/firebase-service-account.json";
  if (isFcmDirectConfigured()) {
    console.info(
      JSON.stringify({
        event: "MOBILE_PUSH_AUDIT",
        stage: "FCM_DIRECT_ARMED",
        source: "worker",
        path: fcmPath,
      }),
    );
  } else {
    console.error(
      JSON.stringify({
        event: "MOBILE_PUSH_AUDIT",
        stage: "FCM_DIRECT_UNCONFIGURED",
        source: "worker",
        path: fcmPath,
        impact:
          "ALL call-critical Android pushes (INCOMING_CALL, INCOMING_CALL_WAKE, " +
          "INVITE_CANCELED, INVITE_CLAIMED) will fall back to the Expo relay, " +
          "including for devices that reported a nativeFcmToken.",
        fix: "Mount /opt/connectcomms/env into the worker and set FCM_SERVICE_ACCOUNT_PATH (docker-compose.app.yml).",
      }),
    );
  }
}
const expoPushAccessToken = process.env.EXPO_PUSH_ACCESS_TOKEN || "";
const tokenBuckets = new Map<string, { tokens: number; lastRefillMs: number }>();
const pbxPollCursorByInstance = new Map<string, string>();
const pbxPollSeenCalls = new Map<string, number>();
const pbxPollBackoffUntil = new Map<string, number>();

type ProviderName = "TWILIO" | "VOIPMS";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerCacheKey(tenantId: string, provider: ProviderName): string {
  return `${tenantId}:${provider}`;
}

function bucketStart5m(now = new Date()): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
  return d;
}

async function getProviderClient(tenantId: string, provider: ProviderName): Promise<SmsProvider | null> {
  const key = providerCacheKey(tenantId, provider);
  const cached = providerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.provider;

  const credential = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId, provider } } });
  if (!credential || !credential.isEnabled) return null;

  try {
    if (provider === "TWILIO") {
      const decrypted = decryptJson<TwilioCredentials>(credential.credentialsEncrypted);
      if (!decrypted.accountSid || !decrypted.authToken || (!decrypted.messagingServiceSid && !decrypted.fromNumber)) return null;
      const client = new TwilioSmsProvider(decrypted, smsProviderTestMode);
      providerCache.set(key, { provider: client, expiresAt: Date.now() + providerCacheTtlMs });
      return client;
    }

    const decrypted = decryptJson<VoipMsCredentials>(credential.credentialsEncrypted);
    if (!decrypted.username || !decrypted.password || !decrypted.fromNumber) return null;
    const client = new VoipMsSmsProvider(decrypted, smsProviderTestMode);
    providerCache.set(key, { provider: client, expiresAt: Date.now() + providerCacheTtlMs });
    return client;
  } catch {
    return null;
  }
}

async function enforcePerSecondTokenBucket(tenantId: string, perSecondRateLimit: number) {
  const now = Date.now();
  const rate = Math.max(1, Math.min(20, perSecondRateLimit));
  const bucket = tokenBuckets.get(tenantId) || { tokens: rate, lastRefillMs: now };

  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(rate, bucket.tokens + elapsedSec * rate);
  bucket.lastRefillMs = now;

  if (bucket.tokens < 1) {
    const waitMs = Math.ceil(((1 - bucket.tokens) / rate) * 1000);
    tokenBuckets.set(tenantId, bucket);
    await sleep(waitMs);
    return enforcePerSecondTokenBucket(tenantId, rate);
  }

  bucket.tokens -= 1;
  tokenBuckets.set(tenantId, bucket);
}

async function countDaily(tenantId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.smsMessage.count({ where: { campaign: { tenantId }, status: { not: "FAILED" }, createdAt: { gte: start } } });
}

async function countHourly(tenantId: string): Promise<number> {
  const start = new Date(Date.now() - 60 * 60 * 1000);
  return db.smsMessage.count({ where: { campaign: { tenantId }, status: { not: "FAILED" }, createdAt: { gte: start } } });
}

async function shouldAutoSuspendForFailureRate(tenantId: string): Promise<boolean> {
  const start = new Date(Date.now() - 15 * 60 * 1000);
  const recent = await db.smsMessage.findMany({
    where: {
      campaign: { tenantId },
      OR: [{ createdAt: { gte: start } }, { lastProviderUpdateAt: { gte: start } }]
    },
    select: { status: true, providerStatus: true }
  });

  if (recent.length === 0) return false;
  let failed = 0;
  let total = 0;
  for (const msg of recent) {
    if (msg.status === "QUEUED") continue;
    total += 1;
    if (msg.status === "FAILED" || (msg.providerStatus || "").toLowerCase() === "undelivered") failed += 1;
  }
  if (total === 0) return false;
  return failed > 30 && failed / total > 0.4;
}

async function suspendTenant(tenantId: string, reason: string, actorEntityId: string) {
  await db.tenant.update({ where: { id: tenantId }, data: { smsSuspended: true, smsSuspendedReason: reason, smsSuspendedAt: new Date() } });
  await db.auditLog.create({ data: { tenantId, action: "SMS_TENANT_SUSPENDED", entityType: "Tenant", entityId: actorEntityId } });
}

async function finalizeCampaignStatus(campaignId: string) {
  const remaining = await db.smsMessage.count({ where: { campaignId, status: { in: ["QUEUED", "SENDING"] } } });
  if (remaining > 0) return;
  const failedCount = await db.smsMessage.count({ where: { campaignId, status: "FAILED" } });
  const nextStatus = failedCount > 0 ? "FAILED" : "SENT";
  await db.smsCampaign.update({ where: { id: campaignId }, data: { status: nextStatus } });
}

async function getCircuitOpenUntil(tenantId: string, provider: ProviderName): Promise<Date | null> {
  const row = await db.providerHealth.findFirst({ where: { tenantId, provider }, orderBy: { updatedAt: "desc" } });
  if (!row?.circuitOpenUntil) return null;
  if (row.circuitOpenUntil > new Date()) return row.circuitOpenUntil;

  await db.providerHealth.update({ where: { id: row.id }, data: { circuitOpenUntil: null } });
  await db.auditLog.create({ data: { tenantId, action: "SMS_PROVIDER_CIRCUIT_CLOSED", entityType: "ProviderHealth", entityId: row.id, provider } });
  return null;
}

async function recordProviderHealth(tenantId: string, provider: ProviderName, success: boolean, errorCode?: string): Promise<void> {
  const windowStart = bucketStart5m();
  const row = await db.providerHealth.upsert({
    where: { tenantId_provider_windowStart: { tenantId, provider, windowStart } },
    create: {
      tenantId,
      provider,
      windowStart,
      sentCount: success ? 1 : 0,
      failCount: success ? 0 : 1,
      lastErrorCode: success ? null : errorCode || null,
      lastErrorAt: success ? null : new Date()
    },
    update: {
      sentCount: success ? { increment: 1 } : undefined,
      failCount: success ? undefined : { increment: 1 },
      lastErrorCode: success ? undefined : errorCode || null,
      lastErrorAt: success ? undefined : new Date()
    }
  });

  const total = row.sentCount + row.failCount;
  const failRate = total > 0 ? row.failCount / total : 0;
  if (row.failCount >= 20 && failRate >= 0.4) {
    const openUntil = new Date(Date.now() + 15 * 60 * 1000);
    await db.providerHealth.update({ where: { id: row.id }, data: { circuitOpenUntil: openUntil } });
    await db.auditLog.create({ data: { tenantId, action: "SMS_PROVIDER_CIRCUIT_OPENED", entityType: "ProviderHealth", entityId: row.id, provider } });
  }
}

async function resolveSenderNumber(msg: any, tenantId: string): Promise<any | null> {
  if (msg.fromNumberId) {
    return db.phoneNumber.findFirst({ where: { id: msg.fromNumberId, tenantId, status: "ACTIVE" } });
  }
  return db.phoneNumber.findFirst({ where: { tenantId, phoneNumber: msg.fromNumber, status: "ACTIVE" } });
}

function buildRoutingAttemptOrder(tenant: any): Array<{ provider: ProviderName; route: "PRIMARY" | "SECONDARY" | "LOCKED" }> {
  if (tenant.smsProviderLock) {
    return [{ provider: tenant.smsProviderLock as ProviderName, route: "LOCKED" }];
  }
  if (tenant.smsRoutingMode === "SINGLE_PRIMARY") {
    return [{ provider: tenant.smsPrimaryProvider as ProviderName, route: "PRIMARY" }];
  }

  const out: Array<{ provider: ProviderName; route: "PRIMARY" | "SECONDARY" | "LOCKED" }> = [];
  out.push({ provider: tenant.smsPrimaryProvider as ProviderName, route: "PRIMARY" });
  if (tenant.smsSecondaryProvider && tenant.smsSecondaryProvider !== tenant.smsPrimaryProvider) {
    out.push({ provider: tenant.smsSecondaryProvider as ProviderName, route: "SECONDARY" });
  }
  return out;
}


function getSolaAdapter() {
  return new SolaCardknoxAdapter({
    baseUrl: process.env.SOLA_CARDKNOX_API_BASE_URL,
    apiKey: process.env.SOLA_CARDKNOX_API_KEY,
    apiSecret: process.env.SOLA_CARDKNOX_API_SECRET,
    webhookSecret: process.env.SOLA_CARDKNOX_WEBHOOK_SECRET,
    mode: (process.env.SOLA_CARDKNOX_MODE as "sandbox" | "prod" | undefined) || "sandbox",
    simulate: (process.env.SOLA_CARDKNOX_SIMULATE || "false").toLowerCase() === "true",
    chargePath: process.env.SOLA_CARDKNOX_CHARGE_PATH || "/subscriptions/charge"
  });
}

async function runDunningCycle(): Promise<void> {
  const now = new Date();
  const dueSubs = await db.subscription.findMany({ where: { status: "PAST_DUE", nextRetryAt: { lte: now } } });
  for (const sub of dueSubs) {
    const tenant = await db.tenant.findUnique({ where: { id: sub.tenantId } });
    if (!tenant) continue;

    const pastDueSince = sub.pastDueSince || sub.updatedAt;
    const ageMs = now.getTime() - pastDueSince.getTime();
    if (ageMs >= 7 * 24 * 60 * 60 * 1000) {
      await db.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED", nextRetryAt: null } });
      await db.tenant.update({ where: { id: sub.tenantId }, data: { smsSuspended: true, smsSuspendedReason: "BILLING_PAST_DUE", smsSuspendedAt: now } });
      await db.auditLog.create({ data: { tenantId: sub.tenantId, action: "BILLING_SUBSCRIPTION_CANCELED_FOR_NONPAYMENT", entityType: "Subscription", entityId: sub.id } });
      continue;
    }

    if (!sub.providerSubscriptionId) continue;
    const adapter = getSolaAdapter();
    try {
      const charged = await adapter.chargeSubscription(sub.providerSubscriptionId, sub.priceCents || 1000);
      if (charged.status === "SUCCEEDED") {
        const periodStart = new Date();
        const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const amount = charged.amountCents || sub.priceCents || 1000;
        await db.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", lastPaymentStatus: "SUCCEEDED", lastPaymentAt: periodStart, lastFailureReason: null, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, retryCount: 0, nextRetryAt: null, pastDueSince: null } });
        await db.usageLedger.create({ data: { tenantId: sub.tenantId, type: "SMS_SUBSCRIPTION_MONTHLY", quantity: 1, unitPriceCents: amount, totalCents: amount, referenceId: sub.id } });
        await db.receipt.create({ data: { tenantId: sub.tenantId, subscriptionId: sub.id, amountCents: amount, periodStart, periodEnd } });
        await db.tenant.update({ where: { id: sub.tenantId }, data: { smsSuspended: false, smsSuspendedReason: null, smsSuspendedAt: null } });
        await db.auditLog.create({ data: { tenantId: sub.tenantId, action: "SMS_TENANT_UNSUSPENDED", entityType: "Tenant", entityId: sub.tenantId } });
      } else {
        throw new Error("charge_failed");
      }
    } catch {
      const nextCount = (sub.retryCount || 0) + 1;
      const retryDays = nextCount === 1 ? 1 : nextCount === 2 ? 3 : 5;
      const nextRetryAt = new Date(now.getTime() + retryDays * 24 * 60 * 60 * 1000);
      await db.subscription.update({ where: { id: sub.id }, data: { retryCount: nextCount, nextRetryAt, lastFailureReason: "dunning_retry_failed" } });
    }
  }
}



function getPbxClient(input: { baseUrl: string; token: string; secret?: string | null }) {
  return new WirePbxClient({
    baseUrl: input.baseUrl,
    apiToken: input.token,
    apiSecret: input.secret || undefined,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 10000),
    simulate: (process.env.PBX_SIMULATE || "false").toLowerCase() === "true",
    activeCallsPath: process.env.PBX_ACTIVE_CALLS_PATH,
    supportsWebhooks: process.env.PBX_SUPPORTS_WEBHOOKS ? process.env.PBX_SUPPORTS_WEBHOOKS.toLowerCase() === "true" : undefined,
    supportsActiveCallPolling: process.env.PBX_SUPPORTS_ACTIVE_CALL_POLLING ? process.env.PBX_SUPPORTS_ACTIVE_CALL_POLLING.toLowerCase() === "true" : undefined
  });
}

type WorkerMobilePushPayload =
  | { type: "INCOMING_CALL"; inviteId: string; fromNumber: string; toExtension: string; tenantId: string; timestamp: string }
  | { type: "INVITE_CANCELED"; inviteId: string; pbxCallId?: string | null; reason?: string | null; tenantId: string; timestamp: string }
  | { type: "MISSED_CALL"; inviteId: string; fromNumber: string; toExtension: string; tenantId: string; timestamp: string }
  // User-visible missed-call alert — same shape the API sends from its CDR
  // ingest / invite paths, so the app handles both identically. `inviteId` is
  // extra here (harmless to the app) so this file's shared logging can keep
  // reading payload.inviteId across all payload variants.
  | { type: "missed_call"; inviteId: string; callId: string; tenantId: string; extensionId?: string | null; recipientUserId?: string; callerNumber: string; callerNameOrNumber?: string | null; timestamp: string }
  // Reconciler-sent user alerts — same shapes the API sends, so the app
  // handles fast-path and swept alerts identically.
  | { type: "voicemail"; inviteId?: string; voicemailId: string; tenantId: string; extensionId?: string | null; recipientUserId?: string; callerNameOrNumber?: string | null; timestamp: string }
  | { type: "sms_message"; inviteId?: string; conversationId: string; messageId: string; phoneNumber: string; recipientUserId?: string; tenantId: string; preview?: string | null; timestamp: string }
  // Caller-less re-register wake — same shape the API's /internal/mobile-prewake
  // sends. The app re-registers SIP without showing any incoming-call UI
  // (placeholder suppressed when caller info is absent). Sent by the device-
  // registration watchdog to recover an endpoint that sits unregistered while
  // its owner has an active device (the 2026-07-30 Luxure T5_101_1 outage sat
  // 3h13m because nothing woke the frozen app until a real call arrived).
  | { type: "INCOMING_CALL_WAKE"; inviteId?: string; pbxCallId: string; fromNumber: string; fromDisplay?: string | null; toExtension: string; tenantId: string; pbxVitalTenantId?: string | null; timestamp: string; wakeRequestedAt: string };

/**
 * iOS VoIP push fan-out for INCOMING_CALL only.
 *
 * VoIP pushes are CALL-ONLY. They wake a killed/backgrounded iPhone so the app
 * can report the call to CallKit. INVITE_CANCELED additionally rides the VoIP
 * channel as a cancel="1" stop-ringing push (see sendVoipCancelPushes) — but
 * MISSED_CALL / SMS / voicemail stay on the Expo/APNs alert path.
 *
 * This runs IN ADDITION to the existing Expo send (which is unchanged and still
 * covers Android). The JS side dedupes by callId, so a device receiving both an
 * Expo data push and a VoIP push is harmless.
 *
 * Token invalidation: on APNs 410 / BadDeviceToken / Unregistered we null the
 * device's `voipPushToken` and stamp `lastPushStatus`/`lastPushError` so we stop
 * pushing to a dead token. We do NOT deactivate the device row — the Android
 * Expo path may still be valid, and the existing project pattern only ever
 * nulls/stamps push fields rather than hard-deleting devices here.
 */
async function sendVoipPushesForIncomingCall(input: {
  tenantId: string;
  userId: string;
  devices: Array<{ id: string; platform: string; voipPushToken: string | null }>;
  payload: Extract<WorkerMobilePushPayload, { type: "INCOMING_CALL" }>;
}): Promise<void> {
  const iosDevices = input.devices.filter(
    (d) => d.platform === "IOS" && !!d.voipPushToken,
  );
  if (!iosDevices.length) return;

  if (!isApnsVoipConfigured()) {
    console.warn(
      JSON.stringify({
        event: "apns_voip_skipped_unconfigured",
        source: "worker",
        tenantId: input.tenantId,
        userId: input.userId,
        callId: input.payload.inviteId,
        iosDeviceCount: iosDevices.length,
        note: "APNs VoIP credentials not set; iOS devices will not wake for calls",
      }),
    );
    return;
  }

  const voipPayload: ApnsVoipCallPayload = {
    callId: input.payload.inviteId,
    tenantId: input.payload.tenantId,
    toExtension: input.payload.toExtension,
    callerNumber: input.payload.fromNumber,
    callerName: null,
    timestamp: input.payload.timestamp,
  };

  for (const device of iosDevices) {
    const tokenTail = (device.voipPushToken || "").slice(-6);
    console.info(
      JSON.stringify({
        event: "apns_voip_token_selected",
        source: "worker",
        tenantId: input.tenantId,
        userId: input.userId,
        callId: input.payload.inviteId,
        deviceId: device.id,
        voipPushTokenTail: tokenTail,
      }),
    );
    console.info(
      JSON.stringify({
        event: "apns_voip_send_attempt",
        source: "worker",
        callId: input.payload.inviteId,
        deviceId: device.id,
        voipPushTokenTail: tokenTail,
      }),
    );

    const result = await sendApnsVoipPush(device.voipPushToken as string, voipPayload);

    if (result.ok) {
      console.info(
        JSON.stringify({
          event: "apns_voip_send_success",
          source: "worker",
          callId: input.payload.inviteId,
          deviceId: device.id,
          apnsId: result.apnsId,
          status: result.status,
        }),
      );
      await db.mobileDevice
        .update({
          where: { id: device.id },
          data: {
            lastPushSentAt: new Date(),
            lastPushType: "VOIP_INCOMING_CALL",
            lastPushStatus: "APNS_VOIP_OK",
            lastPushError: null,
          },
        })
        .catch(() => undefined);
      continue;
    }

    console.error(
      JSON.stringify({
        event: "apns_voip_send_failure",
        source: "worker",
        callId: input.payload.inviteId,
        deviceId: device.id,
        status: result.status,
        reason: result.reason,
        error: result.error ?? null,
        tokenInvalid: result.tokenInvalid,
      }),
    );

    if (result.tokenInvalid) {
      console.warn(
        JSON.stringify({
          event: "apns_voip_token_invalidation_candidate",
          source: "worker",
          callId: input.payload.inviteId,
          deviceId: device.id,
          reason: result.reason,
          status: result.status,
          action: "null_voip_push_token",
        }),
      );
      await db.mobileDevice
        .update({
          where: { id: device.id },
          data: {
            voipPushToken: null,
            lastPushType: "VOIP_INCOMING_CALL",
            lastPushStatus: "APNS_VOIP_TOKEN_INVALID",
            lastPushError: result.reason ?? `status_${result.status ?? "unknown"}`,
          },
        })
        .catch(() => undefined);
    } else {
      await db.mobileDevice
        .update({
          where: { id: device.id },
          data: {
            lastPushType: "VOIP_INCOMING_CALL",
            lastPushStatus: "APNS_VOIP_FAILED",
            lastPushError: result.reason ?? result.error ?? `status_${result.status ?? "unknown"}`,
          },
        })
        .catch(() => undefined);
    }
  }
}

/**
 * iOS STOP-RINGING wake (2026-07-29): VoIP push with cancel="1".
 *
 * The Expo INVITE_CANCELED data push cannot wake a suspended/killed iPhone, so
 * CallKit kept ringing after the caller hung up, voicemail answered, or the
 * call was picked up elsewhere. The native AppDelegate cancel branch
 * (apps/mobile/plugins/withIosVoipPush.js) re-reports the ringing UUID (Apple's
 * every-VoIP-push-reports-a-call rule) then ends it — and skips any call that
 * is already connected, so a racing cancel never kills an answered call.
 */
async function sendVoipCancelPushes(input: {
  tenantId: string;
  userId: string;
  devices: Array<{ id: string; platform: string; voipPushToken: string | null }>;
  callId: string;
  altCallId?: string | null;
  reason: string;
}): Promise<void> {
  const iosDevices = input.devices.filter(
    (d) => d.platform === "IOS" && !!d.voipPushToken,
  );
  if (!iosDevices.length) return;
  if (!isApnsVoipConfigured()) return;

  // Caller identity on the CANCEL too (Izzy 2026-07-30): the native cancel
  // branch RE-REPORTS the ringing CallKit call before ending it (Apple's
  // every-VoIP-push-reports-a-call rule). Without caller fields that
  // re-report downgraded the on-screen caller ID to "Unknown" for the last
  // second of the ring — and left "Unknown" on the CallKit-derived records.
  // Best-effort lookup; a cancel must never fail on this.
  let callerNumber: string | null = null;
  let callerName: string | null = null;
  try {
    const invite = await db.callInvite.findFirst({
      where: { OR: [{ id: input.callId }, { pbxCallId: input.callId }] },
      orderBy: { createdAt: "desc" },
      select: { fromNumber: true, fromDisplay: true },
    });
    callerNumber = invite?.fromNumber ?? null;
    callerName = invite?.fromDisplay ?? null;
  } catch {
    /* best-effort only */
  }

  const voipPayload: ApnsVoipCallPayload = {
    callId: input.callId,
    tenantId: input.tenantId,
    callerNumber,
    callerName,
    timestamp: new Date().toISOString(),
    cancel: "1",
    reason: input.reason,
    altCallId: input.altCallId ?? null,
  };

  for (const device of iosDevices) {
    const result = await sendApnsVoipPush(device.voipPushToken as string, voipPayload);
    console.info(
      JSON.stringify({
        event: result.ok ? "apns_voip_cancel_sent" : "apns_voip_cancel_failed",
        source: "worker",
        callId: input.callId,
        altCallId: input.altCallId ?? null,
        reason: input.reason,
        deviceId: device.id,
        status: result.status,
        apnsReason: result.reason ?? null,
        error: result.error ?? null,
      }),
    );
    if (result.tokenInvalid) {
      await db.mobileDevice
        .update({
          where: { id: device.id },
          data: {
            voipPushToken: null,
            lastPushType: "VOIP_CANCEL",
            lastPushStatus: "APNS_VOIP_TOKEN_INVALID",
            lastPushError: result.reason ?? `status_${result.status ?? "unknown"}`,
          },
        })
        .catch(() => undefined);
    }
  }
}

async function sendPushToUserDevices(input: {
  tenantId: string;
  userId: string;
  payload: WorkerMobilePushPayload;
}) {
  // `active: true` — parity with the api's buildMobileDevicePushWhere. Without
  // it the worker pushed to deactivated rows too (the Luxure user reported
  // queued=6 when only 2 devices were active, 2026-07-31): wasted sends to dead
  // Expo tokens, and ghost rows that can skew "answered on another device".
  const devices = await db.mobileDevice.findMany({ where: { tenantId: input.tenantId, userId: input.userId, active: true } });
  if (!devices.length) return { queued: 0, simulated: mobilePushSimulate };

  if (mobilePushSimulate) {
    await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: "MOBILE_PUSH_SIMULATED",
        entityType: "CallInvite",
        entityId: input.payload.inviteId ?? (input.payload as any).voicemailId ?? (input.payload as any).messageId ?? input.userId,
        actorUserId: input.userId
      }
    });
    return { queued: devices.length, simulated: true };
  }

  // CRITICAL: All call-control pushes (INCOMING_CALL, INVITE_CANCELED,
  // MISSED_CALL) MUST wake the native FirebaseMessagingService on cold-killed
  // apps so we can stop the ringtone started by INCOMING_CALL. When the push
  // includes `title`/`body`/`sound`/`channelId`, Expo produces an FCM
  // "notification message" which Android's FCM SDK displays directly WITHOUT
  // invoking onMessageReceived â€” so our handleCallTerminationNative never runs
  // and the ringtone keeps playing until the 45s native watchdog fires.
  //
  // All FCM data values MUST be strings (Firebase spec). Expo silently
  // promotes the push to a notification message if values fail to serialize,
  // so we stringify every field explicitly via buildExpoPushV2Item.
  // ── Direct-FCM fast path for call-critical wakes (parity with apps/api) ────
  // Until 2026-07-31 the worker had NO direct sender at all: every Android
  // push it produced — real INCOMING_CALL rings, INVITE_CANCELED stop-ringing,
  // and every registration-watchdog INCOMING_CALL_WAKE — went over the Expo
  // relay (measured: 1,057 pushes in 24h, 100% relay), which aggressive OEMs
  // deprioritize. Android devices that reported a native FCM token now get
  // these straight from us; any failure falls back to Expo for that device, so
  // devices without a token keep the relay path bit-for-bit unchanged.
  const directServedIds = new Set<string>();
  const callCriticalTypes = new Set(["INCOMING_CALL", "INCOMING_CALL_WAKE", "INVITE_CANCELED", "INVITE_CLAIMED"]);
  if (callCriticalTypes.has(String(input.payload.type)) && isFcmDirectConfigured()) {
    const directTargets = devices.filter(
      (d: any) => d.nativeFcmToken && d.platform === "ANDROID",
    );
    if (directTargets.length > 0) {
      const fcmData = buildFcmDataFromPayload(input.payload as unknown as Record<string, unknown>);
      await Promise.all(
        directTargets.map(async (d: any) => {
          try {
            await sendFcmDirectData(String((d as any).nativeFcmToken), fcmData);
            directServedIds.add(d.id);
            console.info(
              JSON.stringify({
                event: "MOBILE_PUSH_AUDIT",
                stage: "FCM_DIRECT_DELIVERED",
                source: "worker",
                tenantId: input.tenantId,
                userId: input.userId,
                deviceId: d.id,
                notificationType: input.payload.type,
                model: (d as any).model ?? null,
              }),
            );
            void db.mobileDevice
              .update({
                where: { id: d.id },
                data: {
                  lastPushSentAt: new Date(),
                  lastPushType: String(input.payload.type),
                  lastPushStatus: "fcm_direct_ok",
                  lastPushError: null,
                } as any,
              })
              .catch(() => undefined);
          } catch (err: any) {
            console.warn(
              JSON.stringify({
                event: "MOBILE_PUSH_AUDIT",
                stage: "FCM_DIRECT_FAILED",
                source: "worker",
                tenantId: input.tenantId,
                deviceId: d.id,
                notificationType: input.payload.type,
                error: String(err?.message || err).slice(0, 200),
              }),
            );
          }
        }),
      );
    }
  }

  // ── Direct-APNs alert path for iOS user notifications ─────────────────────
  // Mirror of the api-side block (see apps/api sendPushToUserDevices): the
  // Expo relay's stored APNs push key is invalid (InvalidProviderToken 403 on
  // every iOS alert, found 2026-07-30), so iOS devices with a native APNs
  // alert token get user alerts straight from us with the working VoIP .p8.
  // Served devices drop out of the Expo fan-out; failures fall back to Expo.
  let expoDevices = devices.filter((d: any) => !directServedIds.has(d.id));
  if (EXPO_PUSH_USER_ALERT_TYPES.has(String(input.payload.type)) && isApnsAlertConfigured()) {
    const apnsTargets = devices.filter(
      (d) => (d as any).platform === "IOS" && (d as any).apnsAlertToken,
    );
    if (apnsTargets.length > 0) {
      const results = await sendUserAlertApnsPushes(
        apnsTargets.map((d) => ({
          deviceId: d.id,
          apnsAlertToken: String((d as any).apnsAlertToken),
        })),
        input.payload as unknown as Record<string, unknown>,
      ).catch((err: any): Array<{ deviceId: string; result: any }> => {
        console.warn("[MOBILE_PUSH] APNS_ALERT_BATCH_FAILED — falling back to Expo:", err?.message || err);
        return [];
      });
      const servedIds = new Set<string>();
      for (const { deviceId, result } of results) {
        console.info(
          JSON.stringify({
            event: "MOBILE_PUSH_AUDIT",
            stage: result.ok ? "APNS_ALERT_OK" : "APNS_ALERT_FAILED",
            source: "worker",
            tenantId: input.tenantId,
            userId: input.userId,
            deviceId,
            notificationType: input.payload.type,
            status: result.status,
            reason: result.reason,
            apnsId: result.apnsId,
            error: result.error ?? null,
          }),
        );
        void db.mobileDevice
          .update({
            where: { id: deviceId },
            data: {
              lastPushSentAt: new Date(),
              lastPushType: String(input.payload.type),
              lastPushStatus: result.ok ? "APNS_ALERT_OK" : "APNS_ALERT_FAILED",
              lastPushError: result.ok
                ? null
                : (result.reason ?? result.error ?? `status_${result.status ?? "unknown"}`),
              ...(result.tokenInvalid ? { apnsAlertToken: null } : {}),
            } as any,
          })
          .catch(() => undefined);
        if (result.ok) servedIds.add(deviceId);
      }
      // Filter from expoDevices (NOT devices) so the direct-FCM exclusions above
      // survive — rebuilding from `devices` here would silently re-add every
      // Android device already served over direct FCM.
      expoDevices = expoDevices.filter((d: any) => !servedIds.has(d.id));
    }
  }

  const messages = expoDevices.map((d) =>
    buildExpoPushV2Item({
      to: String(d.expoPushToken),
      payload: { ...(input.payload as unknown as Record<string, unknown>) },
      // iOS needs the visible title/body/sound envelope for user alerts —
      // data-only pushes render NOTHING on iPhones (2026-07-30).
      platform: (d as any).platform ?? null,
    }),
  );

  console.info(
    JSON.stringify({
      event: "MOBILE_PUSH_AUDIT",
      stage: "expo_messages_built",
      source: "worker",
      tenantId: input.tenantId,
      userId: input.userId,
      notificationType: input.payload.type,
      deviceCount: messages.length,
    }),
  );

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (expoPushAccessToken) headers.authorization = `Bearer ${expoPushAccessToken}`;

  console.info(
    "[CALL_TIMELINE]",
    JSON.stringify({
      callTimeline: true,
      stage: "PUSH_SEND",
      ts: new Date().toISOString(),
      source: "worker",
      tenantId: input.tenantId,
      userId: input.userId,
      inviteId: input.payload.inviteId,
      payloadType: input.payload.type,
      deviceCount: messages.length,
      toExtension: input.payload.type === "INCOMING_CALL" ? input.payload.toExtension : null
    })
  );

  // messages can be empty when every device was served by the direct-APNs
  // alert path above — Expo rejects an empty array, so skip the call.
  if (messages.length > 0) {
    try {
      const expoRes = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers,
        body: JSON.stringify(messages)
      });
      const expoBody = await expoRes.json().catch(() => null);
      console.info(
        "[CALL_TIMELINE]",
        JSON.stringify({
          callTimeline: true,
          stage: "PUSH_EXPO_RESPONSE",
          ts: new Date().toISOString(),
          source: "worker",
          inviteId: input.payload.inviteId,
          payloadType: input.payload.type,
          expoStatus: expoRes.status,
          expoBody,
          requestSample: messages[0]
        })
      );
    } catch (err: any) {
      console.error("[CALL_TIMELINE] push send failed", err?.message || err);
    }
  }

  await db.auditLog.create({
    data: {
      tenantId: input.tenantId,
      action: "MOBILE_PUSH_SENT",
      entityType: "CallInvite",
      entityId: input.payload.inviteId ?? (input.payload as any).voicemailId ?? (input.payload as any).messageId ?? input.userId,
      actorUserId: input.userId
    }
  });

  // iOS STOP-RINGING wake (2026-07-29): INVITE_CANCELED also rides the VoIP
  // channel with cancel="1" so a suspended iPhone stops CallKit ringing the
  // moment the caller hangs up / voicemail answers. Android untouched.
  if (input.payload.type === "INVITE_CANCELED") {
    const p = input.payload;
    const rawReason = String(p.reason || "").toLowerCase();
    const cancelReason =
      rawReason.includes("expire") || rawReason.includes("noanswer") || rawReason.includes("timeout")
        ? "missed_ring_timeout"
        : "remote_hangup:" + (rawReason || "canceled");
    await sendVoipCancelPushes({
      tenantId: input.tenantId,
      userId: input.userId,
      devices,
      callId: p.inviteId,
      altCallId: p.pbxCallId ?? null,
      reason: cancelReason,
    }).catch((err) =>
      console.error(
        JSON.stringify({
          event: "apns_voip_cancel_fanout_error",
          source: "worker",
          callId: p.inviteId,
          message: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  }

  // iOS VoIP wake — CALL-ONLY, in addition to (not replacing) the Expo send
  // above. Only INCOMING_CALL wakes the device for CallKit; missed stays
  // on the Expo/alert path. See sendVoipPushesForIncomingCall.
  if (input.payload.type === "INCOMING_CALL") {
    await sendVoipPushesForIncomingCall({
      tenantId: input.tenantId,
      userId: input.userId,
      devices,
      payload: input.payload,
    }).catch((err) =>
      console.error(
        JSON.stringify({
          event: "apns_voip_fanout_error",
          source: "worker",
          callId: input.payload.inviteId,
          message: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  }

  // Count direct-FCM deliveries too. Callers treat queued>0 as "a device was
  // reached" (the watchdog and /internal/mobile-prewake both do) — counting only
  // Expo messages reports 0 when every device was served directly, which is
  // exactly the false negative seen on the api side on 2026-07-31.
  return { queued: messages.length + directServedIds.size, simulated: false };
}

function normalizePbxCallState(v: string): "RINGING" | "ANSWERED" | "HANGUP" | "CANCELED" | "UNKNOWN" {
  const x = String(v || "").toLowerCase();
  if (x.includes("ring")) return "RINGING";
  if (x.includes("answer")) return "ANSWERED";
  if (x.includes("cancel") || x.includes("abandon")) return "CANCELED";
  if (x.includes("hang") || x.includes("end") || x.includes("term")) return "HANGUP";
  return "UNKNOWN";
}

async function createMissedCallRecordForInvite(invite: any, disposition: "MISSED" | "CANCELED") {
  if (!invite?.pbxCallId) return;

  // Read the prior record BEFORE upserting — it is the cross-process dedupe
  // marker for the user-visible missed-call alert below (the API has a twin of
  // this function; whichever writer records the unanswered outcome first
  // sends the one alert).
  const prior = await db.callRecord
    .findUnique({
      where: { tenantId_pbxCallId: { tenantId: invite.tenantId, pbxCallId: invite.pbxCallId } },
      select: { disposition: true },
    })
    .catch(() => null);

  // Legacy table write (kept for backward-compat with any existing queries on callRecord).
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
      disposition,
    },
    update: { disposition },
  }).catch((e: any) => {
    console.warn("[worker] callRecord upsert failed for missed invite", invite.pbxCallId, e?.message);
  });

  // Authoritative table write: ensure missed/canceled calls also appear in connectCdr
  // so they are counted by the dashboard KPI endpoint (which only reads connectCdr).
  // Uses pbxCallId as the linkedId â€” matches what the telephony service would use if
  // the AMI CDR event fires, so this is an idempotent upsert (no duplicate if both paths run).
  const now = new Date();
  const startedAt = invite.createdAt ? new Date(invite.createdAt) : now;
  // If CDR ingest already classified this call as answered (someone picked up
  // on any endpoint), it is NOT a missed call: don't downgrade the disposition
  // and don't alert.
  const priorCdr = await db.connectCdr
    .findUnique({ where: { linkedId: String(invite.pbxCallId) }, select: { disposition: true } })
    .catch(() => null);
  const answeredElsewhere = priorCdr?.disposition === "answered";
  await db.connectCdr.upsert({
    where: { linkedId: String(invite.pbxCallId) },
    create: {
      linkedId:    String(invite.pbxCallId),
      tenantId:    invite.tenantId ?? null,
      fromNumber:  invite.fromNumber ?? null,
      fromName:    invite.callerName ?? null,
      toNumber:    invite.toExtension ?? null,
      direction:   "incoming",
      disposition: disposition === "MISSED" ? "missed" : "canceled",
      startedAt,
      answeredAt:  null,
      endedAt:     now,
      durationSec: 0,
      talkSec:     0,
      rawLegCount: 1,
    },
    update: {
      // Only update disposition if it gets more specific (missed > canceled),
      // and never downgrade an answered call.
      disposition: disposition === "MISSED" && !answeredElsewhere ? "missed" : undefined,
    },
  }).catch((e: any) => {
    console.warn("[worker] connectCdr upsert failed for missed invite", invite.pbxCallId, e?.message);
  });

  // User-visible missed-call alert (see the dedupe note at the top of this
  // function). Historically NO path delivered this for invite-driven calls:
  // the CDR-ingest push in the API requires being the first ConnectCdr writer,
  // and this function's upsert always beat it there.
  const alreadyRecorded = prior?.disposition === "MISSED" || prior?.disposition === "CANCELED";
  const claimed =
    !alreadyRecorded && !answeredElsewhere && invite.userId
      ? await claimNotification(db as any, {
          type: "missed_call",
          entityId: String(invite.pbxCallId),
          userId: invite.userId,
          tenantId: invite.tenantId ?? null,
          source: "fastpath:invite-cancel-worker",
        })
      : false;
  if (claimed) {
    await sendPushToUserDevices({
      tenantId: invite.tenantId,
      userId: invite.userId,
      payload: {
        type: "missed_call",
        inviteId: String(invite.id ?? invite.pbxCallId),
        callId: String(invite.pbxCallId),
        tenantId: invite.tenantId,
        recipientUserId: invite.userId,
        callerNumber: invite.fromNumber || "Unknown caller",
        callerNameOrNumber: invite.callerName || invite.fromNumber || "Unknown caller",
        timestamp: new Date().toISOString(),
      },
    }).catch((e: any) => {
      console.warn("[worker] missed-call push failed", invite.pbxCallId, e?.message);
    });
  }
}

async function processPolledCall(link: any, call: { callId: string; state: string; from: string; toExtension: string; tenantHint?: string; startedAt: string }) {
  const state = normalizePbxCallState(call.state);
  if (call.tenantHint && link.pbxTenantId && String(call.tenantHint) !== String(link.pbxTenantId)) return;

  const ext = await db.extension.findFirst({
    where: { tenantId: link.tenantId, extNumber: String(call.toExtension), status: "ACTIVE", ownerUserId: { not: null } }
  });
  if (!ext?.ownerUserId) return;

  const dedupKey = `${link.tenantId}:${call.callId}`;
  const nowMs = Date.now();
  for (const [k, ts] of pbxPollSeenCalls) {
    if (nowMs - ts > 10 * 60 * 1000) pbxPollSeenCalls.delete(k);
  }

  if (state === "RINGING") {
    if (pbxPollSeenCalls.has(dedupKey)) return;
    pbxPollSeenCalls.set(dedupKey, nowMs);

    const existing = await db.callInvite.findFirst({ where: { tenantId: link.tenantId, pbxCallId: call.callId }, orderBy: { createdAt: "desc" } });
    if (existing && existing.status === "PENDING" && existing.expiresAt > new Date()) return;

    const invite = existing
      ? await db.callInvite.update({
          where: { id: existing.id },
          data: {
            userId: ext.ownerUserId,
            extensionId: ext.id,
            fromNumber: call.from || "unknown",
            toExtension: String(call.toExtension),
            status: "PENDING",
            expiresAt: new Date(Date.now() + 45_000),
            acceptedAt: null,
            declinedAt: null,
            canceledAt: null
          }
        })
      : await db.callInvite.create({
          data: {
            tenantId: link.tenantId,
            userId: ext.ownerUserId,
            extensionId: ext.id,
            pbxCallId: call.callId,
            fromNumber: call.from || "unknown",
            toExtension: String(call.toExtension),
            status: "PENDING",
            expiresAt: new Date(Date.now() + 45_000)
          }
        });

    await sendPushToUserDevices({
      tenantId: link.tenantId,
      userId: ext.ownerUserId,
      payload: {
        type: "INCOMING_CALL",
        inviteId: invite.id,
        fromNumber: invite.fromNumber,
        toExtension: invite.toExtension,
        tenantId: link.tenantId,
        timestamp: new Date().toISOString()
      }
    });

    await db.auditLog.create({ data: { tenantId: link.tenantId, action: "PBX_CALL_INVITE_POLL", entityType: "CallInvite", entityId: invite.id, actorUserId: ext.ownerUserId } });
    return;
  }

  if (state === "ANSWERED" || state === "HANGUP" || state === "CANCELED") {
    const invite = await db.callInvite.findFirst({ where: { tenantId: link.tenantId, pbxCallId: call.callId }, orderBy: { createdAt: "desc" } });
    if (!invite || invite.status !== "PENDING") return;
    if (state === "ANSWERED") {
      await db.callInvite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", acceptedAt: invite.acceptedAt || new Date() } });
      await db.auditLog.create({ data: { tenantId: link.tenantId, action: "CALL_INVITE_ACCEPTED_BY_PBX", entityType: "CallInvite", entityId: invite.id } });
      // iOS STOP-RINGING (2026-07-29): answered somewhere the claim path can't
      // see (e.g. desk phone on the same extension) — stop suspended iPhones.
      // The native handler skips connected calls, so the answering device is safe.
      try {
        const devices = await db.mobileDevice.findMany({ where: { tenantId: invite.tenantId, userId: invite.userId } });
        await sendVoipCancelPushes({
          tenantId: invite.tenantId,
          userId: invite.userId,
          devices,
          callId: invite.id,
          altCallId: invite.pbxCallId ?? null,
          reason: "answered_elsewhere",
        });
      } catch {
        /* never break the reconcile loop on push failure */
      }
      return;
    }
    const now = new Date();
    const nextStatus = invite.expiresAt < now ? "EXPIRED" : "CANCELED";
    await db.callInvite.update({ where: { id: invite.id }, data: { status: nextStatus, canceledAt: now } });
    await db.auditLog.create({ data: { tenantId: link.tenantId, action: "CALL_INVITE_CANCELED_BY_PBX", entityType: "CallInvite", entityId: invite.id } });
    if (nextStatus === "EXPIRED") {
      await createMissedCallRecordForInvite(invite, "MISSED").catch(() => undefined);
      await sendPushToUserDevices({
        tenantId: invite.tenantId,
        userId: invite.userId,
        payload: {
          type: "INVITE_CANCELED",
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId,
          reason: "EXPIRED",
          tenantId: invite.tenantId,
          timestamp: new Date().toISOString(),
        },
      }).catch(() => undefined);
    } else {
      await createMissedCallRecordForInvite(invite, "CANCELED").catch(() => undefined);
      await sendPushToUserDevices({
        tenantId: invite.tenantId,
        userId: invite.userId,
        payload: {
          type: "INVITE_CANCELED",
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId,
          reason: state,
          tenantId: invite.tenantId,
          timestamp: new Date().toISOString()
        }
      }).catch(() => undefined);
    }
  }
}

async function runPbxActiveCallPollCycle(): Promise<void> {
  const links: any[] = await db.tenantPbxLink.findMany({
    where: { status: "LINKED" },
    include: { pbxInstance: { include: { webhookRegistration: true } } }
  } as any);

  for (const link of links) {
    try {
      if (!link?.pbxInstance?.isEnabled) continue;
      const reg = link.pbxInstance.webhookRegistration;
      if (reg && reg.status === "REGISTERED") continue;

      const now = Date.now();
      const blockedUntil = pbxPollBackoffUntil.get(link.pbxInstanceId) || 0;
      if (blockedUntil > now) continue;

      const auth = decryptJson<{ token: string; secret?: string | null }>(link.pbxInstance.apiAuthEncrypted);
      const pbx = getPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret || null });
      const caps = pbx.capabilities();
      if (!caps.supportsActiveCallPolling) continue;

      const cursor = pbxPollCursorByInstance.get(link.pbxInstanceId);
      const calls = await pbx.pollActiveCalls(cursor);
      for (const call of calls) {
        await processPolledCall(link, call);
      }
      if (calls.length > 0) {
        pbxPollCursorByInstance.set(link.pbxInstanceId, calls[calls.length - 1].callId);
      }
    } catch (e: any) {
      const curr = pbxPollBackoffUntil.get(link.pbxInstanceId) || Date.now();
      const next = Math.min(Date.now() + 60_000, curr + 10_000);
      pbxPollBackoffUntil.set(link.pbxInstanceId, next);
      await db.auditLog.create({ data: { tenantId: link.tenantId, action: "PBX_ACTIVE_CALL_POLL_FAILED", entityType: "PbxInstance", entityId: link.pbxInstanceId } });
    }
  }
}

async function runPbxJobCycle(): Promise<void> {
  const jobs = await db.pbxJob.findMany({ where: { status: { in: ["QUEUED", "FAILED"] }, nextRunAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: 20 });
  for (const job of jobs) {
    try {
      await db.pbxJob.update({ where: { id: job.id }, data: { status: "RUNNING", attempts: { increment: 1 } } });

      const tenantLink: any = await db.tenantPbxLink.findUnique({ where: { tenantId: job.tenantId }, include: { pbxInstance: true } as any });
      if (!tenantLink || tenantLink.status !== "LINKED" || !tenantLink.pbxInstance.isEnabled) {
        throw new Error("PBX_NOT_LINKED");
      }

      const auth = decryptJson<{ token: string; secret?: string | null }>(tenantLink.pbxInstance.apiAuthEncrypted);
      const pbx = getPbxClient({ baseUrl: tenantLink.pbxInstance.baseUrl, token: auth.token, secret: auth.secret || null });

      if (job.type === "CREATE_EXTENSION") {
        const payload = job.payload as any;
        const created = await pbx.createExtension({ pbxTenantId: tenantLink.pbxTenantId || undefined, extensionNumber: String(payload.extensionNumber), displayName: String(payload.displayName) });
        const dev = await pbx.createSipDevice({ pbxExtensionId: created.pbxExtensionId, enableWebrtc: !!payload.enableWebrtc, enableMobile: !!payload.enableMobile });
        await db.pbxExtensionLink.upsert({
          where: { tenantId_extensionId: { tenantId: job.tenantId, extensionId: String(payload.extensionId) } },
          create: {
            tenantId: job.tenantId,
            extensionId: String(payload.extensionId),
            pbxExtensionId: created.pbxExtensionId,
            pbxSipUsername: dev.sipUsername || created.sipUsername,
            pbxDeviceId: dev.pbxDeviceId || null,
            isSuspended: false
          },
          update: {
            pbxExtensionId: created.pbxExtensionId,
            pbxSipUsername: dev.sipUsername || created.sipUsername,
            pbxDeviceId: dev.pbxDeviceId || null,
            isSuspended: false
          }
        });
      }

      if (job.type === "SUSPEND_EXTENSION") {
        const payload = job.payload as any;
        await pbx.suspendExtension(String(payload.pbxExtensionId), true);
        if (payload.pbxExtensionLinkId) await db.pbxExtensionLink.update({ where: { id: String(payload.pbxExtensionLinkId) }, data: { isSuspended: true } });
      }

      if (job.type === "UNSUSPEND_EXTENSION") {
        const payload = job.payload as any;
        await pbx.suspendExtension(String(payload.pbxExtensionId), false);
        if (payload.pbxExtensionLinkId) await db.pbxExtensionLink.update({ where: { id: String(payload.pbxExtensionLinkId) }, data: { isSuspended: false } });
      }

      if (job.type === "ASSIGN_DID") {
        const payload = job.payload as any;
        const number = await db.phoneNumber.findFirst({ where: { id: String(payload.phoneNumberId), tenantId: job.tenantId } });
        if (!number) throw new Error("NUMBER_NOT_FOUND");
        const did = await pbx.createDidRoute({ pbxTenantId: tenantLink.pbxTenantId || undefined, did: number.phoneNumber, routeType: String(payload.routeType), routeTarget: String(payload.routeTarget) });
        await db.pbxDidLink.upsert({
          where: { tenantId_phoneNumberId: { tenantId: job.tenantId, phoneNumberId: number.id } },
          create: { tenantId: job.tenantId, phoneNumberId: number.id, pbxDidId: did.pbxDidId, routeType: String(payload.routeType) as any, routeTarget: String(payload.routeTarget) },
          update: { pbxDidId: did.pbxDidId, routeType: String(payload.routeType) as any, routeTarget: String(payload.routeTarget) }
        });
      }

      await db.pbxJob.update({ where: { id: job.id }, data: { status: "COMPLETED", lastError: null } });
      await db.tenantPbxLink.update({ where: { id: tenantLink.id }, data: { status: "LINKED", lastError: null, lastSyncAt: new Date() } });
      await db.auditLog.create({ data: { tenantId: job.tenantId, action: "PBX_JOB_COMPLETED", entityType: "PbxJob", entityId: job.id } });
    } catch (e: any) {
      const attempts = (job.attempts || 0) + 1;
      const backoffMinutes = Math.min(60, 2 ** Math.min(6, attempts));
      await db.pbxJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: String(e?.message || "PBX_JOB_FAILED"), nextRunAt: new Date(Date.now() + backoffMinutes * 60 * 1000) } });
      await db.auditLog.create({ data: { tenantId: job.tenantId, action: "PBX_JOB_FAILED", entityType: "PbxJob", entityId: job.id } });
    }
  }
}



async function runCallInviteExpiryCycle(): Promise<void> {
  const now = new Date();
  const pendingExpired = await db.callInvite.findMany({
    where: { status: "PENDING", expiresAt: { lt: now } },
    take: 200
  });

  let marked = 0;
  for (const invite of pendingExpired) {
    const out = await db.callInvite.updateMany({ where: { id: invite.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    if (!out.count) continue;
    marked += out.count;

    await createMissedCallRecordForInvite(invite, "MISSED").catch(() => undefined);
    await sendPushToUserDevices({
      tenantId: invite.tenantId,
      userId: invite.userId,
      payload: {
        type: "MISSED_CALL",
        inviteId: invite.id,
        fromNumber: invite.fromNumber,
        toExtension: invite.toExtension,
        tenantId: invite.tenantId,
        timestamp: new Date().toISOString()
      }
    }).catch(() => undefined);
  }

  if (marked > 0) {
    console.log(`call invite expiry cycle marked ${marked} invites as EXPIRED`);
  }
}


async function runVoiceDiagAlertCycle(): Promise<void> {
  const since5m = new Date(Date.now() - 5 * 60 * 1000);
  const since1h = new Date(Date.now() - 60 * 60 * 1000);

  const [answers, connects, wsDisconnects, recentSessions] = await Promise.all([
    db.voiceDiagEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since5m }, type: "ANSWER_TAPPED" }, _count: { _all: true } }),
    db.voiceDiagEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since5m }, type: "CALL_CONNECTED" }, _count: { _all: true } }),
    db.voiceDiagEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since5m }, type: "WS_DISCONNECTED" }, _count: { _all: true } }),
    db.voiceClientSession.findMany({ where: { startedAt: { gte: since1h } }, select: { tenantId: true, iceHasTurn: true } })
  ]);

  const mapCount = (rows: any[]) => {
    const m = new Map<string, number>();
    for (const row of rows) m.set(String(row.tenantId), Number(row?._count?._all || 0));
    return m;
  };

  const answersByTenant = mapCount(answers as any[]);
  const connectsByTenant = mapCount(connects as any[]);
  const wsByTenant = mapCount(wsDisconnects as any[]);

  const sessionStats = new Map<string, { total: number; noTurn: number }>();
  for (const s of recentSessions) {
    const curr = sessionStats.get(s.tenantId) || { total: 0, noTurn: 0 };
    curr.total += 1;
    if (!s.iceHasTurn) curr.noTurn += 1;
    sessionStats.set(s.tenantId, curr);
  }

  const tenantIds = new Set<string>([
    ...Array.from(answersByTenant.keys()),
    ...Array.from(connectsByTenant.keys()),
    ...Array.from(wsByTenant.keys()),
    ...Array.from(sessionStats.keys())
  ]);

  for (const tenantId of tenantIds) {
    const answersCount = answersByTenant.get(tenantId) || 0;
    const connectsCount = connectsByTenant.get(tenantId) || 0;
    const wsDiscCount = wsByTenant.get(tenantId) || 0;
    const sess = sessionStats.get(tenantId) || { total: 0, noTurn: 0 };
    const connectRatio = answersCount > 0 ? connectsCount / answersCount : 1;
    const noTurnRatio = sess.total > 0 ? sess.noTurn / sess.total : 0;

    const alerts: Array<{ severity: string; message: string; metadata: any }> = [];

    if (answersCount >= 5 && connectRatio < 0.6) {
      alerts.push({
        severity: "HIGH",
        message: "Low answer-to-connect ratio in last 5m",
        metadata: { answersCount, connectsCount, connectRatio: Number(connectRatio.toFixed(3)) }
      });
    }

    if (wsDiscCount >= 20) {
      alerts.push({
        severity: "HIGH",
        message: "WebSocket disconnect spike detected in last 5m",
        metadata: { wsDisconnects: wsDiscCount }
      });
    }

    if (sess.total >= 5 && noTurnRatio > 0.7 && connectRatio < 0.8) {
      alerts.push({
        severity: "MEDIUM",
        message: "High no-TURN usage correlated with call reliability drop",
        metadata: { sessionCount: sess.total, noTurnCount: sess.noTurn, noTurnRatio: Number(noTurnRatio.toFixed(3)), connectRatio: Number(connectRatio.toFixed(3)) }
      });
    }

    for (const alert of alerts) {
      const exists = await db.alert.findFirst({
        where: {
          tenantId,
          category: "VOICE_DIAG",
          message: alert.message,
          createdAt: { gte: since5m }
        }
      });
      if (exists) continue;
      await db.alert.create({
        data: {
          tenantId,
          severity: alert.severity,
          category: "VOICE_DIAG",
          message: alert.message,
          metadata: alert.metadata as any
        }
      });
      await db.auditLog.create({
        data: {
          tenantId,
          action: "VOICE_DIAG_ALERT",
          entityType: "Alert",
          entityId: tenantId
        }
      }).catch(() => undefined);
      await queueAdminAlertEmail(
        `voice-diag:${tenantId}:${alert.message}`,
        `Voice diagnostics: ${alert.message}`,
        [
          `Tenant: ${tenantId}`,
          `Severity: ${alert.severity}`,
          `Alert: ${alert.message}`,
          `Detail: ${JSON.stringify(alert.metadata)}`,
        ],
      );
    }
  }
}

// ── Device registration watchdog ───────────────────────────────────────────────
// Raises an alert when a WebRTC/mobile pjsip endpoint (e.g. T25_101_1) has been
// UNREGISTERED / UNREACHABLE at the PBX for longer than the threshold *while*
// the owning user still has an active mobile device that was seen recently.
// This is the automatic detection for the T25/ext101/S25 background-registration
// class of incident — see docs/ai-context/INCIDENT_T25_101_MOBILE_REG_DROP.md.
const DEVICE_REG_NOT_REGISTERED_ALERT_SEC = Number(
  process.env.DEVICE_REG_ALERT_THRESHOLD_SEC || 300,
);
const DEVICE_REG_RECENT_DEVICE_MS = 24 * 60 * 60 * 1000;
const DEVICE_REG_REALERT_MS = 30 * 60 * 1000;
// Watchdog-initiated re-register wake pushes: at most one per endpoint per
// cooldown while it stays down (the cycle runs every 60s).
const DEVICE_REG_WAKE_COOLDOWN_MS = Math.max(60, Number(process.env.DEVICE_REG_WAKE_COOLDOWN_SEC || 300)) * 1000;
const deviceRegWakeLastSentAt = new Map<string, number>();

async function runDeviceRegistrationAlertCycle(): Promise<void> {
  const thresholdMs = DEVICE_REG_NOT_REGISTERED_ALERT_SEC * 1000;
  const staleBefore = new Date(Date.now() - thresholdMs);
  const recentDeviceSince = new Date(Date.now() - DEVICE_REG_RECENT_DEVICE_MS);
  const reAlertSince = new Date(Date.now() - DEVICE_REG_REALERT_MS);

  let downEndpoints: any[] = [];
  try {
    downEndpoints = await (db as any).pbxEndpointRegistration.findMany({
      where: {
        isWebrtcDevice: true,
        status: { in: ["UNREGISTERED", "UNREACHABLE"] },
        lastEventAt: { lte: staleBefore },
        extensionId: { not: null },
        tenantId: { not: null },
      },
      take: 500,
    });
  } catch (err: any) {
    console.error("device registration alert: query failed", err?.message || err);
    return;
  }
  if (!downEndpoints.length) return;

  for (const reg of downEndpoints) {
    // Only alert when the user actually has an in-use device that *should* be
    // registered — avoids noise from extensions whose owner uninstalled the app.
    const activeDevices = await (db.mobileDevice as any).findMany({
      where: {
        extensionId: reg.extensionId,
        active: true,
        lastSeenAt: { gte: recentDeviceSince },
      },
      select: { id: true, userId: true, platform: true, model: true, osVersion: true, lastSeenAt: true, featureFlags: true },
    });
    if (!activeDevices.length) continue;

    // ── Active recovery: wake the device so it re-registers ──────────────────
    // Detection alone let the 2026-07-30 Luxure outage sit for 3h13m — the
    // alert fired every minute while nothing re-registered the frozen app
    // until a real call's wake push arrived (7s too late for that call). The
    // same caller-less INCOMING_CALL_WAKE push the IVR prewake uses cold-boots
    // the app from a dead process and triggers a SIP re-register, so send it
    // from the watchdog too, rate-limited per endpoint.
    const nowMs = Date.now();
    if (nowMs - (deviceRegWakeLastSentAt.get(reg.endpoint) ?? 0) >= DEVICE_REG_WAKE_COOLDOWN_MS) {
      deviceRegWakeLastSentAt.set(reg.endpoint, nowMs);
      const wakeUserIds: string[] = Array.from(
        new Set<string>(
          activeDevices
            .map((d: any) => d.userId)
            .filter((u: any): u is string => typeof u === "string" && u.length > 0),
        ),
      );
      const wakeRequestedAt = new Date().toISOString();
      const pbxCallId = `watchdog-${reg.endpoint}-${nowMs}`;
      for (const userId of wakeUserIds) {
        try {
          const res = await sendPushToUserDevices({
            tenantId: reg.tenantId,
            userId,
            payload: {
              type: "INCOMING_CALL_WAKE",
              pbxCallId,
              fromNumber: "",
              fromDisplay: null,
              toExtension: reg.extNumber ?? "",
              tenantId: reg.tenantId,
              pbxVitalTenantId: reg.pbxTenantNumber ?? null,
              timestamp: wakeRequestedAt,
              wakeRequestedAt,
            },
          });
          await db.callWakeEvent.create({
            data: {
              tenantId: reg.tenantId,
              pbxCallId,
              userId,
              extensionId: reg.extensionId,
              stage: "WATCHDOG_REREGISTER_PUSH_QUEUED",
              source: "worker",
              details: { endpoint: reg.endpoint, status: reg.status, queued: res?.queued ?? 0 } as any,
            },
          }).catch(() => undefined);
          console.log(
            `[DEVICE_REG_WATCHDOG] re-register wake push queued endpoint=${reg.endpoint} user=${userId} queued=${res?.queued ?? 0}`,
          );
        } catch (err: any) {
          console.error(
            `[DEVICE_REG_WATCHDOG] wake push failed endpoint=${reg.endpoint}: ${String(err?.message || err).slice(0, 200)}`,
          );
        }
      }
    }

    // ── Durable keep-alive requirement (survives reinstall/re-enrollment) ────
    // The on-device adaptive-gate latch lives in AsyncStorage and dies with a
    // reinstall; this server-side flag re-latches the gate on every register
    // (applyServerFeatureFlags → forceKeepAliveNeeded). Merge, never clobber.
    for (const dev of activeDevices) {
      if (dev.platform !== "ANDROID") continue;
      const flags = (dev.featureFlags && typeof dev.featureFlags === "object" ? dev.featureFlags : {}) as Record<string, unknown>;
      if (flags.keepAliveRequired === true) continue;
      await (db.mobileDevice as any).update({
        where: { id: dev.id },
        data: {
          featureFlags: {
            ...flags,
            keepAliveRequired: true,
            keepAliveRequiredReason: "device_registration_watchdog",
            keepAliveRequiredAtMs: nowMs,
          } as any,
        },
      }).catch(() => undefined);
    }

    const notRegisteredForSec = Math.max(
      0,
      Math.round((Date.now() - new Date(reg.lastEventAt).getTime()) / 1000),
    );
    // Message must be STABLE for the re-alert dedupe below to work: the old
    // message embedded the growing seconds counter, so the findFirst never
    // matched and a single outage created one alert row EVERY MINUTE
    // (observed live 2026-07-30, Luxure T5_101_1 down 3h13m → ~190 rows).
    // Duration lives in metadata instead.
    const message = `Mobile device Not Registered at PBX: ${reg.endpoint} (${reg.status})`;

    const exists = await db.alert.findFirst({
      where: {
        tenantId: reg.tenantId,
        category: "DEVICE_REGISTRATION",
        message: { startsWith: `Mobile device Not Registered at PBX: ${reg.endpoint}` },
        createdAt: { gte: reAlertSince },
      },
    });
    if (exists) continue;

    await db.alert.create({
      data: {
        tenantId: reg.tenantId,
        severity: "HIGH",
        category: "DEVICE_REGISTRATION",
        message,
        metadata: {
          endpoint: reg.endpoint,
          status: reg.status,
          rawStatus: reg.rawStatus ?? null,
          extNumber: reg.extNumber ?? null,
          notRegisteredForSec,
          lastRegisteredAt: reg.lastRegisteredAt ?? null,
          devices: activeDevices.map((d: any) => ({
            model: d.model ?? null,
            osVersion: d.osVersion ?? null,
            lastSeenAt: d.lastSeenAt,
          })),
        } as any,
      },
    });
    await db.auditLog.create({
      data: {
        tenantId: reg.tenantId,
        action: "DEVICE_REGISTRATION_ALERT",
        entityType: "Alert",
        entityId: reg.endpoint,
      },
    }).catch(() => undefined);

    const tenantName = await db.tenant
      .findUnique({ where: { id: reg.tenantId }, select: { name: true } })
      .then((t) => t?.name || reg.tenantId)
      .catch(() => reg.tenantId);
    await queueAdminAlertEmail(
      `device-registration:${reg.endpoint}`,
      `Device not registered: ${reg.endpoint} (${tenantName})`,
      [
        `Tenant: ${tenantName}`,
        `Endpoint: ${reg.endpoint} (ext ${reg.extNumber ?? "?"})`,
        `Status: ${reg.status} for ${notRegisteredForSec}s`,
        `Last registered: ${reg.lastRegisteredAt ? new Date(reg.lastRegisteredAt).toISOString() : "unknown"}`,
        `Active device(s): ${activeDevices
          .map((d: any) => `${d.model ?? "?"} (Android ${d.osVersion ?? "?"}, last seen ${new Date(d.lastSeenAt).toISOString()})`)
          .join("; ")}`,
        ``,
        `Incoming calls to this extension will fail to ring the app until it re-registers.`,
        `Dashboard: /admin/device-registration`,
      ],
    );
  }
}

// Prune PBX registration history older than ~14 days so the table stays bounded.
async function runPbxRegistrationEventPrune(): Promise<void> {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  try {
    await (db as any).pbxEndpointRegistrationEvent.deleteMany({
      where: { occurredAt: { lt: cutoff } },
    });
  } catch (err: any) {
    console.error("pbx registration event prune failed", err?.message || err);
  }
}


async function runTurnValidationMaintenanceCycle(): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const expiredJobs = await db.turnValidationJob.findMany({
    where: {
      status: { in: ["QUEUED", "RUNNING"] },
      expiresAt: { lt: now },
      finishedAt: null
    },
    take: 200
  });

  for (const job of expiredJobs) {
    await db.turnValidationJob.updateMany({
      where: { id: job.id, finishedAt: null },
      data: { status: "FAILED", finishedAt: now, errorCode: job.errorCode || "EXPIRED" }
    });
  }

  const staleTenants = await db.tenant.findMany({
    where: {
      turnValidationStatus: "VERIFIED",
      turnValidatedAt: { lt: staleCutoff }
    },
    select: { id: true }
  });

  for (const tenant of staleTenants) {
    await db.tenant.update({
      where: { id: tenant.id },
      data: { turnValidationStatus: "STALE" }
    });
  }

  if (expiredJobs.length > 0 || staleTenants.length > 0) {
    console.log(`turn validation maintenance: expiredJobs=${expiredJobs.length}, staleTenants=${staleTenants.length}`);
  }
}


async function runMediaReliabilityMaintenanceCycle(): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since5m = new Date(Date.now() - 5 * 60 * 1000);

  const staleCandidates = await db.tenant.findMany({
    where: {
      mediaTestStatus: "PASSED",
      mediaTestedAt: { lt: staleCutoff }
    },
    select: { id: true }
  });

  for (const tenant of staleCandidates) {
    await db.tenant.update({
      where: { id: tenant.id },
      data: { mediaTestStatus: "STALE" }
    });
  }

  const gateBlocked = await db.tenant.findMany({
    where: {
      mediaReliabilityGateEnabled: true,
      OR: [
        { mediaTestStatus: { not: "PASSED" } },
        { mediaTestedAt: null },
        { mediaTestedAt: { lt: staleCutoff } }
      ]
    },
    select: { id: true, mediaTestStatus: true, mediaTestedAt: true, mediaLastErrorCode: true }
  });

  for (const tenant of gateBlocked) {
    const exists = await db.alert.findFirst({
      where: {
        tenantId: tenant.id,
        category: "VOICE_DIAG",
        message: "Media reliability gate enabled but tenant is not PASSED",
        createdAt: { gte: since5m }
      }
    });
    if (exists) continue;

    await db.alert.create({
      data: {
        tenantId: tenant.id,
        severity: "MEDIUM",
        category: "VOICE_DIAG",
        message: "Media reliability gate enabled but tenant is not PASSED",
        metadata: {
          mediaTestStatus: tenant.mediaTestStatus,
          mediaTestedAt: tenant.mediaTestedAt,
          mediaLastErrorCode: tenant.mediaLastErrorCode || null
        } as any
      }
    });

    await queueAdminAlertEmail(
      `media-gate:${tenant.id}`,
      `Media reliability gate blocked: ${tenant.id}`,
      [
        `Tenant: ${tenant.id}`,
        `Media test status: ${tenant.mediaTestStatus} (tested ${tenant.mediaTestedAt ? new Date(tenant.mediaTestedAt).toISOString() : "never"})`,
        `Last error: ${tenant.mediaLastErrorCode || "none"}`,
      ],
    );
    await db.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: "VOICE_MEDIA_GATE_ALERT",
        entityType: "Tenant",
        entityId: tenant.id
      }
    }).catch(() => undefined);
  }

  if (staleCandidates.length > 0 || gateBlocked.length > 0) {
    console.log(`media reliability maintenance: staleTenants=${staleCandidates.length}, gateBlocked=${gateBlocked.length}`);
  }
}

async function runPbxCdrSyncCycle(): Promise<void> {
  // Legacy WirePBX-era CDR poll. VitalPBX has no `/cdrs` endpoint (CDRs arrive
  // via the /internal/cdr-ingest push path), so against the production PBX this
  // poll can only fail — and until 2026-07-26 each failure flipped the tenant's
  // TenantPbxLink to ERROR, which blocks the agent/PBX write doors
  // (tenant_not_linked). Disabled unless explicitly re-enabled for a PBX that
  // actually implements the WirePBX CDR endpoint.
  if ((process.env.PBX_CDR_POLL_ENABLED || "false").toLowerCase() !== "true") return;
  const links: any[] = await db.tenantPbxLink.findMany({ where: { status: "LINKED" }, include: { pbxInstance: true } as any } as any);
  for (const link of links) {
    try {
      if (!link?.pbxInstance) continue;
      const auth = decryptJson<{ token: string; secret?: string | null }>(link.pbxInstance.apiAuthEncrypted);
      const pbx = getPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret || null });
      const cursor = await db.pbxCdrCursor.upsert({
        where: { tenantId: link.tenantId },
        create: { tenantId: link.tenantId, pbxInstanceId: link.pbxInstanceId, lastSeenCdrId: null, lastSeenTimestamp: null },
        update: { pbxInstanceId: link.pbxInstanceId }
      });

      const fetched = await pbx.fetchCdrs({ pbxTenantId: link.pbxTenantId || undefined, lastSeenCdrId: cursor.lastSeenCdrId || undefined, lastSeenTimestamp: cursor.lastSeenTimestamp ? cursor.lastSeenTimestamp.toISOString() : undefined, limit: 200 });
      for (const rec of fetched.records) {
        await db.callRecord.upsert({
          where: { tenantId_pbxCallId: { tenantId: link.tenantId, pbxCallId: rec.id } },
          create: {
            tenantId: link.tenantId,
            direction: rec.direction,
            fromNumber: rec.from,
            toNumber: rec.to,
            startedAt: new Date(rec.startedAt),
            durationSec: rec.durationSec,
            disposition: rec.disposition || null,
            pbxCallId: rec.id
          },
          update: {
            direction: rec.direction,
            fromNumber: rec.from,
            toNumber: rec.to,
            startedAt: new Date(rec.startedAt),
            durationSec: rec.durationSec,
            disposition: rec.disposition || null
          }
        });
      }

      await db.pbxCdrCursor.update({
        where: { tenantId: link.tenantId },
        data: {
          lastSeenCdrId: fetched.nextCursor?.lastSeenCdrId || cursor.lastSeenCdrId,
          lastSeenTimestamp: fetched.nextCursor?.lastSeenTimestamp ? new Date(fetched.nextCursor.lastSeenTimestamp) : cursor.lastSeenTimestamp,
          pbxInstanceId: link.pbxInstanceId
        }
      });
      await db.tenantPbxLink.update({ where: { id: link.id }, data: { lastSyncAt: new Date(), status: "LINKED", lastError: null } });
    } catch (e: any) {
      // Record the failure WITHOUT touching link.status — a CDR poll failure is
      // not evidence the link is broken, and status=ERROR blocks the agent/PBX
      // write doors for the whole tenant.
      await db.tenantPbxLink.update({ where: { id: link.id }, data: { lastError: String(e?.message || "PBX_CDR_SYNC_FAILED") } });
      await db.auditLog.create({ data: { tenantId: link.tenantId, action: "PBX_CDR_SYNC_FAILED", entityType: "TenantPbxLink", entityId: link.id } });
    }
  }
}

const worker = new Worker(
  "sms-send",
  async (job) => {
    const raw = job.data as { kind?: string; connectChatMessageId?: string; messageId?: string; tenantId: string };
    if (raw?.kind === "CONNECT_CHAT" && raw.connectChatMessageId) {
      await processConnectChatSmsJob({ connectChatMessageId: raw.connectChatMessageId, tenantId: raw.tenantId });
      return;
    }

    const payload = job.data as { messageId: string; tenantId: string };
    const msg = await db.smsMessage.findUnique({ where: { id: payload.messageId }, include: { campaign: { include: { tenant: true } } } });
    if (!msg) return;

    const tenant = msg.campaign.tenant;

    if (tenant.smsSuspended) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "TENANT_SUSPENDED" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }
    if (tenant.smsSendMode === "LIVE" && tenant.smsBillingEnforced && tenant.smsSubscriptionRequired) {
      const sub = await db.subscription.findUnique({ where: { tenantId: tenant.id } });
      if (!sub || sub.status !== "ACTIVE") {
        await db.tenant.update({ where: { id: tenant.id }, data: { smsSuspended: true, smsSuspendedReason: "BILLING_PAST_DUE", smsSuspendedAt: new Date() } });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_TENANT_SUSPENDED", entityType: "Tenant", entityId: tenant.id } });
        await db.smsCampaign.updateMany({ where: { id: msg.campaignId }, data: { status: "PAUSED", holdReason: "BILLING_PAST_DUE" } });
        await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "BILLING_PAST_DUE" } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }
    }

    if (await shouldAutoSuspendForFailureRate(tenant.id)) {
      await suspendTenant(tenant.id, "HIGH_FAILURE_RATE", tenant.id);
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "TENANT_SUSPENDED" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }

    const daily = await countDaily(tenant.id);
    if (daily >= tenant.dailySmsLimit) {
      await suspendTenant(tenant.id, "DAILY_LIMIT_EXCEEDED", tenant.id);
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "TENANT_SUSPENDED" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }

    const hourly = await countHourly(tenant.id);
    if (hourly >= tenant.hourlySmsLimit) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: "HOURLY_LIMIT_DELAYED_5M" } });
      await smsQueue.add("send", { messageId: msg.id, tenantId: tenant.id }, { delay: 5 * 60 * 1000, removeOnComplete: true, attempts: 3 });
      return;
    }

    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    const sentToRecipientLastMinute = await db.smsMessage.count({
      where: {
        campaign: { tenantId: tenant.id },
        toNumber: msg.toNumber,
        status: { in: ["SENT", "DELIVERED"] },
        createdAt: { gte: oneMinuteAgo }
      }
    });
    if (sentToRecipientLastMinute > 0) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: "RECIPIENT_60S_DELAY" } });
      await smsQueue.add("send", { messageId: msg.id, tenantId: tenant.id }, { delay: 60 * 1000, removeOnComplete: true, attempts: 3 });
      return;
    }

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sentToRecipient24h = await db.smsMessage.count({
      where: {
        campaign: { tenantId: tenant.id },
        toNumber: msg.toNumber,
        status: { in: ["SENT", "DELIVERED"] },
        createdAt: { gte: oneDayAgo }
      }
    });
    if (sentToRecipient24h >= 10) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "RECIPIENT_RATE_LIMIT" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }

    await enforcePerSecondTokenBucket(tenant.id, tenant.perSecondRateLimit);
    await db.smsMessage.update({ where: { id: msg.id }, data: { status: "SENDING", error: null } });
    await db.smsCampaign.updateMany({ where: { id: msg.campaignId, status: { notIn: ["PAUSED", "FAILED"] } }, data: { status: "SENDING" } });

    try {
      if (tenant.smsSendMode === "TEST") {
        const now = new Date();
        await db.smsMessage.update({
          where: { id: msg.id },
          data: {
            status: "SENT",
            providerMessageId: `SIMULATED_${randomUUID()}`,
            providerStatus: "simulated",
            providerAttemptedAt: now,
            providerRoute: "PRIMARY",
            lastProviderUpdateAt: now,
            sentAt: now,
            error: null
          }
        });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_SIMULATED", entityType: "SmsMessage", entityId: msg.id } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }

      const senderNumber = await resolveSenderNumber(msg, tenant.id);
      if (!senderNumber) {
        await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "NO_SENDER_NUMBER" } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }

      let attempts = buildRoutingAttemptOrder(tenant);
      attempts = attempts.filter((a) => a.provider === senderNumber.provider);
      if (attempts.length === 0) {
        await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "SENDER_PROVIDER_MISMATCH" } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }

      let sentOk = false;
      let lastErr: any = null;

      for (let i = 0; i < attempts.length; i += 1) {
        const candidate = attempts[i];

        if (!tenant.smsProviderLock) {
          const openUntil = await getCircuitOpenUntil(tenant.id, candidate.provider);
          if (openUntil) continue;
        }

        const providerClient = await getProviderClient(tenant.id, candidate.provider);
        if (!providerClient) continue;

        try {
          const sent = await providerClient.sendMessage({
            tenantId: tenant.id,
            to: msg.toNumber,
            from: senderNumber.phoneNumber,
            body: msg.body,
            idempotencyKey: msg.id
          });

          const now = new Date();
          await db.smsMessage.update({
            where: { id: msg.id },
            data: {
              status: "SENT",
              provider: candidate.provider,
              providerMessageId: sent.providerMessageId || null,
              providerStatus: sent.providerStatus || "sent",
              providerAttemptedAt: now,
              providerRoute: candidate.route,
              providerErrorCode: null,
              lastProviderUpdateAt: now,
              sentAt: now,
              error: null,
              fromNumberId: senderNumber.id
            }
          });

          await recordProviderHealth(tenant.id, candidate.provider, true);
          await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_SENT", entityType: "SmsMessage", entityId: msg.id, provider: candidate.provider } });
          sentOk = true;
          break;
        } catch (err: any) {
          lastErr = err;
          const normalized = normalizeProviderError(candidate.provider, err);
          await recordProviderHealth(tenant.id, candidate.provider, false, normalized.code);

          await db.smsMessage.update({
            where: { id: msg.id },
            data: {
              provider: candidate.provider,
              providerStatus: "failed",
              providerAttemptedAt: new Date(),
              providerRoute: candidate.route,
              providerErrorCode: normalized.code,
              error: normalized.humanMessage,
              lastProviderUpdateAt: new Date()
            }
          });

          const attemptsMax = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
          const thisAttempt = (job.attemptsMade || 0) + 1;
          const finalAttempt = thisAttempt >= attemptsMax;
          if (finalAttempt || !normalized.retryable) break;
        }
      }

      if (!sentOk) {
        const attemptsMax = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
        const thisAttempt = (job.attemptsMade || 0) + 1;
        const finalAttempt = thisAttempt >= attemptsMax;

        if (finalAttempt) {
          await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: String(lastErr?.message || "provider send failed"), providerStatus: "failed", lastProviderUpdateAt: new Date(), deliveryUpdatedAt: new Date() } });
          await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_FAILED_FINAL", entityType: "SmsMessage", entityId: msg.id } });
        } else {
          await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: "retrying provider send" } });
          await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_RETRY_SCHEDULED", entityType: "SmsMessage", entityId: msg.id } });
          throw lastErr || new Error("provider send failed");
        }
      }
    } catch (err: any) {
      await finalizeCampaignStatus(msg.campaignId);
      throw err;
    }

    await finalizeCampaignStatus(msg.campaignId);
  },
  { connection: redis, concurrency: 5 }
);

worker.on("completed", (job) => console.log(`sms job completed: ${job.id}`));
worker.on("failed", (job, err) => console.error(`sms job failed: ${job?.id} -> ${err.message}`));

console.log("SMS worker started");

// CRM Email Phase 1 — send-only worker. Phase 1 is launching, so default ON
// unless explicitly disabled via CRM_EMAIL_PHASE1_ENABLED=false.
const _crmEmailPhase1Off = String(process.env.CRM_EMAIL_PHASE1_ENABLED || "true").toLowerCase() === "false";
let crmEmailWorker: Worker | null = null;
let crmEmailSyncWorker: Worker | null = null;
if (!_crmEmailPhase1Off) {
  crmEmailWorker = new Worker(
    "crm-email-send",
    async (job) => {
      const d = job.data as { tenantId: string; userId: string; to: string; subject?: string; bodyText?: string; contactId?: string | null };
      await processCrmEmailSendJob({ ...d, subject: d.subject || "", bodyText: d.bodyText || "" });
    },
    { connection: redis, concurrency: 3 }
  );
  crmEmailWorker.on("completed", (job) => console.log(`crm-email job completed: ${job.id}`));
  crmEmailWorker.on("failed", (job, err) => console.error(`crm-email job failed: ${job?.id} -> ${err?.message}`));
  console.log("CRM Email worker started");

  crmEmailSyncWorker = new Worker(
    "crm-email-sync",
    async (job) => {
      const d = job.data as { tenantId: string; connectionId: string };
      await processCrmEmailSyncJob(d);
    },
    { connection: redis, concurrency: 2 }
  );
  crmEmailSyncWorker.on("completed", (job) => console.log(`crm-email-sync completed: ${job.id}`));
  crmEmailSyncWorker.on("failed", (job, err) => console.error(`crm-email-sync failed: ${job?.id} -> ${err?.message}`));
  console.log("CRM Email sync worker started");

  // ─── CRM Email auto-sync scheduler (metadata-only, threads-only) ───────────
  // Default is ON: reply sync needs to run automatically for tracked connections.
  // Set CRM_EMAIL_AUTO_SYNC_ENABLED=false to disable (e.g. for testing or cost control).
  const autoSyncEnabled = (process.env.CRM_EMAIL_AUTO_SYNC_ENABLED || "true").toLowerCase() !== "false";
  const autoSyncIntervalMs = Math.max(60_000, Number(process.env.CRM_EMAIL_AUTO_SYNC_INTERVAL_MS || 300_000));
  const autoSyncBatchSize = Math.max(1, Math.min(100, Number(process.env.CRM_EMAIL_AUTO_SYNC_BATCH_SIZE || 20)));

  async function runCrmEmailAutoSyncTick() {
    try {
      // Single-run lock across all worker replicas
      const ttl = Math.max(30_000, Math.floor(autoSyncIntervalMs * 0.9));
      const ok = await (redis as any).set("crm:email:auto_sync:lock", "1", "PX", ttl, "NX");
      if (ok !== "OK") return; // another worker holds the tick lock

      const rows = await db.crmEmailConnection.findMany({
        where: { replyTrackingEnabled: true, status: "CONNECTED" },
        orderBy: [{ lastSyncAt: "asc" }],
        select: { id: true, tenantId: true },
        take: autoSyncBatchSize,
      });

      let enqueued = 0;
      for (const r of rows) {
        try {
          await emailSyncQueue.add(
            "sync",
            { tenantId: r.tenantId, connectionId: r.id },
            { jobId: `autosync:${r.id}`, removeOnComplete: 100, removeOnFail: 100 }
          );
          enqueued += 1;
        } catch {
          // duplicate jobId or transient add error — skip safely
        }
      }

      console.log(`CRM Email auto-sync tick: checked=${rows.length} enqueued=${enqueued}`);
    } catch (e: any) {
      console.error("CRM Email auto-sync tick error:", e?.message || e);
    }
  }

  if (autoSyncEnabled) {
    setTimeout(runCrmEmailAutoSyncTick, 5_000);
    setInterval(runCrmEmailAutoSyncTick, autoSyncIntervalMs);
    console.log(`CRM Email auto-sync enabled (intervalMs=${autoSyncIntervalMs}, batchSize=${autoSyncBatchSize})`);
  } else {
    console.log("CRM Email auto-sync disabled (set CRM_EMAIL_AUTO_SYNC_ENABLED=true, or unset, to re-enable)");
  }
}

// ─── CRM Bulk Email Worker ────────────────────────────────────────────────────
// Processes server-side bulk email jobs queued via POST /crm/email/bulk-jobs.
// Concurrency=1: each job processes recipients serially with throttling to
// respect Gmail send rate limits. Multiple replicas are safe (BullMQ jobId lock).
const crmBulkEmailJobWorker = new Worker(
  "crm-bulk-email-job",
  async (job) => {
    const d = job.data as { jobId: string; tenantId: string };
    await processCrmBulkEmailJob(d);
  },
  { connection: redis, concurrency: 1 },
);
crmBulkEmailJobWorker.on("completed", (job) =>
  console.log(`crm-bulk-email-job completed: ${job.id}`),
);
crmBulkEmailJobWorker.on("failed", (job, err) =>
  console.error(`crm-bulk-email-job failed: ${job?.id} -> ${err?.message}`),
);
console.log("CRM Bulk Email worker started");

// Voicemail sync: `runVoicemailSyncCycle` in `./voicemailSyncCycle.ts` (fair helper scheduling).

// â”€â”€â”€ IVR Routing â€” Option A: schedule-based auto-publish â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Runs every 5 minutes.  For every tenant with an active IvrScheduleConfig,
// computes the intended routing mode (business/afterhours/holiday/override) and,
// if the mode has changed since the last publish (or >1 h has passed), writes
// the new state to Asterisk AstDB via the telephony service HTTP endpoint.
// NO PBX API calls; NO SSH; NO file mutations.

function ivrToIvrSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Canonical AstDB slug for IVR/MOH writes. MUST match the API's
 *  `getIvrSlugForTenant` (apps/api/src/server.ts) — if the API and worker
 *  derive different slugs, both write to different `connect/t_<slug>/...`
 *  AstDB families and inbound calls read whichever the dialplan happens to
 *  match (slug drift bug investigated 2026-05). Prefers the synced VitalPBX
 *  directory tenantSlug, falls back to the Connect Tenant.name slug.
 *  See docs/pbx/option-a-runtime-keys.md and docs/ai-context/ASTDB_KEYS.md. */
async function workerCanonicalTenantSlug(tenantId: string, tenantName: string | null | undefined): Promise<string> {
  let directorySlug: string | null = null;
  try {
    const link = await (db as any).tenantPbxLink.findFirst({
      where: { tenantId },
      select: { pbxInstanceId: true, pbxTenantId: true, pbxTenantCode: true },
    });
    if (link?.pbxInstanceId && (link.pbxTenantId || link.pbxTenantCode)) {
      const directory = await (db as any).pbxTenantDirectory.findFirst({
        where: {
          pbxInstanceId: link.pbxInstanceId,
          OR: [
            ...(link.pbxTenantId ? [{ vitalTenantId: link.pbxTenantId }] : []),
            ...(link.pbxTenantCode ? [{ tenantCode: link.pbxTenantCode }] : []),
          ],
        },
        select: { tenantSlug: true },
      });
      directorySlug = directory?.tenantSlug ?? null;
    }
  } catch {
    // Directory lookup is best-effort; fall through to Tenant.name slug.
  }
  return pickCanonicalTenantSlug(directorySlug, tenantName, tenantId);
}

// Fixed set of digit slots written on every publish. Must match the list in
// apps/api/src/server.ts — if they drift, an API publish and a worker publish
// would write different key sets and snapshot/rollback would lose fidelity.
const IVR_OPTION_DIGITS_WORKER = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "star", "hash",
] as const;

function ivrModeToType(mode: string): string | null {
  switch (mode) {
    case "business":   return "business_hours";
    case "afterhours": return "after_hours";
    case "holiday":    return "holiday";
    case "override":   return "manual_override";
    default:           return null;
  }
}

function ivrComputeMode(
  config: { timezone: string; businessHoursRules: any; holidayDates: any },
  override: { isActive: boolean; expiresAt: Date | null } | null,
  now: Date = new Date(),
): "business" | "afterhours" | "holiday" | "override" {
  if (override?.isActive && (!override.expiresAt || override.expiresAt > now)) return "override";
  const tz = config.timezone || "UTC";
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const holidays: string[] = Array.isArray(config.holidayDates) ? config.holidayDates : [];
  if (holidays.includes(localDate)) return "holiday";
  const rules: Array<{ day: number; open: string; close: string }> = Array.isArray(config.businessHoursRules) ? config.businessHoursRules : [];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = DOW_MAP[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? now.getDay();
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minStr  = parts.find((p) => p.type === "minute")?.value ?? "0";
  const minuteOfDay = parseInt(hourStr, 10) * 60 + parseInt(minStr, 10);
  const parseHHMM = (s: string) => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const rule = rules.find((r) => r.day === dow);
  if (rule && minuteOfDay >= parseHHMM(rule.open) && minuteOfDay < parseHHMM(rule.close)) return "business";
  return "afterhours";
}

let _ivrScheduleRunning = false;
async function runIvrScheduleCycle(): Promise<void> {
  if (_ivrScheduleRunning) return;
  _ivrScheduleRunning = true;
  try {
    const schedules: any[] = await (db as any).ivrScheduleConfig.findMany({
      where: { isActive: true },
      include: { tenant: { select: { name: true } } },
    });
    if (schedules.length === 0) return;

    const base = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
    const secret = process.env.CDR_INGEST_SECRET?.trim() ?? "";
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    for (const sched of schedules) {
      try {
        const tenantId: string = sched.tenantId;
        // Prefer PbxTenantDirectory.tenantSlug over Tenant.name slug — must
        // match apps/api/src/server.ts getIvrSlugForTenant() to avoid slug
        // drift between API and worker AstDB writes.
        const slug = await workerCanonicalTenantSlug(tenantId, sched.tenant?.name);
        const fam = `connect/t_${slug}`;

        const [override, profiles, lastPublish] = await Promise.all([
          (db as any).ivrOverrideState.findUnique({ where: { tenantId } }),
          (db as any).ivrRouteProfile.findMany({ where: { tenantId, isActive: true } }),
          (db as any).ivrPublishRecord.findFirst({ where: { tenantId, status: "success" }, orderBy: { publishedAt: "desc" } }),
        ]);

        const mode = ivrComputeMode(sched, override, now);
        const lastMode = lastPublish?.mode ?? null;
        const lastAt: Date | null = lastPublish?.publishedAt ?? null;
        const stale = !lastAt || lastAt < oneHourAgo;
        if (mode === lastMode && !stale) continue;

        // Look up the profile serving this mode (same fallback as the API:
        // manual_override falls back to emergency). Its options + prompt refs
        // drive the Phase 2 IVR keys.
        const wantedType = ivrModeToType(mode);
        const byType = new Map((profiles as any[]).map((p: any) => [p.type, p]));
        const active: any = wantedType
          ? (byType.get(wantedType) ?? (mode === "override" ? byType.get("emergency") : null))
          : null;
        const activeOptions: any[] = active
          ? await (db as any).ivrOptionRoute.findMany({ where: { profileId: active.id } })
          : [];
        const optByDigit = new Map<string, any>();
        for (const o of activeOptions) {
          if (o.enabled) optByDigit.set(o.optionDigit, o);
        }

        const keys: Array<{ family: string; key: string; value: string }> = [
          // Legacy single-destination keys (still read by [connect-tenant-router]).
          { family: fam, key: "mode",             value: mode },
          { family: fam, key: "dest_business",    value: byType.get("business_hours")?.pbxDestination  ?? "" },
          { family: fam, key: "dest_afterhours",  value: byType.get("after_hours")?.pbxDestination     ?? "" },
          { family: fam, key: "dest_holiday",     value: byType.get("holiday")?.pbxDestination         ?? "" },
          { family: fam, key: "dest_override",    value: byType.get("manual_override")?.pbxDestination ?? byType.get("emergency")?.pbxDestination ?? "" },
          { family: fam, key: "override_expires", value: override?.expiresAt ? String(Math.floor(new Date(override.expiresAt).getTime() / 1000)) : "0" },
          // Phase 2 prompt + timing keys (read by [connect-tenant-ivr]).
          { family: fam, key: "active_prompt",         value: active?.pbxPromptRef        ?? "" },
          { family: fam, key: "active_prompt_invalid", value: active?.pbxInvalidPromptRef ?? "" },
          { family: fam, key: "active_prompt_timeout", value: active?.pbxTimeoutPromptRef ?? "" },
          { family: fam, key: "timeout_seconds",       value: String(active?.timeoutSeconds ?? 7) },
          { family: fam, key: "max_retries",           value: String(active?.maxRetries    ?? 3) },
        ];
        // Always write every digit slot — empty value clears a stale option
        // when the new active profile has fewer digits mapped than the old.
        for (const digit of IVR_OPTION_DIGITS_WORKER) {
          const o = optByDigit.get(digit);
          keys.push({ family: fam, key: `opt_${digit}/dest`, value: o?.destinationRef  ?? "" });
          keys.push({ family: fam, key: `opt_${digit}/type`, value: o?.destinationType ?? "" });
          // Recording keys ([connect-play-prompt]): what this digit plays and
          // where the caller goes after. Always written so a repointed digit
          // clears its stale recording.
          keys.push({ family: fam, key: `opt_${digit}/announce`, value: o?.announcePromptRef   ?? "" });
          keys.push({ family: fam, key: `opt_${digit}/after`,    value: o?.afterDestinationRef ?? "" });
        }

        // Snapshot pre-publish AstDB state so an operator-initiated rollback
        // of this automated publish can restore the true prior values. If the
        // snapshot call fails, we still publish and record an empty array —
        // rollback of that record will fail cleanly with no_snapshot_available.
        let previousKeys: Array<{ family: string; key: string; value: string }> = [];
        try {
          const snapResp = await fetch(`${base}/telephony/internal/astdb-read-family`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
            body: JSON.stringify({ tenantSlug: slug, family: fam, keys: keys.map((k) => k.key) }),
            signal: AbortSignal.timeout(5_000),
          });
          if (snapResp.ok) {
            const snapData = await snapResp.json().catch(() => null) as { ok?: boolean; snapshot?: Array<{ family: string; key: string; value: string }> } | null;
            if (snapData?.ok && Array.isArray(snapData.snapshot)) previousKeys = snapData.snapshot;
          }
        } catch {
          previousKeys = [];
        }

        const record: any = await (db as any).ivrPublishRecord.create({
          data: { tenantId, publishedBy: "system", mode, keysWritten: keys, previousKeys, status: "pending", isRollback: false },
        });

        try {
          const resp = await fetch(`${base}/telephony/internal/ivr-publish`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
            body: JSON.stringify({ tenantSlug: slug, keys }),
            signal: AbortSignal.timeout(8_000),
          });
          if (!resp.ok) throw new Error(`ivr-publish HTTP ${resp.status}`);
          await (db as any).ivrPublishRecord.update({ where: { id: record.id }, data: { status: "success" } });
          console.log(`ivr schedule: published mode=${mode} for tenant ${tenantId} (slug=${slug})`);
        } catch (pubErr: any) {
          await (db as any).ivrPublishRecord.update({ where: { id: record.id }, data: { status: "failed", error: pubErr?.message } });
          console.error(`ivr schedule: publish failed for tenant ${tenantId}: ${pubErr?.message}`);
        }
      } catch (tenantErr: any) {
        console.error(`ivr schedule: error for schedule ${sched.id}: ${tenantErr?.message}`);
      }
    }
  } finally {
    _ivrScheduleRunning = false;
  }
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

setInterval(() => {
  runDunningCycle().catch((err) => console.error("dunning cycle failed", err?.message || err));
}, 60 * 60 * 1000);

runDunningCycle().catch((err) => console.error("initial dunning cycle failed", err?.message || err));

setInterval(() => {
  runPbxJobCycle().catch((err) => console.error("pbx job cycle failed", err?.message || err));
}, 60 * 1000);

// SMS push notification for VoIP.ms poll path — same data-only + high priority
// envelope as API `sendPushToUserDevices` (see packages/shared expoMobilePushFormat).
async function sendSmsPushNotification(input: SmsPushInput): Promise<void> {
  // Ledger claim — exactly-once across the poll path, webhook path, and the
  // reconciler, per recipient.
  const claimed = await claimNotification(db as any, {
    type: "sms_message",
    entityId: input.messageId,
    userId: input.userId,
    tenantId: input.tenantId,
    source: "fastpath:sms-poll",
  });
  if (!claimed) return;
  // Full rows (no select): the generated Prisma client may predate the
  // apnsAlertToken column — same access pattern as sendPushToUserDevices.
  const allDevices = await db.mobileDevice.findMany({
    where: { tenantId: input.tenantId, userId: input.userId, active: true },
  });
  const devices = allDevices
    .map((d) => ({
      id: d.id,
      expoPushToken: d.expoPushToken as string | null,
      platform: String((d as any).platform || ""),
      apnsAlertToken: ((d as any).apnsAlertToken ?? null) as string | null,
    }))
    .filter((d) => d.expoPushToken != null);
  if (!devices.length) return;

  const payload = {
    type: "sms_message",
    conversationId: input.conversationId,
    messageId: input.messageId,
    phoneNumber: input.phoneNumber,
    tenantId: input.tenantId,
    recipientUserId: input.userId,
    preview: input.preview,
    timestamp: input.timestamp,
  };

  // Direct-APNs alert path for iOS (see sendPushToUserDevices — same reason:
  // the Expo relay's stored APNs key is invalid; iOS alerts must go direct).
  let expoDevices = devices;
  if (isApnsAlertConfigured()) {
    const apnsTargets = devices.filter((d) => d.platform === "IOS" && d.apnsAlertToken);
    if (apnsTargets.length > 0) {
      const results = await sendUserAlertApnsPushes(
        apnsTargets.map((d) => ({ deviceId: d.id, apnsAlertToken: String(d.apnsAlertToken) })),
        payload,
      ).catch((err: any): Array<{ deviceId: string; result: any }> => {
        console.warn("[MOBILE_PUSH] SMS APNS_ALERT_BATCH_FAILED — falling back to Expo:", err?.message || err);
        return [];
      });
      const servedIds = new Set<string>();
      for (const { deviceId, result } of results) {
        console.info(
          JSON.stringify({
            event: "sms_push_apns_result",
            userId: input.userId,
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            deviceId,
            ok: result.ok,
            status: result.status,
            reason: result.reason,
            error: result.error ?? null,
          }),
        );
        void db.mobileDevice
          .update({
            where: { id: deviceId },
            data: {
              lastPushSentAt: new Date(),
              lastPushType: "sms_message",
              lastPushStatus: result.ok ? "APNS_ALERT_OK" : "APNS_ALERT_FAILED",
              lastPushError: result.ok
                ? null
                : (result.reason ?? result.error ?? `status_${result.status ?? "unknown"}`),
              ...(result.tokenInvalid ? { apnsAlertToken: null } : {}),
            } as any,
          })
          .catch(() => undefined);
        if (result.ok) servedIds.add(deviceId);
      }
      expoDevices = devices.filter((d) => !servedIds.has(d.id));
    }
  }
  if (!expoDevices.length) return;

  const messages = expoDevices.map((d) =>
    buildExpoPushV2Item({
      to: String(d.expoPushToken),
      payload,
      // iOS needs the visible title/body/sound envelope for user alerts —
      // data-only pushes render NOTHING on iPhones (2026-07-30). This call
      // previously omitted `platform`, silently sending iOS SMS alerts
      // data-only (i.e. invisible) even when the Expo credential worked.
      platform: d.platform ?? null,
    }),
  );

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (expoPushAccessToken) headers.authorization = `Bearer ${expoPushAccessToken}`;

  const expoRes = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
  });
  const expoBody = await expoRes.json().catch(() => null);
  console.info(
    JSON.stringify({
      event: "sms_push_expo_result",
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      httpStatus: expoRes.status,
      deviceCount: messages.length,
      expoResult: expoBody,
    }),
  );
}

setInterval(() => {
  runVoipMsInboundSyncCycle({ sendSmsPush: sendSmsPushNotification }).catch((err) => console.error("voipms inbound sms sync failed", err?.message || err));
}, Number(process.env.VOIPMS_INBOUND_SYNC_INTERVAL_MS || 60_000));

// ── Notification safety net (see notificationReconciler.ts) ────────────────
// Reconciler: every 60s, alert any voicemail / missed-call / inbound-SMS fact
// the fast paths failed to deliver (ledger-deduped, so never a double alert).
// Canary: hourly, verify zero unclaimed alert facts remain; raise a loud
// incident otherwise. Together these make silent notification death impossible.
const notificationReconcilerDeps = {
  sendPush: sendPushToUserDevices as unknown as Parameters<typeof runNotificationReconcileCycle>[0]["sendPush"],
  sendSmsPush: sendSmsPushNotification,
};
setInterval(() => {
  runNotificationReconcileCycle(notificationReconcilerDeps).catch((err) =>
    console.error("notification reconcile cycle failed", err?.message || err),
  );
}, Number(process.env.NOTIFICATION_RECONCILE_INTERVAL_MS || 60_000));
setInterval(() => {
  runNotificationCanaryCycle(notificationReconcilerDeps).catch((err) =>
    console.error("notification canary cycle failed", err?.message || err),
  );
}, Number(process.env.NOTIFICATION_CANARY_INTERVAL_MS || 60 * 60 * 1000));

// ── 24/7 call-quality learning layer (see callQualityAggregator.ts) ────────
// Hourly: distill every call's quality report into CallQualityHourly buckets
// (the adaptive-audio knowledge base) + raise CALL_QUALITY_DEGRADED incidents
// on sustained loss. First run shortly after boot so a restart never leaves
// a blind gap.
setTimeout(() => {
  runCallQualityAggregateCycle().catch((err) =>
    console.error("call quality aggregate cycle failed", err?.message || err),
  );
}, 120_000);
setInterval(() => {
  runCallQualityAggregateCycle().catch((err) =>
    console.error("call quality aggregate cycle failed", err?.message || err),
  );
}, Number(process.env.CALL_QUALITY_AGGREGATE_INTERVAL_MS || 60 * 60 * 1000));

runVoipMsInboundSyncCycle({ sendSmsPush: sendSmsPushNotification }).catch((err) => console.error("initial voipms inbound sms sync failed", err?.message || err));

// Retry mirroring any recent inbound MMS still stranded on expiring VoIP.ms
// media URLs into permanent local storage, so received photos/videos/files do
// not "disappear after a week" when the carrier deletes the source.
setInterval(() => {
  runVoipMsMmsMirrorBackfill().catch((err) => console.error("voipms mms mirror backfill failed", err?.message || err));
}, Number(process.env.VOIPMS_MMS_MIRROR_BACKFILL_INTERVAL_MS || 10 * 60_000));

runVoipMsMmsMirrorBackfill().catch((err) => console.error("initial voipms mms mirror backfill failed", err?.message || err));

setInterval(() => {
  runPbxCdrSyncCycle().catch((err) => console.error("pbx cdr sync failed", err?.message || err));
}, 2 * 60 * 1000);

setInterval(() => {
  runCallInviteExpiryCycle().catch((err) => console.error("call invite expiry failed", err?.message || err));
}, 5 * 1000);

setInterval(() => {
  runPbxActiveCallPollCycle().catch((err) => console.error("pbx active call poll failed", err?.message || err));
}, 5 * 1000);

setInterval(() => {
  runVoiceDiagAlertCycle().catch((err) => console.error("voice diag alert cycle failed", err?.message || err));
}, 5 * 60 * 1000);

setInterval(() => {
  runDeviceRegistrationAlertCycle().catch((err) => console.error("device registration alert cycle failed", err?.message || err));
}, 60 * 1000);

setInterval(() => {
  runPbxRegistrationEventPrune().catch((err) => console.error("pbx registration event prune failed", err?.message || err));
}, 6 * 60 * 60 * 1000);

setInterval(() => {
  runTurnValidationMaintenanceCycle().catch((err) => console.error("turn validation maintenance failed", err?.message || err));
}, 5 * 60 * 1000);

setInterval(() => {
  runMediaReliabilityMaintenanceCycle().catch((err) => console.error("media reliability maintenance failed", err?.message || err));
}, 5 * 60 * 1000);

runCallInviteExpiryCycle().catch((err) => console.error("initial call invite expiry failed", err?.message || err));
runVoiceDiagAlertCycle().catch((err) => console.error("initial voice diag alert cycle failed", err?.message || err));
runTurnValidationMaintenanceCycle().catch((err) => console.error("initial turn validation maintenance failed", err?.message || err));
runMediaReliabilityMaintenanceCycle().catch((err) => console.error("initial media reliability maintenance failed", err?.message || err));
runPbxActiveCallPollCycle().catch((err) => console.error("initial pbx active call poll failed", err?.message || err));

// Voicemail polling is a *fallback* for missed AMI MessageWaiting events.
// Per product spec the fallback should run every 30–60s. The AMI event path
// (telephony → /internal/voicemail-notify) is the primary near-realtime path.
// _voicemailSyncRunning guards against overlap if a cycle runs long.
setInterval(() => {
  runVoicemailSyncCycle().catch((err) => console.error("voicemail sync failed", err?.message || err));
}, 60 * 1000);

runPbxJobCycle().catch((err) => console.error("initial pbx job cycle failed", err?.message || err));
runPbxCdrSyncCycle().catch((err) => console.error("initial pbx cdr sync failed", err?.message || err));
runVoicemailSyncCycle().catch((err) => console.error("initial voicemail sync failed", err?.message || err));

// Insert-only spool reconcile (schema-2 pagination): durable catch-up for all PBX-linked mailboxes.
// VOICEMAIL_SPOOL_RECONCILE_INTERVAL_MS=0 disables. Default 15 minutes base; scheduler applies adaptive backoff + jitter.
const vmSpoolReconcileMs = Number(process.env.VOICEMAIL_SPOOL_RECONCILE_INTERVAL_MS || 15 * 60 * 1000);
if (Number.isFinite(vmSpoolReconcileMs) && vmSpoolReconcileMs > 0) {
  startVoicemailSpoolReconcileLoop();
}

// Sync SIP / WebRTC drift self-heal: periodically re-runs the live-check-aware
// extension sync for every PBX-linked tenant and alerts (console.error) when
// VitalPBX's bulk API missed a live WebRTC device (the ext 107 / T8 "Gesheft"
// bug shape) or a PBX instance was unreachable. Read-only against the PBX;
// complements (does not replace) apps/api's existing 5-minute auto-sync.
// PBX_WEBRTC_DRIFT_RECONCILE_INTERVAL_MS=0 disables. Default 30 minutes.
const pbxWebrtcDriftReconcileMs = Number(process.env.PBX_WEBRTC_DRIFT_RECONCILE_INTERVAL_MS ?? 30 * 60 * 1000);
if (Number.isFinite(pbxWebrtcDriftReconcileMs) && pbxWebrtcDriftReconcileMs > 0) {
  startPbxWebrtcDriftReconcileLoop();
}

setInterval(() => {
  runIvrScheduleCycle().catch((err) => console.error("ivr schedule cycle failed", err?.message || err));
}, 5 * 60 * 1000);

runIvrScheduleCycle().catch((err) => console.error("initial ivr schedule cycle failed", err?.message || err));

// Mobile wake auto-enroll: enable-forward reconcile of the cold-mobile wake
// fleet. Self-gated OFF unless WAKE_AUTOENROLL_ENABLED="1" (see
// ./wakeCanaryEnrollCycle.ts) — deploying this code does NOT start any PBX
// writes until the flag is set; owner-initiated activation.
{
  const wakeAutoEnrollIntervalMs = Math.max(60_000, Number(process.env.WAKE_AUTOENROLL_INTERVAL_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
  setInterval(() => {
    runWakeCanaryEnrollCycle().catch((err) => console.error("wake autoenroll cycle failed", err?.message || err));
  }, wakeAutoEnrollIntervalMs);
  runWakeCanaryEnrollCycle().catch((err) => console.error("initial wake autoenroll cycle failed", err?.message || err));
}

// â”€â”€â”€ Hold Profile Scheduling â€” Option A: reconciliation/transition cycle â”€â”€â”€â”€â”€â”€
// ROLE: This worker is a RECONCILIATION AND TRANSITION DETECTOR only.
//   â€¢ Immediate publish is handled by API endpoints (override activate/deactivate, explicit publish).
//   â€¢ This worker detects schedule-boundary transitions that happen at known times (e.g.
//     09:00 business hours start) and publishes if the computed mode differs from last published.
//   â€¢ Also repairs drift (e.g. telephony was unreachable during an API publish attempt).
//
// FREQUENCY: Runs every 60 seconds. Max delay for a schedule transition = 60 seconds.
//
// SKIP OPTIMIZATION: Each tenant's MohLastPublishedState row caches (mohClass, holdMode).
//   The worker skips tenants where the computed class/mode matches the cached last publish.
//   This avoids redundant AstDB writes on every cycle when nothing has changed.

type WorkerHoldProfile = {
  id: string;
  vitalPbxMohClassName: string;
  holdAnnouncementEnabled: boolean;
  holdAnnouncementRef: string | null;
  holdAnnouncementIntervalSec: number;
  introAnnouncementRef: string | null;
};

function normalizeWorkerMohRuntimeClass(value: string | null | undefined): string {
  return normalizeSharedMohRuntimeClass(value);
}

function workerMohLog(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

async function workerHasSyncedMohRuntimeClass(tenantId: string, value: string): Promise<boolean> {
  const runtimeClass = normalizeWorkerMohRuntimeClass(value);
  if (!isValidMohRuntimeClass(runtimeClass)) {
    workerMohLog({ event: "moh.worker.class.rejected", tenantId, runtimeClass, reason: "invalid_runtime_class" });
    return false;
  }

  if (isConnectMohRuntimeClass(runtimeClass)) {
    const asset = await (db as any).mohAsset.findFirst({
      where: {
        tenantId,
        mohClassName: runtimeClass,
        status: "ready",
        conversionStatus: "ready",
        pbxStorageKey: { not: null },
      },
      select: { id: true, pbxStorageKey: true },
    });
    if (!asset?.pbxStorageKey) {
      workerMohLog({ event: "moh.worker.connect_asset.missing", tenantId, runtimeClass });
      return false;
    }
    workerMohLog({ event: "moh.worker.connect_asset.ready", tenantId, runtimeClass, pbxStorageKey: asset.pbxStorageKey });
    workerMohLog({ event: "moh.worker.class.accepted", tenantId, runtimeClass, classKind: "connect" });
    return true;
  }

  if (!isNativeMohRuntimeClass(runtimeClass)) {
    workerMohLog({ event: "moh.worker.class.rejected", tenantId, runtimeClass, reason: "not_native_or_connect" });
    return false;
  }

  const row = await (db as any).pbxMohClass.findFirst({
    where: {
      mohClassName: runtimeClass,
      isActive: true,
      OR: [
        { tenantId },
        { tenantId: null },
        { pbxTenantId: "1" },
      ],
    },
    select: { id: true },
  });
  if (row) {
    workerMohLog({ event: "moh.worker.class.accepted", tenantId, runtimeClass, classKind: "native" });
  } else {
    workerMohLog({ event: "moh.worker.class.rejected", tenantId, runtimeClass, classKind: "native", reason: "not_in_pbx_catalog" });
  }
  return !!row;
}

function workerComputeHoldProfile(
  config: { timezone: string; defaultProfileId: string | null; afterHoursProfileId: string | null; holidayProfileId: string | null },
  rules: Array<{ ruleType: string; weekday: number | null; startTime: string | null; endTime: string | null; startAt: Date | null; endAt: Date | null; priority: number; isActive: boolean; profileId: string }>,
  override: { isActive: boolean; expiresAt: Date | null; profileId: string | null } | null,
  profileMap: Map<string, WorkerHoldProfile>,
  now: Date = new Date(),
): { profile: WorkerHoldProfile | null; mode: string } {
  // 1. Manual override
  if (override?.isActive && override.profileId && (!override.expiresAt || new Date(override.expiresAt) > now)) {
    const p = profileMap.get(override.profileId);
    if (p) return { profile: p, mode: "override" };
  }
  const tz = config.timezone || "UTC";
  const active = rules.filter((r) => r.isActive);
  // 2. One-time
  const oneTime = active.filter((r) => r.ruleType === "one_time" && r.startAt && r.endAt && new Date(r.startAt) <= now && new Date(r.endAt) > now).sort((a, b) => b.priority - a.priority);
  if (oneTime.length > 0) { const p = profileMap.get(oneTime[0].profileId); if (p) return { profile: p, mode: "one_time" }; }
  // 3. Holiday
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const holiday = active.filter((r) => r.ruleType === "holiday" && r.startTime === localDate).sort((a, b) => b.priority - a.priority);
  if (holiday.length > 0) { const p = profileMap.get(holiday[0].profileId); if (p) return { profile: p, mode: "holiday" }; }
  // 4. Weekly
  const dtParts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = DOW[dtParts.find((p) => p.type === "weekday")?.value ?? ""] ?? now.getDay();
  const hh = parseInt(dtParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mm = parseInt(dtParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const mofDay = hh * 60 + mm;
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const weekly = active.filter((r) => r.ruleType === "weekly" && r.weekday === dow && r.startTime && r.endTime && mofDay >= toMin(r.startTime) && mofDay < toMin(r.endTime)).sort((a, b) => b.priority - a.priority);
  if (weekly.length > 0) { const p = profileMap.get(weekly[0].profileId); if (p) return { profile: p, mode: "weekly" }; }
  // 5. After-hours fallback
  if (config.afterHoursProfileId) { const p = profileMap.get(config.afterHoursProfileId); if (p) return { profile: p, mode: "afterhours" }; }
  // 6. Default
  if (config.defaultProfileId) { const p = profileMap.get(config.defaultProfileId); if (p) return { profile: p, mode: "default" }; }
  return { profile: null, mode: "none" };
}

/**
 * Build the additive per-call-source AstDB keys for the worker reconcile
 * publish. Mirrors buildTenantSourceMohPublishArtifacts in apps/api. Fail-safe:
 * unready classes are dropped (never throw); the tenant-default publish always
 * proceeds regardless of a bad per-source policy.
 */
async function workerBuildSourceMohKeys(args: {
  tenantId: string;
  slug: string;
  timezone: string;
  scheduleRules: any[];
  classForProfileId: (profileId: string) => string | null;
  now: Date;
}): Promise<Array<{ family: string; key: string; value: string }>> {
  const { tenantId, slug, timezone } = args;
  const [policiesRaw, globalCfg] = await Promise.all([
    (db as any).mohSourcePolicy.findMany({ where: { tenantId, enabled: true } }),
    (db as any).mohGlobalConfig.findUnique({ where: { id: "global" } }).catch(() => null),
  ]);

  const scheduleRows: ScheduleRuleRow[] = (args.scheduleRules as any[]).map((r) => ({
    id: r.id, profileId: r.profileId, ruleType: r.ruleType,
    weekday: r.weekday ?? null, startTime: r.startTime ?? null, endTime: r.endTime ?? null,
    startAt: r.startAt ?? null, endAt: r.endAt ?? null, priority: r.priority ?? 0,
    isActive: r.isActive !== false, scope: r.scope ?? "tenant", extension: r.extension ?? "", callSource: r.callSource ?? "",
  }));
  const activeOverrides = computeActiveScheduleOverrides(scheduleRows, args.classForProfileId, timezone || "UTC", args.now);

  const staticPolicies: StaticSourcePolicy[] = (policiesRaw as any[]).map((p) => ({
    scope: p.scope === "extension" ? "extension" : "tenant",
    extension: String(p.extension ?? ""), source: String(p.source ?? ""),
    vitalPbxMohClassName: String(p.vitalPbxMohClassName ?? ""), enabled: p.enabled !== false,
  }));

  const distinct = new Set<string>();
  for (const p of staticPolicies) if (p.vitalPbxMohClassName) distinct.add(p.vitalPbxMohClassName);
  for (const o of activeOverrides) if (o.vitalPbxMohClassName) distinct.add(o.vitalPbxMohClassName);
  const ready = new Set<string>();
  for (const cls of distinct) {
    if (await workerHasSyncedMohRuntimeClass(tenantId, cls)) ready.add(normalizeSharedMohRuntimeClass(cls));
  }
  const keep = (cls: string) => ready.has(normalizeSharedMohRuntimeClass(cls));

  const keys = buildSourcePublishKeys({
    slug,
    staticPolicies: staticPolicies.filter((p) => keep(p.vitalPbxMohClassName)),
    activeOverrides: activeOverrides.filter((o) => keep(o.vitalPbxMohClassName)),
  });

  let globalClass = "";
  const rawGlobal = normalizeSharedMohRuntimeClass(globalCfg?.vitalPbxMohClassName ?? "");
  if (rawGlobal && (await workerHasSyncedMohRuntimeClass(tenantId, rawGlobal))) globalClass = rawGlobal;

  return [...keys, buildGlobalDefaultKey(globalClass)];
}

// In-memory signature of the last per-source key set published per tenant.
// Lost on restart (→ one harmless idempotent republish), which is why it is a
// safety-net cache only and never the source of truth.
const _mohSourceSignature = new Map<string, string>();

let _mohReconcileRunning = false;
async function runMohScheduleCycle(): Promise<void> {
  if (_mohReconcileRunning) return;
  _mohReconcileRunning = true;
  try {
    const schedules: any[] = await (db as any).mohScheduleConfig.findMany({
      where: { isActive: true },
      include: { tenant: { select: { name: true, mohControlMode: true } } },
    });
    if (schedules.length === 0) return;

    const base = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
    const secret = process.env.CDR_INGEST_SECRET?.trim() ?? "";
    const now = new Date();

    for (const sched of schedules) {
      try {
        const tenantId: string = sched.tenantId;
        // Native PBX-control tenants are hands-off — the worker never republishes
        // Connect keys for them. The API's control switch already tombstoned them.
        if (String(sched.tenant?.mohControlMode ?? "").trim().toLowerCase() === "pbx") continue;
        // Prefer PbxTenantDirectory.tenantSlug over Tenant.name slug — must
        // match apps/api/src/server.ts getIvrSlugForTenant() to avoid slug
        // drift between API and worker AstDB writes (root cause of dual-family
        // writes for tenants whose Connect name differs from PBX directory slug).
        const slug = await workerCanonicalTenantSlug(tenantId, sched.tenant?.name);
        const fam = `connect/t_${slug}`;

        let [rules, override, profilesRaw, lastState, lastPublish] = await Promise.all([
          (db as any).mohScheduleRule.findMany({ where: { scheduleId: sched.id, isActive: true } }),
          (db as any).mohOverrideState.findUnique({ where: { tenantId } }),
          (db as any).mohProfile.findMany({ where: { tenantId, isActive: true } }),
          (db as any).mohLastPublishedState.findUnique({ where: { tenantId } }),
          (db as any).mohPublishRecord.findFirst({ where: { tenantId, status: "success" }, orderBy: { publishedAt: "desc" }, select: { keysWritten: true } }),
        ]);

        // Timed override expiry ("play Classic for 30 minutes"): once expiresAt
        // passes, retire the row so the DB/UI reflect reality — compute below
        // already ignores expired overrides, this keeps state honest.
        if (override?.isActive && override.expiresAt && new Date(override.expiresAt) <= now) {
          await (db as any).mohOverrideState.update({
            where: { tenantId },
            data: { isActive: false, deactivatedAt: now, deactivatedBy: "system:expiry" },
          });
          override = { ...override, isActive: false };
        }

        const profileMap = new Map<string, WorkerHoldProfile>(
          (profilesRaw as any[]).map((p: any) => [p.id, {
            id: p.id, vitalPbxMohClassName: p.vitalPbxMohClassName,
            holdAnnouncementEnabled: Boolean(p.holdAnnouncementEnabled),
            holdAnnouncementRef: p.holdAnnouncementRef ?? null,
            holdAnnouncementIntervalSec: p.holdAnnouncementIntervalSec ?? 30,
            introAnnouncementRef: p.introAnnouncementRef ?? null,
          }]),
        );

        const { profile, mode } = workerComputeHoldProfile(sched, rules, override, profileMap, now);
        if (!profile) continue;
        const runtimeClass = normalizeWorkerMohRuntimeClass(profile.vitalPbxMohClassName);
        if (!(await workerHasSyncedMohRuntimeClass(tenantId, runtimeClass))) {
          console.error(`moh reconcile: blocked invalid or unsynced runtime class="${profile.vitalPbxMohClassName}" for tenant ${tenantId}`);
          continue;
        }
        profile.vitalPbxMohClassName = runtimeClass;

        // Compute the additive per-call-source key set (folds in scheduled
        // extension/tenant overrides + global default). Its signature feeds the
        // skip decision so a schedule-driven per-source transition republishes
        // within one cycle even when the tenant-default class/mode is unchanged.
        const sourceKeys = await workerBuildSourceMohKeys({
          tenantId, slug, timezone: sched.timezone || "UTC",
          scheduleRules: rules as any[],
          classForProfileId: (pid: string) => profileMap.get(pid)?.vitalPbxMohClassName ?? null,
          now,
        });
        const sourceSig = JSON.stringify(sourceKeys);

        // Skip only if BOTH the tenant default (class+mode) AND the per-source
        // key set are unchanged since the last publish.
        const lastClass = lastState?.mohClass ?? null;
        const lastMode  = lastState?.holdMode ?? null;
        if (
          profile.vitalPbxMohClassName === lastClass &&
          mode === lastMode &&
          _mohSourceSignature.get(tenantId) === sourceSig
        ) {
          continue;
        }

        // Per-extension MOH overrides (M2 / portal): the worker's key set MUST
        // carry them — the forward-clear below tombstones any clearable key the
        // last publish wrote that this one omits, so omitting live extension
        // overrides here would wipe them on the next schedule transition.
        const extOverrideRows: any[] = await (db as any).mohExtensionOverride.findMany({
          where: { tenantId, enabled: true },
          orderBy: { extension: "asc" },
          select: { extension: true, vitalPbxMohClassName: true },
        });
        const extOverrideKeys = extOverrideRows
          .filter((r) => /^[0-9A-Za-z_-]{1,32}$/.test(String(r.extension ?? "")) && String(r.vitalPbxMohClassName ?? "").trim().length > 0)
          .flatMap((r) => {
            const extFam = `${fam}/extensions/${r.extension}`;
            const cls = String(r.vitalPbxMohClassName).trim();
            return [
              { family: extFam, key: "moh_class",        value: cls },
              { family: extFam, key: "active_moh_class", value: cls },
            ];
          });

        const keys = [
          { family: fam, key: "active_moh_class",           value: profile.vitalPbxMohClassName },
          { family: fam, key: "moh_class",                  value: profile.vitalPbxMohClassName },
          { family: fam, key: "hold_mode",                  value: mode },
          { family: fam, key: "hold_announcement_enabled",  value: profile.holdAnnouncementEnabled ? "1" : "0" },
          { family: fam, key: "hold_announcement_ref",      value: profile.holdAnnouncementRef ?? "" },
          { family: fam, key: "hold_announcement_interval", value: String(profile.holdAnnouncementIntervalSec ?? 30) },
          { family: fam, key: "intro_announcement_ref",     value: profile.introAnnouncementRef ?? "" },
          { family: fam, key: "hold_announce",              value: profile.holdAnnouncementEnabled ? (profile.holdAnnouncementRef ?? "") : "" },
          { family: fam, key: "hold_repeat",                value: String(profile.holdAnnouncementIntervalSec ?? 30) },
          ...sourceKeys,
          ...extOverrideKeys,
        ];

        // Forward stale-key cleanup: tombstone any clearable key the previous
        // publish wrote that this publish no longer includes (removed per-source
        // policy, ended overlay). Guarantees no stale AstDB keys survive.
        const prevKeys: MohAstDbKey[] = Array.isArray(lastPublish?.keysWritten) ? (lastPublish.keysWritten as MohAstDbKey[]) : [];
        const forwardClears = computeForwardKeyClears(prevKeys, keys as MohAstDbKey[]);
        for (const c of forwardClears) keys.push(c);

        const record: any = await (db as any).mohPublishRecord.create({
          data: { tenantId, publishedBy: "system", source: "reconciliation", controlMode: "connect", previousMohClass: lastClass, newMohClass: profile.vitalPbxMohClassName, keysWritten: keys, previousKeysSnapshot: prevKeys, status: "pending", isRollback: false },
        });

        try {
          const resp = await fetch(`${base}/telephony/internal/ivr-publish`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
            body: JSON.stringify({ tenantSlug: slug, keys }),
            signal: AbortSignal.timeout(8_000),
          });
          if (!resp.ok) throw new Error(`moh reconcile HTTP ${resp.status}`);
          await (db as any).mohPublishRecord.update({ where: { id: record.id }, data: { status: "success" } });
          await (db as any).mohLastPublishedState.upsert({
            where: { tenantId },
            create: { tenantId, mohClass: profile.vitalPbxMohClassName, holdMode: mode, controlMode: "connect" },
            update: { mohClass: profile.vitalPbxMohClassName, holdMode: mode, publishedAt: new Date(), controlMode: "connect" },
          });
          _mohSourceSignature.set(tenantId, sourceSig);
          console.log(`moh reconcile: published class=${profile.vitalPbxMohClassName} mode=${mode} sourceKeys=${sourceKeys.length} for tenant ${tenantId}`);
        } catch (pubErr: any) {
          await (db as any).mohPublishRecord.update({ where: { id: record.id }, data: { status: "failed", error: pubErr?.message } });
          console.error(`moh reconcile: publish failed for tenant ${tenantId}: ${pubErr?.message}`);
        }
      } catch (tenantErr: any) {
        console.error(`moh reconcile: error for schedule ${sched.id}: ${tenantErr?.message}`);
      }
    }
  } finally {
    _mohReconcileRunning = false;
  }
}

// 1-minute reconciliation cycle â€” catches schedule transitions + repairs drift
// ── Admin (multi-tenant) MOH schedule reconcile ──────────────────────────────
// Highest-priority overlay. Restart-safe + idempotent via the activation ledger:
//   * a window that should be active but has no open activation → OPEN (write
//     overlay keys, snapshot prior state);
//   * an open activation whose window ended / was disabled / deleted → RESTORE
//     (tombstone ONLY the overlay keys; the untouched tenant/extension keys
//     re-take effect exactly, so prior state returns with no stale keys).
// Runs every 60s AND once on startup (missed activations/restores reconciled).

async function workerPublishAstDbKeys(slug: string, keys: any[]): Promise<void> {
  if (keys.length === 0) return;
  const base = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
  const secret = process.env.CDR_INGEST_SECRET?.trim() ?? "";
  const resp = await fetch(`${base}/telephony/internal/ivr-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
    body: JSON.stringify({ tenantSlug: slug, keys }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) throw new Error(`admin moh publish HTTP ${resp.status}`);
}

const _mohAdminSignature = new Map<string, string>();
let _mohAdminCycleRunning = false;
async function runMohAdminScheduleCycle(): Promise<void> {
  if (_mohAdminCycleRunning) return;
  _mohAdminCycleRunning = true;
  try {
    const now = new Date();
    const schedRows: any[] = await (db as any).mohAdminSchedule.findMany({
      where: { enabled: true, isDeleted: false },
      include: { targets: true },
    });
    const openActivations: any[] = await (db as any).mohAdminScheduleActivation.findMany({ where: { state: "active" } });
    if (schedRows.length === 0 && openActivations.length === 0) return;

    // Fallback config (mode/class) for EVERY schedule referenced by an open
    // activation — including ones now disabled/deleted (so their end-of-window
    // fallback still applies). Enabled+non-deleted schedules are already in
    // schedRows; this fills the gaps.
    const fallbackScheduleIds = new Set<string>(openActivations.map((a) => a.scheduleId));
    const fallbackById = new Map<string, { fallbackMode: string | null; fallbackClass: string | null; priority: number }>();
    for (const s of schedRows) fallbackById.set(s.id, { fallbackMode: s.fallbackMode ?? null, fallbackClass: s.fallbackClass ?? null, priority: Number.isFinite(s.priority) ? s.priority : 0 });
    const missingFallbackIds = [...fallbackScheduleIds].filter((id) => !fallbackById.has(id));
    if (missingFallbackIds.length > 0) {
      const fbRows: any[] = await (db as any).mohAdminSchedule.findMany({
        where: { id: { in: missingFallbackIds } },
        select: { id: true, fallbackMode: true, fallbackClass: true, priority: true },
      });
      for (const r of fbRows) fallbackById.set(r.id, { fallbackMode: r.fallbackMode ?? null, fallbackClass: r.fallbackClass ?? null, priority: Number.isFinite(r.priority) ? r.priority : 0 });
    }

    // Resolve slugs for every tenant referenced by a target or open activation.
    const tenantIds = new Set<string>();
    for (const s of schedRows) for (const t of s.targets) tenantIds.add(t.tenantId);
    for (const a of openActivations) tenantIds.add(a.tenantId);
    const tenants: any[] = await (db as any).tenant.findMany({ where: { id: { in: [...tenantIds] } }, select: { id: true, name: true, mohControlMode: true } });
    const nameById = new Map<string, string>(tenants.map((t) => [t.id, t.name]));
    const controlModeById = new Map<string, string>(tenants.map((t) => [t.id, String(t.mohControlMode ?? "connect").toLowerCase()]));
    const slugByTenant = new Map<string, string>();
    const tenantIdBySlug = new Map<string, string>();
    for (const tid of tenantIds) {
      const slug = await workerCanonicalTenantSlug(tid, nameById.get(tid));
      slugByTenant.set(tid, slug);
      tenantIdBySlug.set(slug, tid);
    }

    // Evaluate active overrides (deduped per target to the highest priority).
    const scheduleRows: AdminScheduleRow[] = schedRows.map((r) => ({
      id: r.id, enabled: r.enabled, scheduleKind: r.scheduleKind, timezone: r.timezone,
      vitalPbxMohClassName: r.vitalPbxMohClassName, priority: r.priority,
      startAt: r.startAt, endAt: r.endAt, startWeekday: r.startWeekday, startTime: r.startTime,
      endWeekday: r.endWeekday, endTime: r.endTime,
      targets: (r.targets as any[])
        .map((t) => ({ tenantSlug: slugByTenant.get(t.tenantId) ?? "", extension: t.extension || "" }))
        .filter((t) => t.tenantSlug.length > 0),
    }));
    const scheduleById = new Map<string, any>(schedRows.map((r) => [r.id, r]));
    const active: ActiveAdminOverride[] = computeActiveAdminOverrides(scheduleRows, now);

    // Winners keyed by (scheduleId,tenantId,extension) for ledger reconciliation.
    const winnerKey = (scheduleId: string, tenantId: string, ext: string) => `${scheduleId}\u0000${tenantId}\u0000${ext}`;
    const winners = new Map<string, ActiveAdminOverride>();
    for (const o of active) {
      const tid = tenantIdBySlug.get(o.tenantSlug);
      if (!tid) continue;
      winners.set(winnerKey(o.scheduleId, tid, o.extension), o);
    }

    // Group work per tenant slug (union of active + open-activation tenants).
    const slugsToProcess = new Set<string>();
    for (const o of active) slugsToProcess.add(o.tenantSlug);
    for (const a of openActivations) { const s = slugByTenant.get(a.tenantId); if (s) slugsToProcess.add(s); }

    for (const slug of slugsToProcess) {
      const tenantId = tenantIdBySlug.get(slug);
      if (!tenantId) continue;
      try {
        const activeForTenant = active.filter((o) => o.tenantSlug === slug);
        const desiredKeys = buildAdminOverlayKeysForTenant(slug, activeForTenant) as MohAstDbKey[];
        const keepIds = new Set(desiredKeys.map((k) => `${k.family}\u0000${k.key}`));

        // Tombstone every overlay key id (tenant-scope + any extension that had
        // an open activation or is an active ext target) that is NOT desired now.
        const extScopes = new Set<string>();
        for (const a of openActivations) if (a.tenantId === tenantId && a.extension) extScopes.add(String(a.extension));
        for (const o of activeForTenant) if (o.extension) extScopes.add(o.extension);
        const tombstones: MohAstDbKey[] = [];
        for (const kid of adminOverlayKeyIdsForTenant(slug)) {
          const id = `${kid.family}\u0000${kid.key}`;
          if (!keepIds.has(id)) tombstones.push({ family: kid.family, key: kid.key, value: "" });
        }
        for (const ext of extScopes) {
          for (const kid of adminOverlayKeyIdsForExtension(slug, ext)) {
            const id = `${kid.family}\u0000${kid.key}`;
            if (!keepIds.has(id)) tombstones.push({ family: kid.family, key: kid.key, value: "" });
          }
        }
        // Ledger snapshot (read BEFORE any write; drives OPEN/RESTORE + fallback).
        const lastState = await (db as any).mohLastPublishedState.findUnique({ where: { tenantId }, select: { mohClass: true, controlMode: true } });
        const openForTenant = openActivations.filter((a) => a.tenantId === tenantId);
        const openIndex = new Map<string, any>(openForTenant.map((a) => [winnerKey(a.scheduleId, a.tenantId, String(a.extension || "")), a]));

        // ── Explicit end-of-window fallback ────────────────────────────────
        // For every activation that is ENDING this cycle (open row, no longer a
        // winner) with fallbackMode="explicit", plan the fallback with the same
        // publish validation used at write time. A tenant handed back to native
        // PBX control is NEVER force-published (design: don't force Connect on a
        // PBX tenant). Highest-priority valid explicit fallback wins at tenant
        // level; extension static overrides (read first) still beat it.
        const endingCandidates: AdminFallbackCandidate[] = [];
        for (const [wk, a] of openIndex) {
          if (winners.has(wk)) continue; // still active → not ending
          const fb = fallbackById.get(a.scheduleId);
          if (fb) endingCandidates.push({ scheduleId: a.scheduleId, extension: String(a.extension || ""), fallbackMode: fb.fallbackMode, fallbackClass: fb.fallbackClass, priority: fb.priority });
        }
        // Only whole-tenant targets can set a tenant-level fallback class; an
        // extension-scoped target NEVER alters tenant defaults (blocked here and
        // rejected at the API). Both fall back to restore_previous.
        const fallbackSel = selectAdminFallbackTenantClass({
          tenantControlMode: controlModeById.get(tenantId) ?? lastState?.controlMode ?? "connect",
          candidates: endingCandidates,
        });
        for (const refused of fallbackSel.refusedClasses) {
          console.warn(`moh admin reconcile: slug=${slug} refused invalid fallback class "${refused}" → restore_previous`);
        }
        if (fallbackSel.skippedForPbx) {
          console.log(`moh admin reconcile: slug=${slug} tenant is PBX-controlled → skip explicit fallback, restore_previous`);
        }
        for (const sid of fallbackSel.blockedExtensionScoped) {
          console.log(`moh admin reconcile: slug=${slug} extension-scoped explicit fallback not applied at tenant level (schedule=${sid}) → restore_previous`);
        }
        const fallbackWinner = fallbackSel.appliedClass ? { cls: fallbackSel.appliedClass } : null;
        const fallbackKeys: MohAstDbKey[] = fallbackWinner ? (buildAdminFallbackTenantClassKeys(slug, fallbackWinner.cls) as MohAstDbKey[]) : [];

        const allKeys = [...desiredKeys, ...fallbackKeys, ...tombstones];
        const sig = JSON.stringify(allKeys);
        const changed = _mohAdminSignature.get(slug) !== sig;

        // The tenant baseline AFTER this cycle (used to snapshot any activation
        // OPENed now, so a later restore returns to the post-fallback baseline).
        const baselineClass = fallbackWinner ? fallbackWinner.cls : (lastState?.mohClass ?? null);

        // Ledger deltas — computed now, WRITTEN only after a successful publish
        // so a failed publish leaves the ledger intact and is retried next tick.
        const opensToCreate: ActiveAdminOverride[] = [];
        for (const [wk, o] of winners) {
          const [, tid] = wk.split("\u0000");
          if (tid !== tenantId) continue;
          if (openIndex.has(wk)) continue;
          opensToCreate.push(o);
        }
        const restoresToClose: any[] = [];
        for (const [wk, a] of openIndex) {
          if (winners.has(wk)) continue;
          restoresToClose.push(a);
        }

        // Publish FIRST. On failure we do not advance the signature or the
        // ledger, so the whole transition is retried on the next cycle.
        if (changed) {
          await workerPublishAstDbKeys(slug, allKeys);
        }

        // OPEN new activations for current winners with no open row.
        for (const o of opensToCreate) {
          await (db as any).mohAdminScheduleActivation.create({
            data: {
              scheduleId: o.scheduleId,
              tenantId,
              extension: o.extension || "",
              state: "active",
              appliedClass: o.vitalPbxMohClassName,
              previousClass: baselineClass,
              previousControlMode: lastState?.controlMode ?? null,
              previousKeysSnapshot: [],
            },
          });
        }
        // RESTORE open activations that are no longer winners (ended/disabled).
        for (const a of restoresToClose) {
          await (db as any).mohAdminScheduleActivation.update({
            where: { id: a.id },
            data: { state: "restored", deactivatedAt: new Date() },
          });
        }
        // Persist the new tenant baseline when an explicit fallback was applied,
        // so later admin OPENs snapshot the correct previous class.
        if (fallbackWinner) {
          await (db as any).mohLastPublishedState.upsert({
            where: { tenantId },
            update: { mohClass: fallbackWinner.cls, publishedAt: new Date() },
            create: { tenantId, mohClass: fallbackWinner.cls, holdMode: "default", controlMode: lastState?.controlMode ?? "connect" },
          });
        }

        if (changed) {
          _mohAdminSignature.set(slug, sig);
          console.log(`moh admin reconcile: slug=${slug} active=${activeForTenant.length} tombstones=${tombstones.length}${fallbackWinner ? ` fallback=${fallbackWinner.cls}` : ""}`);
        }
      } catch (tErr: any) {
        console.error(`moh admin reconcile: error for slug ${slug}: ${tErr?.message}`);
      }
    }
    void scheduleById;
  } catch (err: any) {
    console.error("moh admin reconcile cycle failed", err?.message || err);
  } finally {
    _mohAdminCycleRunning = false;
  }
}

setInterval(() => {
  runMohAdminScheduleCycle().catch((err) => console.error("moh admin reconcile cycle failed", err?.message || err));
}, 60_000);
runMohAdminScheduleCycle().catch((err) => console.error("initial moh admin reconcile cycle failed", err?.message || err));

setInterval(() => {
  runMohScheduleCycle().catch((err) => console.error("moh reconcile cycle failed", err?.message || err));
}, 60 * 1000);

runMohScheduleCycle().catch((err) => console.error("initial moh reconcile cycle failed", err?.message || err));

// ── MOH profile auto-provision (owner mandate 2026-07-26: hold-music control
// for ALL tenants, present and future) ────────────────────────────────────────
// Every LINKED tenant gets a MohProfile row for each PBX class it can play
// (its own classes + the shared main-tenant library), so agent requests like
// "change our hold music to Main" work the moment a tenant is linked — no
// manual setup. DB-only and strictly additive: existing profiles are never
// modified, classes already covered are skipped, and nothing is published
// from here (publishes only happen when a user actually asks for a change).
let _mohProvisionRunning = false;
async function runMohProfileProvisionCycle(): Promise<void> {
  if (_mohProvisionRunning) return;
  _mohProvisionRunning = true;
  try {
    const links: any[] = await (db as any).tenantPbxLink.findMany({ where: { status: "LINKED" }, select: { tenantId: true } });
    if (links.length === 0) return;
    const catalogAll: any[] = await (db as any).pbxMohClass.findMany({
      where: { isActive: true },
      select: { tenantId: true, pbxTenantId: true, mohClassName: true, name: true, isDefault: true, isActive: true, selectable: true },
    });
    if (catalogAll.length === 0) return;

    for (const link of links) {
      try {
        const catalog = visibleMohCatalogForTenant(catalogAll, link.tenantId);
        if (catalog.length === 0) continue;
        const existing: any[] = await (db as any).mohProfile.findMany({
          where: { tenantId: link.tenantId },
          select: { name: true, vitalPbxMohClassName: true },
        });
        const plan = planMissingMohProfiles(catalog, existing);
        for (const p of plan) {
          await (db as any).mohProfile.create({
            data: {
              tenantId: link.tenantId,
              name: p.name,
              type: "custom",
              vitalPbxMohClassName: p.vitalPbxMohClassName,
              isActive: true,
              createdBy: "system:moh-provision",
            },
          });
        }
        if (plan.length > 0) {
          console.log(`moh provision: created ${plan.length} profile(s) for tenant ${link.tenantId}: ${plan.map((p) => `${p.name}→${p.vitalPbxMohClassName}`).join(", ")}`);
        }
      } catch (tenantErr: any) {
        console.error(`moh provision: error for tenant ${link.tenantId}: ${tenantErr?.message}`);
      }
    }
  } finally {
    _mohProvisionRunning = false;
  }
}

setInterval(() => {
  runMohProfileProvisionCycle().catch((err) => console.error("moh provision cycle failed", err?.message || err));
}, 10 * 60 * 1000);
runMohProfileProvisionCycle().catch((err) => console.error("initial moh provision cycle failed", err?.message || err));

let _billingAutomationRunning = false;

/**
 * Phase D Worker Guard — returns the first active Sola schedule link that is NOT yet cut over
 * for the given tenant, or null if safe to charge.
 *
 * "Not yet cut over" means: mappingStatus=MAPPED, isActive=true,
 * and cutoverStatus is NOT 'CUTOVER_COMPLETE'.
 */
async function checkActiveSolaScheduleBlock(
  tenantId: string,
): Promise<{ linkId: string; solaScheduleId: string } | null> {
  const block = await (db as any).billingSolaExternalScheduleLink.findFirst({
    where: {
      tenantId,
      mappingStatus: "MAPPED",
      isActive: true,
      NOT: { cutoverStatus: "CUTOVER_COMPLETE" },
    },
    select: { id: true, solaScheduleId: true },
  });
  if (!block) return null;
  return { linkId: block.id, solaScheduleId: block.solaScheduleId };
}

/**
 * Phase D Worker Guard (post-cutover) — returns a block descriptor if a
 * recently-cutover Sola schedule has a nextConnectChargeAt that is still in
 * the future. This prevents the worker from charging in the billing period
 * that Sola already paid (the current period at cutover time).
 *
 * Critical: this guard must be checked BEFORE invoice creation so no orphan
 * OPEN invoice is left behind when we block.
 */
async function checkCutoverNextChargeAtBlock(
  tenantId: string,
  now: Date,
): Promise<{ linkId: string; solaScheduleId: string; nextConnectChargeAt: Date } | null> {
  const link = await (db as any).billingSolaExternalScheduleLink.findFirst({
    where: {
      tenantId,
      mappingStatus: "MAPPED",
      cutoverStatus: "CUTOVER_COMPLETE",
      nextConnectChargeAt: { not: null },
    },
    orderBy: { cutoverAt: "desc" },
    select: { id: true, solaScheduleId: true, nextConnectChargeAt: true },
  });
  if (!link) return null;
  const nextAt = link.nextConnectChargeAt instanceof Date ? link.nextConnectChargeAt : new Date(link.nextConnectChargeAt);
  if (now.getTime() >= nextAt.getTime()) return null; // due — allow charging
  return { linkId: link.id, solaScheduleId: link.solaScheduleId, nextConnectChargeAt: nextAt };
}

/**
 * Check billingScheduleOverride from TenantBillingSettings.metadata.
 * Returns:
 *   "skipped"      — skipNextPayment was true (flag consumed, event logged)
 *   "future_date"  — nextPaymentDate is in the future (no consume, event logged)
 *   "charge"       — safe to proceed
 */
async function getAndConsumeBillingScheduleOverride(
  tenantId: string,
  invoiceId: string,
  runId: string,
): Promise<"skipped" | "future_date" | "charge"> {
  const row = await (db as any).tenantBillingSettings.findUnique({
    where: { tenantId },
    select: { metadata: true },
  });
  const meta = row?.metadata as Record<string, unknown> | null;
  const override = meta?.billingScheduleOverride as
    | { nextPaymentDate?: string | null; skipNextPayment?: boolean; skipReason?: string | null }
    | null
    | undefined;
  if (!override) return "charge";

  // skipNextPayment: consume once, clear flag
  if (override.skipNextPayment === true) {
    // Consume the flag
    const newOverride = { ...override, skipNextPayment: false, skipReason: null };
    const newMeta = { ...(meta || {}), billingScheduleOverride: newOverride };
    await (db as any).tenantBillingSettings.update({
      where: { tenantId },
      data: { metadata: newMeta },
    });
    await (db as any).billingEventLog.create({
      data: {
        tenantId,
        invoiceId,
        runId,
        type: "billing.autopay_skipped_schedule_override",
        message: "Connect autopay skipped this month — skipNextPayment override consumed.",
        metadata: {
          reason: override.skipReason || "operator_override",
          skipNextPaymentConsumed: true,
        },
      },
    }).catch(() => null);
    return "skipped";
  }

  // nextPaymentDate: skip if today is before that date
  if (override.nextPaymentDate) {
    const nextDate = new Date(override.nextPaymentDate + "T00:00:00Z");
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (today < nextDate) {
      await (db as any).billingEventLog.create({
        data: {
          tenantId,
          invoiceId,
          runId,
          type: "billing.autopay_skipped_future_payment_date",
          message: `Connect autopay skipped — next payment date override is ${override.nextPaymentDate}, not yet reached.`,
          metadata: {
            nextPaymentDate: override.nextPaymentDate,
            today: today.toISOString(),
          },
        },
      }).catch(() => null);
      return "future_date";
    }
  }

  return "charge";
}

async function findAutopayPeriodInvoice(tenantId: string, schedule: BillingSchedule): Promise<any | null> {
  return (db as any).billingInvoice.findFirst({
    where: autopayPeriodInvoiceWhere(tenantId, schedule),
    orderBy: { createdAt: "desc" },
    include: { lineItems: true, tenant: true },
  });
}

async function runAutopayReminderPhase(
  setting: any,
  schedule: BillingSchedule,
  runId: string,
  results: any[],
): Promise<void> {
  if (!schedule.reminderDue) return;

  await (db as any).billingEventLog.create({
    data: {
      tenantId: setting.tenantId,
      runId,
      type: "autopay_invoice_generation_started",
      message: "Autopay T-3 reminder window — ensuring invoice exists before payment date.",
      metadata: {
        scheduledReminderAt: schedule.scheduledReminderAt.toISOString(),
        scheduledChargeAt: schedule.scheduledChargeAt.toISOString(),
        reminderDate: schedule.reminderDate,
        paymentDate: schedule.paymentDate,
      },
    },
  }).catch(() => null);

  const activeSolaBlock = await checkActiveSolaScheduleBlock(setting.tenantId);
  if (activeSolaBlock) {
    results.push({ tenantId: setting.tenantId, phase: "reminder", skipped: "active_sola_schedule" });
    return;
  }

  const cutoverChargeBlock = await checkCutoverNextChargeAtBlock(setting.tenantId, new Date());
  if (cutoverChargeBlock) {
    results.push({ tenantId: setting.tenantId, phase: "reminder", skipped: "sola_cutover_not_due_yet" });
    return;
  }

  const paidCoverage = await findPaidBillingPeriodCoverage({
    tenantId: setting.tenantId,
    periodStart: schedule.periodStart,
    periodEnd: schedule.periodEnd,
  });
  if (paidCoverage) {
    results.push({ tenantId: setting.tenantId, phase: "reminder", skipped: "period_already_paid", invoiceId: paidCoverage.invoiceId });
    return;
  }

  let invoice = await findAutopayPeriodInvoice(setting.tenantId, schedule);
  if (invoice) {
    await (db as any).billingEventLog.create({
      data: {
        tenantId: setting.tenantId,
        invoiceId: invoice.id,
        runId,
        type: "autopay_invoice_skipped_existing",
        message: "Autopay T-3 — invoice already exists for this billing period.",
        metadata: { invoiceNumber: invoice.invoiceNumber, status: invoice.status },
      },
    }).catch(() => null);
  } else {
    try {
      invoice = await createWorkerBillingInvoice(setting, schedule, { skipInvoiceEmail: true });
      await (db as any).billingEventLog.create({
        data: {
          tenantId: setting.tenantId,
          invoiceId: invoice.id,
          runId,
          type: "autopay_invoice_created",
          message: "Autopay T-3 — invoice created ahead of payment date.",
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            scheduledChargeAt: schedule.scheduledChargeAt.toISOString(),
            source: "worker_autopay_t3",
          },
        },
      }).catch(() => null);
    } catch (err: any) {
      await (db as any).billingEventLog.create({
        data: {
          tenantId: setting.tenantId,
          runId,
          type: "autopay_invoice_generation_failed",
          message: err?.message ? String(err.message) : "autopay_invoice_generation_failed",
          metadata: { scheduledChargeAt: schedule.scheduledChargeAt.toISOString() },
        },
      }).catch(() => null);
      results.push({ tenantId: setting.tenantId, phase: "reminder", error: err?.message || "invoice_create_failed" });
      return;
    }
  }

  if (invoice.status === "PAID") {
    results.push({ tenantId: setting.tenantId, phase: "reminder", invoiceId: invoice.id, skipped: "already_paid" });
    return;
  }

  const reminder = await queueAutopayReminderEmailOnce({
    tenantId: setting.tenantId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    totalCents: invoice.totalCents,
    balanceDueCents: invoice.balanceDueCents ?? invoice.totalCents,
    dueDate: invoice.dueDate,
    scheduledChargeAt: schedule.scheduledChargeAt,
    periodStart: invoice.periodStart ?? null,
    periodEnd: invoice.periodEnd ?? null,
  });
  if (!reminder.queued && reminder.reason === "already_sent") {
    await (db as any).billingEventLog.create({
      data: {
        tenantId: setting.tenantId,
        invoiceId: invoice.id,
        runId,
        type: "autopay_reminder_email_skipped_existing",
        message: "Autopay T-3 reminder already queued or sent for this invoice.",
      },
    }).catch(() => null);
  }
  results.push({
    tenantId: setting.tenantId,
    phase: "reminder",
    invoiceId: invoice.id,
    reminderQueued: reminder.queued,
    reminderReason: reminder.reason ?? null,
  });
}

async function runMonthlyBillingAutomation(): Promise<void> {
  if (_billingAutomationRunning) return;
  _billingAutomationRunning = true;
  try {
    const now = new Date();
    const settings = await (db as any).tenantBillingSettings.findMany({
      where: { autoBillingEnabled: true },
      include: { tenant: true, defaultPaymentMethod: true, taxProfile: true },
    });
    if (settings.length === 0) return;

    const dueSchedules = settings.map((setting: any) => ({
      setting,
      schedule: buildBillingSchedule({
        now,
        billingDayOfMonth: setting.billingDayOfMonth,
        metadata: setting.metadata,
      }),
    }));
    const runPeriodStart = new Date(Math.min(...dueSchedules.map(({ schedule }: any) => schedule.periodStart.getTime())));
    const runPeriodEnd = new Date(Math.max(...dueSchedules.map(({ schedule }: any) => schedule.periodEnd.getTime())));
    const run = await (db as any).billingRun.create({ data: { periodStart: runPeriodStart, periodEnd: runPeriodEnd, status: "RUNNING", dryRun: false } });
    const results: any[] = [];
    for (const { setting, schedule } of dueSchedules) {
      try {
        await runAutopayReminderPhase(setting, schedule, run.id, results);

        if (!schedule.due) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              runId: run.id,
              type: "billing.autopay_skipped_not_due_yet",
              message: "Connect autopay skipped — scheduled charge time has not arrived.",
              metadata: {
                reason: "not_due_yet",
                scheduledChargeAt: schedule.scheduledChargeAt.toISOString(),
                now: now.toISOString(),
                paymentDate: schedule.paymentDate,
                timeZone: schedule.timeZone,
              },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: null, transactionId: null, skipped: "not_due_yet", scheduledChargeAt: schedule.scheduledChargeAt.toISOString() });
          continue;
        }

        const { periodStart, periodEnd } = schedule;

        // ── PRE-INVOICE GUARD 1: Sola active schedule (not yet cut over) ──────
        // Must run BEFORE invoice creation so no orphan OPEN invoice is left.
        const activeSolaBlock = await checkActiveSolaScheduleBlock(setting.tenantId);
        if (activeSolaBlock) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              runId: run.id,
              type: "billing.autopay_skipped_active_sola_schedule",
              message: `Connect autopay skipped — tenant has active Sola recurring schedule not yet cut over. Schedule link ID: ${activeSolaBlock.linkId}. Disable old schedule and complete cutover before Connect charges.`,
              metadata: {
                solaScheduleLinkId: activeSolaBlock.linkId,
                solaScheduleId: activeSolaBlock.solaScheduleId,
                reason: "active_sola_schedule_not_cutover",
              },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: null, transactionId: null, skipped: "active_sola_schedule" });
          continue;
        }

        // ── PRE-INVOICE GUARD 2: nextConnectChargeAt not yet reached ──────────
        // After takeOverBillingFromSola, the link stores the first date Connect
        // is allowed to charge. The current billing period was already paid by
        // Sola, so Connect must skip it entirely — no invoice, no charge.
        const cutoverChargeBlock = await checkCutoverNextChargeAtBlock(setting.tenantId, now);
        if (cutoverChargeBlock) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              runId: run.id,
              type: "billing.autopay_skipped_sola_cutover_not_due_yet",
              message: `Connect autopay skipped — Sola cutover complete but nextConnectChargeAt has not been reached. Current period was already paid by Sola. First Connect charge will be at ${cutoverChargeBlock.nextConnectChargeAt.toISOString()}.`,
              metadata: {
                solaScheduleLinkId: cutoverChargeBlock.linkId,
                solaScheduleId: cutoverChargeBlock.solaScheduleId,
                nextConnectChargeAt: cutoverChargeBlock.nextConnectChargeAt.toISOString(),
                now: now.toISOString(),
                reason: "sola_cutover_next_charge_at_not_reached",
              },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: null, transactionId: null, skipped: "sola_cutover_not_due_yet" });
          continue;
        }

        const existing = await findAutopayPeriodInvoice(setting.tenantId, schedule);
        const paidCoverage = await findPaidBillingPeriodCoverage({
          tenantId: setting.tenantId,
          periodStart,
          periodEnd,
        });
        if (paidCoverage) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              invoiceId: paidCoverage.invoiceId,
              runId: run.id,
              type: "billing.autopay_skipped_period_already_paid",
              message: "Connect autopay skipped — this billing period is already covered by a paid invoice.",
              metadata: {
                reason: paidCoverage.reason,
                paidInvoiceId: paidCoverage.invoiceId,
                paidInvoiceNumber: paidCoverage.invoiceNumber,
                periodStart: periodStart.toISOString(),
                periodEnd: periodEnd.toISOString(),
              },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: paidCoverage.invoiceId, transactionId: null, skipped: "period_already_paid" });
          continue;
        }

        if (!existing) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              runId: run.id,
              type: "autopay_missing_invoice_on_due_date",
              message: "CRITICAL: Connect autopay due date reached but no invoice exists for this billing period. Manual intervention required.",
              metadata: {
                scheduledChargeAt: schedule.scheduledChargeAt.toISOString(),
                paymentDate: schedule.paymentDate,
                periodStart: periodStart.toISOString(),
                periodEnd: periodEnd.toISOString(),
              },
            },
          }).catch(() => null);
          await (db as any).alert.create({
            data: {
              tenantId: setting.tenantId,
              severity: "HIGH",
              category: "BILLING",
              message: `Autopay blocked — no invoice for billing period ending ${schedule.paymentDate}`,
              metadata: { runId: run.id, paymentDate: schedule.paymentDate },
            },
          }).catch(() => null);
          await queueAdminAlertEmail(
            `billing-autopay-missing-invoice:${setting.tenantId}:${schedule.paymentDate}`,
            `Autopay blocked — missing invoice (tenant ${setting.tenantId})`,
            [
              `Tenant: ${setting.tenantId}`,
              `Autopay due date reached but no invoice exists for the billing period ending ${schedule.paymentDate}.`,
              `Manual intervention required.`,
              `Run: ${run.id}`,
            ],
          );
          results.push({ tenantId: setting.tenantId, invoiceId: null, transactionId: null, skipped: "missing_invoice_on_due_date" });
          continue;
        }

        const invoice = existing;
        try {
          await consumeScheduledPlanChange({
            tenantId: setting.tenantId,
            periodStart,
            invoiceId: invoice.id,
            runId: run.id,
          });
        } catch (consumeErr: any) {
          console.warn(
            `monthly billing: consumeScheduledPlanChange failed tenant=${setting.tenantId}`,
            consumeErr?.message || consumeErr,
          );
          await (db as any).billingEventLog
            .create({
              data: {
                tenantId: setting.tenantId,
                invoiceId: invoice.id,
                runId: run.id,
                type: "billing_plan.change_consume_error",
                message: consumeErr?.message ? String(consumeErr.message) : String(consumeErr),
              },
            })
            .catch(() => null);
        }

        // ── billingScheduleOverride: skipNextPayment ───────────────────────────
        const scheduleOverride = await getAndConsumeBillingScheduleOverride(setting.tenantId, invoice.id, run.id);
        if (scheduleOverride === "skipped") {
          results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: null, skipped: "schedule_override_skip" });
          continue;
        }
        if (scheduleOverride === "future_date") {
          results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: null, skipped: "schedule_override_future_date" });
          continue;
        }

        const balanceDue = Math.max(0, invoice.balanceDueCents ?? invoice.totalCents ?? 0);
        if (invoice.status === "PAID" || balanceDue <= 0) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              invoiceId: invoice.id,
              runId: run.id,
              type: "billing.autopay_skipped_already_paid",
              message: "Connect autopay skipped — invoice already paid or has no balance due.",
              metadata: { status: invoice.status, balanceDueCents: balanceDue },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: null, skipped: "already_paid" });
          continue;
        }

        const dunning = readDunningSlice(invoice.metadata);
        if (existing && (invoice.status === "FAILED" || dunning.attempts > 0)) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              invoiceId: invoice.id,
              runId: run.id,
              type: "billing.autopay_skipped_awaiting_dunning",
              message: "Connect monthly autopay skipped — existing failed invoice is waiting for the dunning retry schedule.",
              metadata: {
                status: invoice.status,
                attempts: dunning.attempts,
                maxAttempts: dunning.maxAttempts,
                nextRetryAt: dunning.nextRetryAt,
              },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: null, skipped: "awaiting_dunning" });
          continue;
        }

        const existingOperation = await (db as any).billingChargeOperation.findFirst({
          where: { tenantId: setting.tenantId, invoiceId: invoice.id, status: { in: ["PENDING", "APPROVED"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, paymentTransactionId: true },
        });
        if (existingOperation) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              invoiceId: invoice.id,
              runId: run.id,
              type: "billing.autopay_skipped_pending_operation_exists",
              message: "Connect autopay skipped — an approved or pending billing charge operation already exists.",
              metadata: {
                reason: "pending_operation_exists",
                operationId: existingOperation.id,
                operationStatus: existingOperation.status,
                transactionId: existingOperation.paymentTransactionId || null,
              },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: null, skipped: "pending_operation_exists" });
          continue;
        }

        if (billingLiveChargesDisabled()) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              invoiceId: invoice.id,
              runId: run.id,
              type: "billing.autopay_skipped_live_charges_disabled",
              message: "Connect autopay skipped — live billing charges are disabled.",
              metadata: { reason: "live_charges_disabled" },
            },
          }).catch(() => null);
          results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: null, skipped: "live_charges_disabled" });
          continue;
        }

        let transaction = null;
        if (setting.defaultPaymentMethod?.active && setting.defaultPaymentMethod.tenantId === setting.tenantId) {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              invoiceId: invoice.id,
              runId: run.id,
              type: "autopay_charge_started",
              message: "Connect autopay charge starting on payment due date.",
              metadata: { scheduledChargeAt: schedule.scheduledChargeAt.toISOString() },
            },
          }).catch(() => null);
          transaction = await chargeWorkerInvoice(invoice, setting.defaultPaymentMethod, run.id);
          if (transaction?.status === "APPROVED") {
            await (db as any).billingEventLog.create({
              data: {
                tenantId: setting.tenantId,
                invoiceId: invoice.id,
                runId: run.id,
                type: "autopay_charge_succeeded",
                message: "Connect autopay charge succeeded.",
                metadata: { transactionId: transaction.id },
              },
            }).catch(() => null);
          } else if (transaction && transaction.status !== "APPROVED") {
            await (db as any).billingEventLog.create({
              data: {
                tenantId: setting.tenantId,
                invoiceId: invoice.id,
                runId: run.id,
                type: "autopay_charge_failed",
                message: "Connect autopay charge failed.",
                metadata: { transactionId: transaction.id, status: transaction.status },
              },
            }).catch(() => null);
          }
        } else {
          await (db as any).billingEventLog.create({
            data: {
              tenantId: setting.tenantId,
              invoiceId: invoice.id,
              runId: run.id,
              type: "billing.autopay_skipped_missing_default_payment_method",
              message: "Connect autopay skipped — no active default payment method is set.",
              metadata: {
                reason: "missing_default_payment_method",
                defaultPaymentMethodId: setting.defaultPaymentMethodId || null,
              },
            },
          }).catch(() => null);
        }
        results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: transaction?.id || null });

        // ── Billing Profiles: generate + charge sub-invoices for each active profile ──
        await runBillingProfilesForTenant(setting.tenantId, schedule, run.id, results).catch((err: any) => {
          console.error("billing profiles sweep failed for", setting.tenantId, err?.message || err);
        });
      } catch (err: any) {
        results.push({ tenantId: setting.tenantId, error: err?.message || "billing_failed" });
        await (db as any).billingEventLog.create({ data: { tenantId: setting.tenantId, runId: run.id, type: "billing_run.tenant_failed", message: err?.message || "billing_failed" } }).catch(() => null);
      }
    }
    await (db as any).billingRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), totals: { results } } });
  } catch (err: any) {
    console.error("monthly billing automation failed", err?.message || err);
  } finally {
    _billingAutomationRunning = false;
  }
}

/** Charge each active TenantBillingProfile for the given tenant on this billing cycle. */
async function runBillingProfilesForTenant(
  tenantId: string,
  schedule: BillingSchedule,
  runId: string,
  results: any[],
): Promise<void> {
  if (billingLiveChargesDisabled()) return;

  const profiles = await (db as any).tenantBillingProfile.findMany({
    where: { tenantId, autoBillingEnabled: true },
    include: { paymentMethod: true },
  });
  if (!profiles.length) return;

  const settings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId } });
  const termsDays = Number(settings?.paymentTermsDays ?? 15);

  for (const profile of profiles) {
    try {
      if (!profile.paymentMethod?.active || profile.paymentMethod.tenantId !== tenantId) {
        await (db as any).billingEventLog.create({
          data: {
            tenantId,
            runId,
            type: "billing.profile_autopay_skipped_no_card",
            message: `Billing profile "${profile.label}" skipped — no active payment method`,
            metadata: { profileId: profile.id, paymentMethodId: profile.paymentMethodId },
          },
        }).catch(() => null);
        results.push({ tenantId, profileId: profile.id, profileLabel: profile.label, skipped: "no_active_payment_method" });
        continue;
      }

      // Skip if a profile invoice already exists for this period
      const existingInvoice = await (db as any).billingInvoice.findFirst({
        where: {
          tenantId,
          billingProfileId: profile.id,
          status: { not: "VOID" },
          OR: [
            { periodStart: schedule.periodStart, periodEnd: schedule.periodEnd },
            { periodStart: { lte: schedule.scheduledChargeAt }, periodEnd: { gte: schedule.scheduledChargeAt } },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
      if (existingInvoice) {
        await (db as any).billingEventLog.create({
          data: {
            tenantId,
            invoiceId: existingInvoice.id,
            runId,
            type: "billing.profile_autopay_skipped_existing",
            message: `Billing profile "${profile.label}" already has an invoice for this period`,
            metadata: { profileId: profile.id, existingInvoiceId: existingInvoice.id, status: existingInvoice.status },
          },
        }).catch(() => null);
        results.push({ tenantId, profileId: profile.id, profileLabel: profile.label, invoiceId: existingInvoice.id, skipped: "existing_invoice" });
        continue;
      }

      const lineItems: any[] = Array.isArray(profile.lineItemsJson) ? profile.lineItemsJson : [];
      const subtotalCents = lineItems.reduce((sum: number, li: any) => sum + Math.round(li.unitPriceCents * li.quantity), 0);
      const dueDate = new Date(schedule.periodEnd.getTime() + termsDays * 24 * 60 * 60 * 1000);

      const invoice = await createBillingInvoiceRowWithUniqueNumber(tenantId, async (invoiceNumber) =>
        (db as any).billingInvoice.create({
          data: {
            tenantId,
            billingProfileId: profile.id,
            invoiceNumber,
            status: "OPEN",
            source: "PROFILE",
            billingEmail: profile.billingEmail ?? null,
            periodStart: schedule.periodStart,
            periodEnd: schedule.periodEnd,
            issueDate: new Date(),
            dueDate,
            subtotalCents,
            taxCents: 0,
            totalCents: subtotalCents,
            balanceDueCents: subtotalCents,
            amountPaidCents: 0,
            notes: profile.notes ?? null,
            lineItems: {
              create: lineItems.map((li: any, idx: number) => ({
                tenantId,
                type: li.type || "CUSTOM",
                description: li.description,
                quantity: li.quantity,
                unitPriceCents: li.unitPriceCents,
                amountCents: li.quantity * li.unitPriceCents,
                taxable: true,
                metadata: { profileId: profile.id, position: idx },
              })),
            },
            metadata: {
              source: "worker_monthly_profile",
              profileLabel: profile.label,
              scheduledChargeAt: schedule.scheduledChargeAt.toISOString(),
              runId,
            },
          },
          include: { lineItems: true },
        })
      );

      await (db as any).billingEventLog.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          runId,
          type: "billing.profile_invoice_created",
          message: `Profile invoice created for "${profile.label}"`,
          metadata: { profileId: profile.id, invoiceNumber: invoice.invoiceNumber, subtotalCents },
        },
      }).catch(() => null);

      if (subtotalCents <= 0) {
        results.push({ tenantId, profileId: profile.id, profileLabel: profile.label, invoiceId: invoice.id, skipped: "zero_balance" });
        continue;
      }

      const transaction = await chargeWorkerInvoice(invoice, profile.paymentMethod, runId);
      results.push({ tenantId, profileId: profile.id, profileLabel: profile.label, invoiceId: invoice.id, transactionId: transaction?.id || null });
    } catch (err: any) {
      console.error("billing profile failed", tenantId, profile.id, err?.message || err);
      results.push({ tenantId, profileId: profile.id, profileLabel: profile.label, error: err?.message || "profile_billing_failed" });
      await (db as any).billingEventLog.create({
        data: {
          tenantId,
          runId,
          type: "billing.profile_autopay_failed",
          message: `Profile billing failed for "${profile.label}": ${err?.message || "unknown error"}`,
          metadata: { profileId: profile.id, error: err?.message },
        },
      }).catch(() => null);
    }
  }
}

async function createWorkerBillingInvoice(
  setting: any,
  schedule: BillingSchedule,
  opts?: { skipInvoiceEmail?: boolean },
): Promise<any> {
  const invoice = await createBillingInvoice({
    tenantId: setting.tenantId,
    periodStart: schedule.periodStart,
    periodEnd: schedule.periodEnd,
    status: "OPEN",
    skipInvoiceEmail: opts?.skipInvoiceEmail ?? false,
    invoiceCreatedEventMetadata: {
      source: opts?.skipInvoiceEmail ? "worker_autopay_t3" : "worker_monthly",
      scheduledChargeAt: schedule.scheduledChargeAt.toISOString(),
      paymentDate: schedule.paymentDate,
      nextPaymentDate: schedule.nextPaymentDate,
      billingTimeZone: schedule.timeZone,
    },
  });
  const metadata = invoice.metadata && typeof invoice.metadata === "object" && !Array.isArray(invoice.metadata)
    ? { ...(invoice.metadata as Record<string, unknown>) }
    : {};
  return (db as any).billingInvoice.update({
    where: { id: invoice.id },
    data: {
      metadata: {
        ...metadata,
        scheduledChargeAt: schedule.scheduledChargeAt.toISOString(),
        paymentDate: schedule.paymentDate,
        nextPaymentDate: schedule.nextPaymentDate,
        billingTimeZone: schedule.timeZone,
      },
    },
    include: { lineItems: true, tenant: true },
  });
}

/**
 * @param attemptNumber  1 for the initial monthly-billing charge; dunning.attempts+1 for retries.
 *   Used to build a deterministic idempotency key so restarting the worker after a crash
 *   cannot produce a duplicate charge for the same attempt.
 * @param dunningOverrides  Per-tenant maxAttempts/retryDelayMs — passed to applyDunningAfterAutopayFailure
 *   so the next retry window respects tenant settings.
 */
async function chargeWorkerInvoice(
  invoice: any,
  method: any,
  runId: string | null,
  attemptNumber = 1,
  dunningOverrides?: { effectiveMaxAttempts?: number; effectiveDelayMs?: number },
): Promise<any> {
  const balanceDue = Math.max(0, invoice.balanceDueCents ?? invoice.totalCents ?? 0);
  if (invoice.status === "PAID" || balanceDue <= 0) {
    await (db as any).billingEventLog.create({
      data: {
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        runId: runId || null,
        type: "billing.autopay_skipped_already_paid",
        message: "Autopay charge skipped at execution — invoice already paid or zero balance.",
        metadata: { status: invoice.status, balanceDueCents: balanceDue, attemptNumber },
      },
    }).catch(() => null);
    return null;
  }
  await (db as any).billingEventLog.create({
    data: {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      runId: runId || null,
      type: "autopay_attempted",
      metadata: { source: runId ? "monthly_run" : "dunning_retry", attemptNumber },
    },
  });
  let transaction: any;
  try {
    transaction = await chargeBillingInvoice(invoice, method, {
      runId: runId || undefined,
      note: runId ? "worker_monthly" : "worker_dunning_retry",
    });
  } catch (err: any) {
    if (err?.code === "BILLING_LIVE_CHARGES_DISABLED") {
      await (db as any).billingEventLog.create({
        data: {
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          runId: runId || null,
          type: "billing.autopay_skipped_live_charges_disabled",
          message: "Autopay charge skipped at execution — live billing charges are disabled.",
          metadata: { reason: "live_charges_disabled", attemptNumber },
        },
      }).catch(() => null);
      return null;
    }
    if (err?.code === "CHARGE_IN_PROGRESS") {
      await (db as any).billingEventLog.create({
        data: {
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          runId: runId || null,
          type: "billing.autopay_skipped_pending_operation_exists",
          message: "Autopay charge skipped at execution — another charge operation is in progress.",
          metadata: { reason: "pending_operation_exists", attemptNumber, existingTransactionId: err?.existingTransaction?.id || null },
        },
      }).catch(() => null);
      return null;
    }
    if (err?.code === "INVOICE_ALREADY_PAID") {
      await (db as any).billingEventLog.create({
        data: {
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          runId: runId || null,
          type: "billing.autopay_skipped_already_paid",
          message: "Autopay charge skipped at execution — invoice was already paid.",
          metadata: { reason: "already_paid", attemptNumber },
        },
      }).catch(() => null);
      return null;
    }
    if (err?.code === "BILLING_PERIOD_ALREADY_PAID") {
      await (db as any).billingEventLog.create({
        data: {
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          runId: runId || null,
          type: "billing.autopay_skipped_period_already_paid",
          message: "Autopay charge skipped at execution — this billing period is already covered by a paid invoice.",
          metadata: {
            reason: err.reason || "paid_period_coverage",
            paidInvoiceId: err.paidInvoiceId || null,
            paidInvoiceNumber: err.paidInvoiceNumber || null,
            attemptNumber,
          },
        },
      }).catch(() => null);
      return null;
    }
    throw err;
  }
  if (transaction?.status === "APPROVED") {
    await clearInvoiceDunningMetadata(invoice.id);
  } else if (transaction?.status === "DECLINED" || transaction?.status === "ERROR") {
    await applyDunningAfterAutopayFailure({
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      runId,
      overrides: dunningOverrides
        ? { maxAttempts: dunningOverrides.effectiveMaxAttempts, retryDelayMs: dunningOverrides.effectiveDelayMs }
        : undefined,
    });
  }
  return transaction;
}

let _billingDunningSweepRunning = false;
async function runBillingDunningRetries(): Promise<void> {
  if (_billingDunningSweepRunning) return;
  _billingDunningSweepRunning = true;
  try {
    const sweep = await runDunningSweepEligibility(25);

    // Log invoices blocked by collections controls (best-effort; don't fail sweep on log error).
    for (const { invoice, reason } of sweep.skipped) {
      console.log(`billing dunning skip invoiceId=${invoice.id} tenantId=${invoice.tenantId} reason=${reason}`);
      (db as any).billingEventLog.create({
        data: {
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          type: "collections_action",
          message: `dunning sweep skipped: ${reason}`,
          metadata: { action: `sweep_skipped_${reason}`, operatorId: "worker:dunning" },
        },
      }).catch(() => null);
    }

    // Consume skipNextRetry flags — clear flag, log audit event, do not charge.
    for (const inv of sweep.skipNextRetryInvoices) {
      console.log(`billing dunning skipNextRetry consumed invoiceId=${inv.id}`);
      await consumeSkipNextRetryFlag(inv.id, inv.tenantId).catch((err: any) => {
        console.error("failed to consume skipNextRetry flag", inv.id, err?.message);
      });
    }

    // Charge eligible invoices with deterministic attempt numbers and per-tenant overrides.
    for (const { invoice: inv, attemptNumber, effectiveMaxAttempts, effectiveDelayMs } of sweep.toCharge) {
      try {
        const pmId = inv.tenant?.billingSettings?.defaultPaymentMethodId;
        if (!pmId) continue;
        const method = await (db as any).paymentMethod.findUnique({ where: { id: pmId } });
        if (!method?.active) continue;
        await chargeWorkerInvoice(inv, method, null, attemptNumber, { effectiveMaxAttempts, effectiveDelayMs });
      } catch (err: any) {
        console.error("billing dunning retry failed", inv?.tenantId, err?.message || err);
      }
    }
  } finally {
    _billingDunningSweepRunning = false;
  }
}

setInterval(() => {
  runBillingDunningRetries().catch((err) => console.error("billing dunning sweep failed", err?.message || err));
}, 1 * 60 * 60 * 1000);

runBillingDunningRetries().catch((err) => console.error("initial billing dunning sweep failed", err?.message || err));

setInterval(() => {
  runMonthlyBillingAutomation().catch((err) => console.error("monthly billing cycle failed", err?.message || err));
}, 60 * 60 * 1000);

runMonthlyBillingAutomation().catch((err) => console.error("initial monthly billing cycle failed", err?.message || err));

// Receipt reconciliation sweep — redundant safety net (also runs in the API
// every 10 min): guarantees every approved payment gets a receipt email even
// if the API's sweep or the queue-on-charge path is down. Per-transaction
// sentinels in BillingEventLog keep the two runners from duplicating work.
let _receiptSweepRunning = false;
async function runWorkerReceiptReconciliation(): Promise<void> {
  if (_receiptSweepRunning) return;
  _receiptSweepRunning = true;
  try {
    const summary = await sweepMissingReceiptEmails({ runner: "worker" });
    if (summary.queued > 0 || summary.revived > 0 || summary.escalated > 0 || summary.errors > 0) {
      console.warn("receipt reconciliation sweep took action", JSON.stringify(summary));
    }
  } finally {
    _receiptSweepRunning = false;
  }
}

setInterval(() => {
  runWorkerReceiptReconciliation().catch((err) => console.error("receipt reconciliation sweep failed", err?.message || err));
}, 30 * 60 * 1000);

setTimeout(() => {
  runWorkerReceiptReconciliation().catch((err) => console.error("initial receipt reconciliation sweep failed", err?.message || err));
}, 5 * 60 * 1000);

// ── Supermarket delivery tracking — background cycles (DELIVERY_DEPLOY.md §4) ──
// ETA snapshots every 30s; retention sweep every 6h. Both no-op for tenants with
// delivery disabled, and never throw (errors logged, cycle retried next tick).
import { runDeliveryEtaCycle } from "./deliveryEtaJob";
import { runDeliveryRetentionCycle } from "./deliveryRetentionJob";

setInterval(() => {
  runDeliveryEtaCycle().catch((err) => console.error("delivery ETA cycle failed", err?.message || err));
}, 30_000);

setInterval(() => {
  runDeliveryRetentionCycle().catch((err) => console.error("delivery retention sweep failed", err?.message || err));
}, 6 * 60 * 60 * 1000);
