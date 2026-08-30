/**
 * 10DLC carrier-texting registration — the SignalWire filing chain
 * (2026-08-30, part of the "everything is changing to SignalWire" build).
 *
 * One `TenantSmsRegistration` row per sign-up, advanced through:
 *   collected → brand_filed → brand_approved → campaign_filed →
 *   campaign_approved → number_assigned → active        (or failed)
 * with `awaiting_manual_filing` for sole proprietors (no EIN — TCR's
 * sole-prop flow needs the person's own texted OTP, and whether SignalWire's
 * beta API automates it is unverified, so those land in the admin queue).
 *
 * ⛔⛔ THE EIN IS A PASS-THROUGH AND IS PERSISTED NOWHERE. It arrives in the
 * filing request, goes into SignalWire's create-brand call in the same
 * breath, and is gone — no row, no log, no audit payload, no answers JSON.
 * The wizard's customer-facing promise ("your EIN is never saved on your
 * Loopcom account") is only true while every code path here keeps it true.
 *
 * ⛔ States are only ever advanced from RE-READS of the registry API
 * (getBrand/getCampaign). The status webhook is an untrusted TRIGGER — its
 * body is never copied into a row.
 *
 * ⛔ The sweep follows the house timer rule: a boot kick beside the interval
 * (a bare setInterval is starved to nothing on a busy deploy day — the
 * voicemail watchdog's 67 silent minutes), a kill switch, and an ARMED boot
 * line that names its config.
 */
import {
  createBrand,
  getBrand,
  createCampaign,
  getCampaign,
  createCampaignNumberOrder,
  SignalWireError,
  type SwCampaignInput,
} from "./signalWireClient";
import { resolveSignalWireCredentials } from "./signalWireCredentials";
import { signalWireAutoProvisionEnabled } from "../onboarding/signalWireProvisioning";

// ── Classification → registry class, caps, and templated content ───────────

export type SmsClassification = "conversational" | "marketing" | "sole_prop";

/**
 * The per-day sending ceilings the platform ENFORCES per registered class —
 * written onto Tenant.dailySmsCap at activation. These mirror the carriers'
 * own unvetted-brand limits (T-Mobile ≈2,000 segments/day; sole-prop tier
 * ≈1,000): sending past them doesn't error, it gets silently filtered, so the
 * platform refuses first, in plain English.
 */
export const DAILY_CAP_BY_CLASSIFICATION: Record<SmsClassification, number> = {
  conversational: 2000,
  marketing: 2000,
  sole_prop: 1000,
};

/** Registry entity types the wizard's "Business type" select maps onto. */
export const LEGAL_ENTITY_TYPES = ["PRIVATE_PROFIT", "PUBLIC_PROFIT", "NON_PROFIT", "GOVERNMENT"] as const;

const OPT_OUT_MESSAGE =
  "You have been unsubscribed and will receive no more messages from this number. Reply START to re-subscribe.";
const HELP_MESSAGE =
  "This number is operated for a Loopcom business customer. Reply STOP to unsubscribe, or contact the business directly for help.";

/**
 * Build the registry campaign content for a registration. Templated for
 * conversational and for Loopcom-hosted marketing (our system, our known
 * message shapes); the customer's OWN words for own-system marketing — the
 * registry compares live traffic against these, and a mismatch is silent
 * carrier filtering, which is why the wizard collects them there.
 */
export function buildCampaignInput(reg: {
  classification: string;
  senderSystem?: string | null;
  legalName?: string | null;
  messageFlow?: string | null;
  sample1?: string | null;
  sample2?: string | null;
  statusCallbackUrl?: string;
}): SwCampaignInput {
  const biz = String(reg.legalName || "the business").slice(0, 60);
  if (reg.classification === "marketing") {
    const own = String(reg.senderSystem || "") === "own";
    const flow = own && reg.messageFlow
      ? reg.messageFlow
      : `Customers of ${biz} opt in to promotional and reminder messages in person, at checkout, or by texting the business first. Every message identifies the business and carries opt-out instructions. Reply STOP opts out immediately.`;
    const s1 = own && reg.sample1 ? reg.sample1 : `${biz}: this week's specials are in! Visit us or reply for details. Reply STOP to opt out.`;
    const s2 = own && reg.sample2 ? reg.sample2 : `Reminder from ${biz}: your appointment is coming up. Reply to reschedule. Reply STOP to opt out.`;
    return {
      name: `${biz} — marketing`,
      smsUseCase: "MARKETING",
      description: `Promotional offers, specials and appointment/order reminders sent by ${biz}, a small business using the Loopcom phone platform, to customers who opted in.`,
      sample1: s1.slice(0, 1024),
      sample2: s2.slice(0, 1024),
      messageFlow: flow.slice(0, 2048),
      optOutMessage: OPT_OUT_MESSAGE,
      helpMessage: HELP_MESSAGE,
      statusCallbackUrl: reg.statusCallbackUrl,
    };
  }
  // conversational (and the manual sole-prop fallback content, if ever filed)
  return {
    name: `${biz} — customer conversations`,
    smsUseCase: "LOW_VOLUME_MIXED",
    subUseCases: ["CUSTOMER_CARE", "ACCOUNT_NOTIFICATION"],
    description: `Two-way conversational text messaging between ${biz}, a small business on the Loopcom phone platform, and its own customers: replies, questions, order and appointment coordination.`,
    sample1: `Hi, this is ${biz} — following up on your call. What time works for you today?`.slice(0, 1024),
    sample2: `${biz}: your order is ready for pickup. Reply here with any questions.`.slice(0, 1024),
    messageFlow:
      "Customers text the business's own phone number first, or ask in person to be texted back. Every conversation is human-to-human customer service; STOP opts out immediately.",
    optOutMessage: OPT_OUT_MESSAGE,
    helpMessage: HELP_MESSAGE,
    statusCallbackUrl: reg.statusCallbackUrl,
  };
}

// ── State helpers ──────────────────────────────────────────────────────────

/** Registry states that mean "approved / usable" (case-insensitive). */
const APPROVED_STATES = new Set(["approved", "verified", "ok", "active", "completed", "success"]);
const FAILED_STATES = new Set(["failed", "rejected", "declined", "suspended"]);

export function classifyRegistryState(state: string | null | undefined): "approved" | "failed" | "pending" {
  const s = String(state || "").trim().toLowerCase();
  if (!s) return "pending";
  if (APPROVED_STATES.has(s)) return "approved";
  if (FAILED_STATES.has(s)) return "failed";
  return "pending";
}

export const SMS_REGISTRATION_ACTIVE_EMAIL_TYPE = "SMS_REGISTRATION_ACTIVE";
const TERMINAL = new Set(["active", "failed"]);

async function logSubmissionEvent(db: any, submissionId: string | null, message: string): Promise<void> {
  if (!submissionId) return;
  try {
    await db.onboardingEvent.create({ data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) } });
  } catch {
    /* best-effort */
  }
}

// ── Filing ─────────────────────────────────────────────────────────────────

export type FileBrandInput = {
  registrationId: string;
  /** PASS-THROUGH. Discarded after the request. */
  ein: string;
  contactEmail: string;
  contactPhone: string;
  companyAddress: string;
};

export type FileBrandOutcome =
  | { filed: true; brandId: string; state: string }
  | { filed: false; reason: "not_live" | "unconfigured" | "registration_not_found" | "already_filed" | "manual_class" | "provider_refused"; detail?: string };

/**
 * File the BRAND with the registry — the one call the EIN passes through.
 * Called from the wizard's texting-registration endpoint the moment the
 * customer submits the step (Izzy: "once they submit the 10DLC, it should
 * automatically submit it to SignalWire").
 */
export async function fileBrandForRegistration(db: any, input: FileBrandInput): Promise<FileBrandOutcome> {
  const reg = await db.tenantSmsRegistration.findUnique({ where: { id: input.registrationId } });
  if (!reg) return { filed: false, reason: "registration_not_found" };
  if (reg.classification === "sole_prop") return { filed: false, reason: "manual_class" };
  if (reg.brandId) return { filed: false, reason: "already_filed" };
  if (!signalWireAutoProvisionEnabled()) return { filed: false, reason: "not_live" };
  const creds = await resolveSignalWireCredentials(db).catch(() => null);
  if (!creds) return { filed: false, reason: "unconfigured" };

  try {
    const brand = await createBrand(creds, {
      name: String(reg.legalName || "").slice(0, 100),
      companyName: String(reg.legalName || "").slice(0, 200),
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      einIssuingCountry: "US",
      legalEntityType: (LEGAL_ENTITY_TYPES as readonly string[]).includes(String(reg.entityType))
        ? (reg.entityType as (typeof LEGAL_ENTITY_TYPES)[number])
        : "PRIVATE_PROFIT",
      ein: input.ein,
      companyAddress: input.companyAddress,
      companyWebsite: String(reg.website || ""),
      companyVertical: reg.vertical || undefined,
    });
    await db.tenantSmsRegistration.update({
      where: { id: reg.id },
      data: { brandId: brand.id, brandState: brand.state || "pending", status: "brand_filed", error: null },
    });
    await logSubmissionEvent(db, reg.submissionId, `Texting registration filed with the carrier registry (brand ${brand.id}).`);
    return { filed: true, brandId: brand.id, state: brand.state || "pending" };
  } catch (e: any) {
    const detail = e instanceof SignalWireError ? `${e.code}: ${String(e.detail ? JSON.stringify(e.detail) : e.userMessage).slice(0, 250)}` : String(e?.message || e).slice(0, 250);
    await db.tenantSmsRegistration.update({ where: { id: reg.id }, data: { error: detail } });
    await logSubmissionEvent(db, reg.submissionId, `Texting registration filing was refused by the registry: ${detail}. Needs a person.`);
    return { filed: false, reason: "provider_refused", detail };
  }
}

// ── The state machine ──────────────────────────────────────────────────────

/**
 * Advance ONE registration as far as the registry's current answers allow.
 * Safe to call repeatedly from the sweep, the webhook trigger and the
 * orchestrator kick — every step re-checks and no step repeats.
 */
export async function advanceSmsRegistration(db: any, registrationId: string): Promise<void> {
  const reg = await db.tenantSmsRegistration.findUnique({ where: { id: registrationId } });
  if (!reg || TERMINAL.has(reg.status) || reg.status === "awaiting_manual_filing" || reg.status === "collected") return;
  if (!signalWireAutoProvisionEnabled()) return;
  const creds = await resolveSignalWireCredentials(db).catch(() => null);
  if (!creds) return;

  try {
    // Brand filed → is it approved yet?
    if ((reg.status === "brand_filed" || reg.status === "brand_approved") && reg.brandId && !reg.campaignId) {
      const brand = await getBrand(creds, reg.brandId);
      const verdict = classifyRegistryState(brand.state);
      if (verdict === "failed") {
        await db.tenantSmsRegistration.update({ where: { id: reg.id }, data: { brandState: brand.state, status: "failed", error: `brand_${brand.state}` } });
        await logSubmissionEvent(db, reg.submissionId, `Texting registration: the registry declined the business identity (${brand.state}). Needs a person.`);
        return;
      }
      await db.tenantSmsRegistration.update({ where: { id: reg.id }, data: { brandState: brand.state, ...(verdict === "approved" ? { status: "brand_approved" } : {}) } });
      if (verdict !== "approved") return;
      const campaign = await createCampaign(creds, reg.brandId, buildCampaignInput(reg));
      await db.tenantSmsRegistration.update({
        where: { id: reg.id },
        data: { campaignId: campaign.id, campaignState: campaign.state || "pending", status: "campaign_filed" },
      });
      await logSubmissionEvent(db, reg.submissionId, "Texting registration: business identity approved — campaign submitted to carriers.");
      return;
    }

    // Campaign filed → approved? → assign the number.
    if (reg.status === "campaign_filed" && reg.campaignId) {
      const campaign = await getCampaign(creds, reg.campaignId);
      const verdict = classifyRegistryState(campaign.state);
      if (verdict === "failed") {
        await db.tenantSmsRegistration.update({ where: { id: reg.id }, data: { campaignState: campaign.state, status: "failed", error: `campaign_${campaign.state}` } });
        await logSubmissionEvent(db, reg.submissionId, `Texting registration: carriers declined the campaign (${campaign.state}). Needs a person.`);
        return;
      }
      await db.tenantSmsRegistration.update({ where: { id: reg.id }, data: { campaignState: campaign.state, ...(verdict === "approved" ? { status: "campaign_approved" } : {}) } });
      if (verdict !== "approved") return;
    }

    // Campaign approved → assign the tenant's number (needs the number to
    // exist — a port-in signup may reach approval before payment/purchase).
    const now = await db.tenantSmsRegistration.findUnique({ where: { id: registrationId } });
    if (now?.status === "campaign_approved" && now.campaignId) {
      let e164 = String(now.phoneE164 || "");
      if (!e164 && now.submissionId) {
        const sub = await db.onboardingSubmission.findUnique({ where: { id: now.submissionId } });
        const did = String(sub?.provisionedDid || "").replace(/\D/g, "");
        if (did.length === 10) e164 = `+1${did}`;
      }
      if (!e164) return; // number not purchased yet — the sweep retries
      await createCampaignNumberOrder(creds, now.campaignId, [e164]);
      await db.tenantSmsRegistration.update({
        where: { id: now.id },
        data: { phoneE164: e164, numberAssignedAt: new Date(), status: "number_assigned" },
      });
      await logSubmissionEvent(db, now.submissionId, `Texting registration: ${e164} attached to the approved campaign (carriers connect it within ~24h).`);
    }

    // Number assigned → ACTIVE: enforce the class cap and tell the customer.
    const fin = await db.tenantSmsRegistration.findUnique({ where: { id: registrationId } });
    if (fin?.status === "number_assigned") {
      // Wire the number into the CHAT system before declaring it active: the
      // TenantSmsNumber row is what routes an inbound SignalWire webhook to a
      // thread AND what tells the worker to dispatch outbound through
      // SignalWire (`provider: "SIGNALWIRE"`). VoIP.ms numbers get this row
      // from the inventory sync; SignalWire has no sync, so activation creates
      // it — without it every inbound text dies "unassigned". Deliberately NOT
      // caught: a failed upsert leaves the row at number_assigned and the
      // sweep retries the whole step.
      if (fin.tenantId && fin.phoneE164) {
        await db.tenantSmsNumber.upsert({
          where: { phoneE164: fin.phoneE164 },
          create: {
            tenantId: fin.tenantId,
            provider: "SIGNALWIRE",
            phoneE164: fin.phoneE164,
            phoneRaw: fin.phoneE164,
            smsCapable: true,
            mmsCapable: true,
            isTenantDefault: true,
            active: true,
            lastSyncedAt: new Date(),
          },
          // An existing row keeps its assignment and default flag — only the
          // ownership, provider and capabilities are corrected.
          update: { tenantId: fin.tenantId, provider: "SIGNALWIRE", smsCapable: true, mmsCapable: true, active: true, lastSyncedAt: new Date() },
        });
      }
      await db.tenantSmsRegistration.update({ where: { id: fin.id }, data: { status: "active", activatedAt: new Date() } });
      const cap = DAILY_CAP_BY_CLASSIFICATION[(fin.classification as SmsClassification)] ?? DAILY_CAP_BY_CLASSIFICATION.conversational;
      if (fin.tenantId) {
        // The cap the customer REGISTERED for is the cap the platform enforces
        // — sending past it is silent carrier filtering, so we refuse first.
        await db.tenant.update({ where: { id: fin.tenantId }, data: { dailySmsCap: cap } }).catch(() => {});
      }
      await logSubmissionEvent(db, fin.submissionId, `Texting is ON — registration approved (up to ${cap} messages/day for this class).`);
      await queueActivationEmail(db, fin).catch(() => {});
    }
  } catch (e: any) {
    // A transient registry failure must never kill the row — record and let
    // the sweep retry. Only an explicit registry refusal marks `failed`.
    const detail = e instanceof SignalWireError ? `${e.code}` : String(e?.message || e).slice(0, 200);
    await db.tenantSmsRegistration.update({ where: { id: registrationId }, data: { error: detail } }).catch(() => {});
  }
}

/**
 * Tell the customer texting is on. Type is its OWN email category —
 * ⛔ NEVER ADMIN_ALERT (muted at the send door: it would build clean, log
 * clean and reach nobody).
 */
async function queueActivationEmail(db: any, reg: any): Promise<void> {
  if (!reg.submissionId) return;
  const sub = await db.onboardingSubmission.findUnique({ where: { id: reg.submissionId } });
  const to = String(sub?.mainEmail || sub?.billingEmail || "").trim();
  if (!to) return;
  const { emailShell } = await import("../billing/emailTemplates");
  const { resolveInvoiceEmailBranding } = await import("../billing/invoiceBranding");
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const biz = esc(String(reg.legalName || sub?.companyName || "your business"));
  const body = `
    <p style="margin:0 0 16px;font-size:17px;line-height:26px;color:#1e293b;">Carriers approved the texting registration for ${biz} — business texting on your Loopcom number is on.</p>
    <p style="margin:0;font-size:16px;line-height:25px;color:#475569;">Texts your customers send you land in your Loopcom inbox, and your team can reply from the apps. Recipients can always reply STOP to opt out — that part is automatic.</p>
  `;
  const html = emailShell("Texting is on", body, resolveInvoiceEmailBranding({}, null), {
    eyebrow: null,
    footerNote: "Sent by Loopcom.",
    includeSupportBlock: false,
  });
  await db.emailJob.create({
    data: {
      type: SMS_REGISTRATION_ACTIVE_EMAIL_TYPE,
      toEmail: to,
      subject: "Texting is on for your business number",
      htmlBody: html,
      textBody: `Carriers approved the texting registration for ${String(reg.legalName || "your business")} — business texting on your Loopcom number is on.`,
      tenantId: reg.tenantId || null,
      status: "PENDING",
    },
  });
}

// ── The sweep ──────────────────────────────────────────────────────────────

export const SMS_REGISTRATION_SWEEP_MS = Number(process.env.SIGNALWIRE_TENDLC_SWEEP_MS || 10 * 60_000);
export const SMS_REGISTRATION_BOOT_DELAY_MS = Number(process.env.SIGNALWIRE_TENDLC_BOOT_DELAY_MS || 3 * 60_000);

export async function sweepSmsRegistrations(db: any): Promise<{ considered: number }> {
  const rows = await db.tenantSmsRegistration.findMany({
    where: { status: { in: ["brand_filed", "brand_approved", "campaign_filed", "campaign_approved", "number_assigned"] } },
    take: 50,
    orderBy: { updatedAt: "asc" },
  });
  for (const r of rows) {
    await advanceSmsRegistration(db, r.id).catch(() => {});
  }
  return { considered: rows.length };
}

/**
 * Arm the sweep. ⛔ Boot kick BESIDE the interval — a bare setInterval is
 * starved on a busy deploy day. Kill switch: SIGNALWIRE_TENDLC_SWEEP_DISABLED=1.
 */
export function startSmsRegistrationSweep(db: any, log: { info: (o: any, m?: string) => void } = console as any): void {
  if (String(process.env.SIGNALWIRE_TENDLC_SWEEP_DISABLED || "") === "1") {
    log.info({}, "SIGNALWIRE_TENDLC sweep disabled by env");
    return;
  }
  log.info(
    { sweepMs: SMS_REGISTRATION_SWEEP_MS, bootDelayMs: SMS_REGISTRATION_BOOT_DELAY_MS, live: signalWireAutoProvisionEnabled() },
    "SIGNALWIRE_TENDLC_SWEEP_ARMED",
  );
  const run = () => void sweepSmsRegistrations(db).catch(() => {});
  const kick = setTimeout(run, SMS_REGISTRATION_BOOT_DELAY_MS);
  (kick as unknown as { unref?: () => void }).unref?.();
  const timer = setInterval(run, SMS_REGISTRATION_SWEEP_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}
