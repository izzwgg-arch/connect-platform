/**
 * Telnyx 10DLC registry calls for the texting-registration admin page
 * (2026-09-16).
 *
 * ⛔ Kept SEPARATE from `telnyx/telnyxOnboardingClient.ts` on purpose. That
 * client serves the sign-up wizard and collapses states early (a campaign is
 * "approved" at TCR_ACCEPTED, before any carrier has reviewed it; a
 * SELF_DECLARED brand is "approved"). Changing those semantics would change the
 * wizard. This page needs the raw registry states — per-carrier review,
 * identity status, failure reasons — so it reads them itself.
 *
 * ⛔ Built to Telnyx's OpenAPI spec (github team-telnyx/openapi spec3.json),
 * NOT its docs pages, which contradict the spec on several paths
 * (docs/ai-context/AGENT_HANDOFF_TELNYX_10DLC_2026-09-16.md §2):
 *   brand           POST/GET/PUT /10dlc/brand[/{id}], PUT /10dlc/brand/{id}/revet,
 *                   GET /10dlc/brand/feedback/{id}
 *   campaign        POST /10dlc/campaignBuilder, GET /10dlc/campaign?brandId=,
 *                   GET/PUT/DELETE /10dlc/campaign/{id},
 *                   GET /10dlc/campaign/{id}/operationStatus,
 *                   POST /10dlc/campaign/{id}/appeal
 *   numbers         GET/POST /10dlc/phone_number_campaigns[/{phoneNumber}]
 *   enums           GET /10dlc/enum/{usecase|mno}
 *
 * ⛔ Errors come in THREE shapes on these endpoints — `{errors:[…]}`,
 * 422 `{detail:[{loc,msg}]}`, and a bare `{code,title,detail}` — `registryReason`
 * reads all three.
 * ⛔ Creating writes (brand, campaign, number assignment, appeal, deactivate)
 * are sent EXACTLY ONCE. A timeout is reconciled by re-reading, never by
 * re-sending — a campaign create charges three months up front.
 * ⛔ The EIN passes through `createBrand`/`updateBrand` and is never returned,
 * logged or copied into an error.
 */
import type { StoredTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { txRequest, TelnyxError, classifyError, type TxRequest } from "../telnyx/telnyxClient";

type Creds = StoredTelnyxCredentials;

/** A plain-English reason from any of the three registry error shapes. Never includes request bodies. */
export function registryReason(err: unknown): string {
  if (!(err instanceof TelnyxError)) return String((err as any)?.message || err || "unknown error").slice(0, 400);
  const d: any = err.detail;
  const parts: string[] = [];
  if (Array.isArray(d?.errors)) {
    for (const e of d.errors) parts.push([e?.code, e?.title, e?.detail, e?.source?.pointer].filter(Boolean).join(" "));
  } else if (Array.isArray(d?.detail)) {
    for (const e of d.detail) parts.push([Array.isArray(e?.loc) ? e.loc.join(".") : "", e?.msg].filter(Boolean).join(": "));
  } else if (d && typeof d === "object" && (d.code || d.title || d.detail)) {
    parts.push([d.code, d.title, typeof d.detail === "string" ? d.detail : ""].filter(Boolean).join(" "));
  }
  const text = parts.filter(Boolean).join("; ") || err.userMessage;
  return `${err.status || err.code}: ${text}`.slice(0, 400);
}

/** True when the registry definitely did NOT act (a 4xx refusal), so nothing was charged or created. */
export function isDefiniteRefusal(err: unknown): boolean {
  return err instanceof TelnyxError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

async function call<T = any>(creds: Creds, req: TxRequest): Promise<T> {
  const res = await txRequest<T>(creds, req);
  if (!res.ok) throw classifyError(res);
  return (res.data ?? ({} as T)) as T;
}

/** Some registry endpoints wrap in `data`, some don't. */
function unwrap(body: any): any {
  return body && typeof body === "object" && body.data && !Array.isArray(body.data) ? body.data : body;
}

function reasonsOf(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x?.description || x?.message || JSON.stringify(x))).filter(Boolean);
  if (typeof v === "string") return [v];
  return [JSON.stringify(v)];
}

// ── Brand ───────────────────────────────────────────────────────────────────

export interface BrandInput {
  entityType: string;
  displayName: string;
  companyName: string;
  ein: string | null;
  phone: string;
  email: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  website: string;
  vertical: string;
  firstName?: string | null;
  lastName?: string | null;
  mobilePhone?: string | null;
  webhookURL?: string | null;
}

export interface BrandDetail {
  brandId: string;
  tcrBrandId: string | null;
  identityStatus: string | null;
  status: string | null;
  failureReasons: string[];
  displayName: string | null;
}

function brandBody(input: BrandInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    entityType: input.entityType,
    displayName: input.displayName.slice(0, 100),
    companyName: input.companyName.slice(0, 100),
    phone: input.phone,
    email: input.email.slice(0, 100),
    street: input.street.slice(0, 100),
    city: input.city.slice(0, 100),
    state: input.state.toUpperCase().slice(0, 20),
    postalCode: input.postalCode.slice(0, 5),
    country: "US",
    website: input.website.slice(0, 100),
    vertical: input.vertical,
    isReseller: false,
  };
  if (input.ein) {
    body.ein = input.ein.replace(/\D/g, "");
    body.einIssuingCountry = "US";
  }
  if (input.firstName) body.firstName = input.firstName.slice(0, 100);
  if (input.lastName) body.lastName = input.lastName.slice(0, 100);
  if (input.mobilePhone) body.mobilePhone = input.mobilePhone;
  if (input.webhookURL) body.webhookURL = input.webhookURL;
  return body;
}

export function toBrandDetail(raw: any): BrandDetail {
  const b = unwrap(raw) || {};
  return {
    brandId: String(b.brandId ?? b.id ?? ""),
    tcrBrandId: b.tcrBrandId ? String(b.tcrBrandId) : null,
    identityStatus: b.identityStatus ? String(b.identityStatus).toUpperCase() : null,
    status: b.status ? String(b.status).toUpperCase() : null,
    failureReasons: reasonsOf(b.failureReasons),
    displayName: b.displayName ?? null,
  };
}

export async function createBrand(creds: Creds, input: BrandInput): Promise<BrandDetail> {
  const d = toBrandDetail(await call(creds, { path: "/10dlc/brand", method: "POST", json: brandBody(input), timeoutMs: 60_000 }));
  if (!d.brandId) throw new Error("registry_brand_create_returned_no_id");
  return d;
}

export async function getBrand(creds: Creds, brandId: string): Promise<BrandDetail> {
  return toBrandDetail(await call(creds, { path: `/10dlc/brand/${encodeURIComponent(brandId)}` }));
}

export async function updateBrand(creds: Creds, brandId: string, input: BrandInput): Promise<BrandDetail> {
  return toBrandDetail(
    await call(creds, { path: `/10dlc/brand/${encodeURIComponent(brandId)}`, method: "PUT", json: brandBody(input), timeoutMs: 60_000 }),
  );
}

export async function revetBrand(creds: Creds, brandId: string): Promise<BrandDetail> {
  return toBrandDetail(await call(creds, { path: `/10dlc/brand/${encodeURIComponent(brandId)}/revet`, method: "PUT", timeoutMs: 60_000 }));
}

/** Brands with this exact display name — used ONLY to reconcile a brand create that timed out. */
export async function findBrandsByDisplayName(creds: Creds, displayName: string): Promise<BrandDetail[]> {
  const body: any = await call(creds, { path: "/10dlc/brand", query: { displayName, recordsPerPage: 50 } });
  const rows: any[] = Array.isArray(body?.records) ? body.records : Array.isArray(body?.data) ? body.data : [];
  return rows.map(toBrandDetail).filter((b) => b.brandId && b.displayName === displayName);
}

export interface FeedbackCategory {
  id: string;
  displayName: string;
  description: string;
  fields: string[];
}

export async function getBrandFeedback(creds: Creds, brandId: string): Promise<FeedbackCategory[]> {
  const body: any = unwrap(await call(creds, { path: `/10dlc/brand/feedback/${encodeURIComponent(brandId)}` }));
  const cats: any[] = Array.isArray(body?.category) ? body.category : [];
  return cats.map((c) => ({
    id: String(c?.id ?? ""),
    displayName: String(c?.displayName ?? c?.id ?? ""),
    description: String(c?.description ?? ""),
    fields: Array.isArray(c?.fields) ? c.fields.map(String) : [],
  }));
}

// ── Campaign ────────────────────────────────────────────────────────────────

export interface CampaignInput {
  brandId: string;
  usecase: string;
  subUsecases: string[];
  referenceId: string;
  description: string;
  messageFlow: string;
  sample1: string;
  sample2: string;
  helpMessage: string;
  optoutMessage: string;
  optinMessage: string;
  helpKeywords: string;
  optoutKeywords: string;
  optinKeywords: string;
  privacyPolicyLink: string;
  termsAndConditionsLink: string;
  webhookURL?: string | null;
}

export interface CampaignDetail {
  campaignId: string;
  tcrCampaignId: string | null;
  campaignStatus: string | null;
  submissionStatus: string | null;
  status: string | null;
  failureReasons: string[];
  referenceId: string | null;
  nextRenewalOrExpirationDate: string | null;
}

export function toCampaignDetail(raw: any): CampaignDetail {
  const c = unwrap(raw) || {};
  return {
    campaignId: String(c.campaignId ?? c.id ?? ""),
    tcrCampaignId: c.tcrCampaignId ? String(c.tcrCampaignId) : null,
    campaignStatus: c.campaignStatus ? String(c.campaignStatus).toUpperCase() : null,
    submissionStatus: c.submissionStatus ? String(c.submissionStatus).toUpperCase() : null,
    status: c.status ? String(c.status).toUpperCase() : null,
    failureReasons: reasonsOf(c.failureReasons),
    referenceId: c.referenceId ? String(c.referenceId) : null,
    nextRenewalOrExpirationDate: c.nextRenewalOrExpirationDate ?? null,
  };
}

export async function createCampaign(creds: Creds, input: CampaignInput): Promise<CampaignDetail> {
  const json: Record<string, unknown> = {
    brandId: input.brandId,
    usecase: input.usecase,
    subUsecases: input.subUsecases,
    referenceId: input.referenceId,
    description: input.description,
    messageFlow: input.messageFlow,
    sample1: input.sample1,
    sample2: input.sample2,
    helpMessage: input.helpMessage,
    optoutMessage: input.optoutMessage,
    optinMessage: input.optinMessage,
    helpKeywords: input.helpKeywords,
    optoutKeywords: input.optoutKeywords,
    optinKeywords: input.optinKeywords,
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    embeddedLink: false,
    embeddedPhone: false,
    numberPool: false,
    ageGated: false,
    directLending: false,
    termsAndConditions: true,
    autoRenewal: true,
    privacyPolicyLink: input.privacyPolicyLink,
    termsAndConditionsLink: input.termsAndConditionsLink,
  };
  if (input.webhookURL) json.webhookURL = input.webhookURL;
  const d = toCampaignDetail(await call(creds, { path: "/10dlc/campaignBuilder", method: "POST", json, timeoutMs: 90_000 }));
  if (!d.campaignId) throw new Error("registry_campaign_create_returned_no_id");
  return d;
}

export async function getCampaign(creds: Creds, campaignId: string): Promise<CampaignDetail> {
  return toCampaignDetail(await call(creds, { path: `/10dlc/campaign/${encodeURIComponent(campaignId)}` }));
}

/** Campaigns under a brand — used ONLY to reconcile a campaign create that timed out (match by referenceId). */
export async function listCampaignsForBrand(creds: Creds, brandId: string): Promise<CampaignDetail[]> {
  const body: any = await call(creds, { path: "/10dlc/campaign", query: { brandId, recordsPerPage: 50 } });
  const rows: any[] = Array.isArray(body?.records) ? body.records : Array.isArray(body?.data) ? body.data : [];
  return rows.map(toCampaignDetail).filter((c) => c.campaignId);
}

/** Per-carrier review state: { "10017": "APPROVED", … } keyed by network id. */
export async function getOperationStatus(creds: Creds, campaignId: string): Promise<Record<string, string>> {
  const body: any = unwrap(await call(creds, { path: `/10dlc/campaign/${encodeURIComponent(campaignId)}/operationStatus` }));
  const out: Record<string, string> = {};
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) if (/^\d+$/.test(k) && typeof v === "string") out[k] = v.toUpperCase();
  }
  return out;
}

export async function updateCampaignWording(
  creds: Creds,
  campaignId: string,
  patch: { sample1?: string; sample2?: string; helpMessage?: string; messageFlow?: string },
): Promise<CampaignDetail> {
  return toCampaignDetail(await call(creds, { path: `/10dlc/campaign/${encodeURIComponent(campaignId)}`, method: "PUT", json: patch, timeoutMs: 60_000 }));
}

export async function appealCampaign(creds: Creds, campaignId: string, reason: string): Promise<void> {
  await call(creds, { path: `/10dlc/campaign/${encodeURIComponent(campaignId)}/appeal`, method: "POST", json: { appeal_reason: reason.slice(0, 2000) }, timeoutMs: 60_000 });
}

export async function deactivateCampaign(creds: Creds, campaignId: string): Promise<void> {
  await call(creds, { path: `/10dlc/campaign/${encodeURIComponent(campaignId)}`, method: "DELETE", timeoutMs: 60_000 });
}

// ── Enums ───────────────────────────────────────────────────────────────────

/** Live usecase names — ⛔ the spelling of the low-volume class is read from here, never assumed. */
export async function listUsecases(creds: Creds): Promise<string[]> {
  const body: any = await call(creds, { path: "/10dlc/enum/usecase" });
  const pick = (v: any): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x?.name ?? x?.code ?? x?.usecase ?? "")).filter(Boolean) : [];
  if (Array.isArray(body)) return pick(body);
  if (Array.isArray(body?.data)) return pick(body.data);
  if (body && typeof body === "object") return Object.keys(body);
  return [];
}

export async function qualifyUsecase(creds: Creds, brandId: string, usecase: string): Promise<{ minSubUsecases: number; maxSubUsecases: number; monthlyFee: number | null }> {
  const b: any = unwrap(await call(creds, { path: `/10dlc/campaignBuilder/brand/${encodeURIComponent(brandId)}/usecase/${encodeURIComponent(usecase)}` }));
  return {
    minSubUsecases: Number(b?.minSubUsecases ?? 0) || 0,
    maxSubUsecases: Number(b?.maxSubUsecases ?? 0) || 0,
    monthlyFee: b?.monthlyFee != null ? Number(b.monthlyFee) : null,
  };
}

/** Network id → carrier name. */
export async function listMnoNames(creds: Creds): Promise<Record<string, string>> {
  const body: any = await call(creds, { path: "/10dlc/enum/mno" });
  const out: Record<string, string> = {};
  const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  for (const r of rows) {
    const id = r?.networkId ?? r?.mnoId ?? r?.id;
    const name = r?.displayName ?? r?.name ?? r?.mno;
    if (id != null && name) out[String(id)] = String(name);
  }
  if (!rows.length && body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) {
      if (/^\d+$/.test(k)) out[k] = typeof v === "string" ? v : String((v as any)?.displayName ?? (v as any)?.name ?? k);
    }
  }
  return out;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

export interface NumberAssignment {
  phoneNumber: string;
  campaignId: string | null;
  assignmentStatus: string | null;
  failureReasons: string[];
}

function toAssignment(raw: any): NumberAssignment {
  const a = unwrap(raw) || {};
  return {
    phoneNumber: String(a.phoneNumber ?? ""),
    campaignId: a.telnyxCampaignId ? String(a.telnyxCampaignId) : a.campaignId ? String(a.campaignId) : null,
    assignmentStatus: a.assignmentStatus ? String(a.assignmentStatus).toUpperCase() : null,
    failureReasons: reasonsOf(a.failureReasons),
  };
}

/** The number's current campaign assignment, or null when it has none (404). */
export async function getNumberAssignment(creds: Creds, e164: string): Promise<NumberAssignment | null> {
  try {
    return toAssignment(await call(creds, { path: `/10dlc/phone_number_campaigns/${encodeURIComponent(e164)}` }));
  } catch (err) {
    if (err instanceof TelnyxError && err.status === 404) return null;
    throw err;
  }
}

export async function assignNumber(creds: Creds, e164: string, campaignId: string): Promise<NumberAssignment> {
  return toAssignment(await call(creds, { path: "/10dlc/phone_number_campaigns", method: "POST", json: { phoneNumber: e164, campaignId }, timeoutMs: 45_000 }));
}

// ── Sole proprietor PIN ─────────────────────────────────────────────────────

/** Texts the owner a 6-digit PIN (24h). `pinSms` MUST contain @OTP_PIN@. Safe to call again as a resend. */
export async function sendBrandPin(creds: Creds, brandId: string, pinSms: string, successSms: string): Promise<{ referenceId: string | null }> {
  if (!pinSms.includes("@OTP_PIN@")) throw new Error("pin_template_missing_placeholder");
  const body: any = unwrap(
    await call(creds, { path: `/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`, method: "POST", json: { pinSms, successSms }, timeoutMs: 45_000 }),
  );
  return { referenceId: body?.referenceId ? String(body.referenceId) : null };
}

/** 204 on success; a wrong/expired PIN is a 4xx refusal. */
export async function verifyBrandPin(creds: Creds, brandId: string, otpPin: string): Promise<void> {
  await call(creds, { path: `/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`, method: "PUT", json: { otpPin }, timeoutMs: 45_000 });
}
