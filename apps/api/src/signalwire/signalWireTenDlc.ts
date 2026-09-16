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

// ── The registry adapter — ONE state machine, two carriers ─────────────────
//
// 2026-09-16 (the Telnyx onboarding switch): a Telnyx number can only be
// attached to a campaign filed AT Telnyx, so the chain below talks to the
// registry of the carrier the registration row names (`provider`). The state
// machine, caps, email and EIN rule are shared — ⛔ never fork a second copy.
// Telnyx normalises its brand/campaign states to "approved"/"failed" in its
// client (identityStatus / campaignStatus), so classifyRegistryState reads
// both carriers the same way.

type RegistryRecord = { id: string; state: string | null };
type RegistryAdapter = {
  name: "signalwire" | "telnyx";
  smsProvider: "SIGNALWIRE" | "TELNYX";
  live: () => boolean;
  resolveCreds: (db: any) => Promise<any | null>;
  createBrand: (creds: any, reg: any, input: FileBrandInput) => Promise<RegistryRecord>;
  getBrand: (creds: any, id: string) => Promise<RegistryRecord>;
  createCampaign: (creds: any, brandId: string, reg: any) => Promise<RegistryRecord>;
  getCampaign: (creds: any, id: string) => Promise<RegistryRecord>;
  assignNumber: (creds: any, campaignId: string, e164: string) => Promise<void>;
  errorDetail: (e: unknown) => string;
};

const signalWireRegistry: RegistryAdapter = {
  name: "signalwire",
  smsProvider: "SIGNALWIRE",
  live: signalWireAutoProvisionEnabled,
  resolveCreds: (db) => resolveSignalWireCredentials(db).catch(() => null),
  createBrand: async (creds, reg, input) => {
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
    return { id: brand.id, state: brand.state };
  },
  getBrand: async (creds, id) => {
    const b = await getBrand(creds, id);
    return { id, state: b.state };
  },
  createCampaign: async (creds, brandId, reg) => {
    const c = await createCampaign(creds, brandId, buildCampaignInput(reg));
    return { id: c.id, state: c.state };
  },
  getCampaign: async (creds, id) => {
    const c = await getCampaign(creds, id);
    return { id, state: c.state };
  },
  assignNumber: async (creds, campaignId, e164) => {
    await createCampaignNumberOrder(creds, campaignId, [e164]);
  },
  errorDetail: (e: any) =>
    e instanceof SignalWireError ? `${e.code}: ${String(e.detail ? JSON.stringify(e.detail) : e.userMessage).slice(0, 250)}` : String(e?.message || e).slice(0, 250),
};

const telnyxRegistry: RegistryAdapter = {
  name: "telnyx",
  smsProvider: "TELNYX",
  live: () => {
    const raw = String(process.env.TELNYX_AUTO_PROVISION || "").trim().toLowerCase();
    return raw === "on" || raw === "1" || raw === "true" || raw === "yes";
  },
  resolveCreds: async (db) => {
    const { resolveTelnyxCredentials } = await import("../telnyx/telnyxCredentials");
    return resolveTelnyxCredentials(db).catch(() => null);
  },
  createBrand: async (creds, reg, input) => {
    const tx = await import("../telnyx/telnyxOnboardingClient");
    const a = input.address;
    if (!a?.street || !a?.city || !a?.state || !a?.zip) throw new Error("business_address_incomplete_for_registry");
    const phone = input.contactPhone.replace(/\D/g, "").slice(-10);
    return tx.createTenDlcBrand(creds, {
      entityType: (LEGAL_ENTITY_TYPES as readonly string[]).includes(String(reg.entityType)) ? String(reg.entityType) : "PRIVATE_PROFIT",
      displayName: String(reg.legalName || ""),
      companyName: String(reg.legalName || ""),
      ein: input.ein,
      phone: `+1${phone}`,
      email: input.contactEmail,
      street: a.street,
      city: a.city,
      state: a.state,
      postalCode: a.zip.slice(0, 5),
      website: reg.website || null,
      vertical: reg.vertical || null,
    });
  },
  getBrand: async (creds, id) => (await import("../telnyx/telnyxOnboardingClient")).getTenDlcBrand(creds, id),
  createCampaign: async (creds, brandId, reg) => {
    const c = buildCampaignInput(reg);
    return (await import("../telnyx/telnyxOnboardingClient")).createTenDlcCampaign(creds, brandId, {
      // Telnyx's names for the same TCR classes.
      usecase: c.smsUseCase === "LOW_VOLUME_MIXED" ? "LOW_VOLUME" : c.smsUseCase,
      subUsecases: c.subUseCases,
      description: c.description,
      sample1: c.sample1,
      sample2: c.sample2,
      messageFlow: c.messageFlow,
      helpMessage: c.helpMessage,
      optoutMessage: c.optOutMessage,
    });
  },
  getCampaign: async (creds, id) => (await import("../telnyx/telnyxOnboardingClient")).getTenDlcCampaign(creds, id),
  assignNumber: async (creds, campaignId, e164) => (await import("../telnyx/telnyxOnboardingClient")).assignNumberToCampaign(creds, campaignId, e164),
  errorDetail: (e: any) => {
    const d: any = e?.detail;
    const inner = Array.isArray(d?.errors)
      ? d.errors.map((x: any) => [x?.code, x?.title, x?.detail].filter(Boolean).join(" ")).join("; ")
      : e?.userMessage || e?.message || e;
    return `${e?.code || "error"}: ${String(inner).slice(0, 250)}`;
  },
};

/** The registry a registration row belongs to. Unknown/absent → SignalWire (every pre-Telnyx row). */
export function registryFor(reg: { provider?: string | null } | null | undefined): RegistryAdapter {
  return String(reg?.provider || "").toLowerCase() === "telnyx" ? telnyxRegistry : signalWireRegistry;
}

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
  /** Structured business address — Telnyx's brand API takes the parts, not a line. */
  address?: { street: string; city: string; state: string; zip: string };
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
  const registry = registryFor(reg);
  if (!registry.live()) return { filed: false, reason: "not_live" };
  const creds = await registry.resolveCreds(db);
  if (!creds) return { filed: false, reason: "unconfigured" };

  try {
    const brand = await registry.createBrand(creds, reg, input);
    if (!brand.id) throw new Error("registry_returned_no_brand_id");
    await db.tenantSmsRegistration.update({
      where: { id: reg.id },
      data: { brandId: brand.id, brandState: brand.state || "pending", status: "brand_filed", error: null },
    });
    await logSubmissionEvent(db, reg.submissionId, `Texting registration filed with the carrier registry (brand ${brand.id}).`);
    return { filed: true, brandId: brand.id, state: brand.state || "pending" };
  } catch (e: any) {
    const detail = registry.errorDetail(e);
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
  const registry = registryFor(reg);
  if (!registry.live()) return;
  // The customer can toggle texting OFF after filing the step (go back on the
  // wizard, untick, submit). The brand is already filed (harmless — identity
  // only), but the CAMPAIGN carries recurring carrier fees, so the chain must
  // not advance past it for someone who opted out. The wizard's final answer
  // is the authority; an unreadable submission does NOT block (fail toward
  // advancing — a read hiccup must not strand a paying customer's texting).
  if (reg.submissionId) {
    const sub = await db.onboardingSubmission
      .findUnique({ where: { id: reg.submissionId }, select: { answers: true } })
      .catch(() => null);
    const smsEnabled = (sub?.answers as any)?.addons?.smsEnabled;
    if (smsEnabled === false) {
      await db.tenantSmsRegistration.update({
        where: { id: reg.id },
        data: { error: "sms_disabled_on_submission" },
      }).catch(() => {});
      return;
    }
  }
  const creds = await registry.resolveCreds(db);
  if (!creds) return;

  try {
    // Brand filed → is it approved yet?
    if ((reg.status === "brand_filed" || reg.status === "brand_approved") && reg.brandId && !reg.campaignId) {
      const brand = await registry.getBrand(creds, reg.brandId);
      const verdict = classifyRegistryState(brand.state);
      if (verdict === "failed") {
        await db.tenantSmsRegistration.update({ where: { id: reg.id }, data: { brandState: brand.state, status: "failed", error: `brand_${brand.state}` } });
        await logSubmissionEvent(db, reg.submissionId, `Texting registration: the registry declined the business identity (${brand.state}). Needs a person.`);
        return;
      }
      await db.tenantSmsRegistration.update({ where: { id: reg.id }, data: { brandState: brand.state, ...(verdict === "approved" ? { status: "brand_approved" } : {}) } });
      if (verdict !== "approved") return;
      const campaign = await registry.createCampaign(creds, reg.brandId, reg);
      await db.tenantSmsRegistration.update({
        where: { id: reg.id },
        data: { campaignId: campaign.id, campaignState: campaign.state || "pending", status: "campaign_filed" },
      });
      await logSubmissionEvent(db, reg.submissionId, "Texting registration: business identity approved — campaign submitted to carriers.");
      return;
    }

    // Campaign filed → approved? → assign the number.
    if (reg.status === "campaign_filed" && reg.campaignId) {
      const campaign = await registry.getCampaign(creds, reg.campaignId);
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
      await registry.assignNumber(creds, now.campaignId, e164);
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
            provider: registry.smsProvider,
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
          update: { tenantId: fin.tenantId, provider: registry.smsProvider, smsCapable: true, mmsCapable: true, active: true, lastSyncedAt: new Date() },
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
      // ⛔ Never a silent catch here: this is the ONLY place the customer is
      // told texting is on, and a swallowed insert failure hid a Prisma
      // rejection (status "PENDING", tenantId null) for the life of the chain.
      await queueActivationEmail(db, fin).catch((e: any) => {
        console.warn(
          `[tendlc] SMS_REGISTRATION_ACTIVE_EMAIL_QUEUE_FAILED registration=${fin.id} tenant=${fin.tenantId ?? "none"}: ${String(e?.message || e).slice(0, 300)}`,
        );
      });
    }
  } catch (e: any) {
    // A transient registry failure must never kill the row — record and let
    // the sweep retry. Only an explicit registry refusal marks `failed`.
    const detail = e instanceof SignalWireError ? `${e.code}` : registry.errorDetail(e).slice(0, 200);
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
  const data = buildActivationEmailJobData(reg, to, html);
  if (!data) {
    console.warn(`[tendlc] SMS_REGISTRATION_ACTIVE_EMAIL_SKIPPED_NO_TENANT registration=${reg.id} submission=${reg.submissionId}`);
    return;
  }
  await db.emailJob.create({ data });
}

/**
 * The EmailJob create payload for the "texting is on" email, or null when the
 * registration has no tenant. ⛔ `EmailJob.tenantId` is REQUIRED and `status`
 * is the EmailJobStatus enum (QUEUED|RUNNING|SENT|FAILED|SKIPPED) — omit it so
 * it defaults to QUEUED. Both were wrong until 2026-09-16 ("PENDING", null) and
 * the insert failure was swallowed, so the email could never queue.
 */
export function buildActivationEmailJobData(
  reg: { tenantId?: string | null; legalName?: string | null },
  toEmail: string,
  htmlBody: string,
): { tenantId: string; type: string; toEmail: string; subject: string; htmlBody: string; textBody: string } | null {
  const tenantId = String(reg.tenantId || "").trim();
  if (!tenantId) return null;
  return {
    tenantId,
    type: SMS_REGISTRATION_ACTIVE_EMAIL_TYPE,
    toEmail,
    subject: "Texting is on for your business number",
    htmlBody,
    textBody: `Carriers approved the texting registration for ${String(reg.legalName || "your business")} — business texting on your Loopcom number is on.`,
  };
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
