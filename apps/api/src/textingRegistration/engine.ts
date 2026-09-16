/**
 * The texting-registration engine (2026-09-16): customer link → submission →
 * staff files with Telnyx → registry re-checks → numbers attach → live.
 *
 * Izzy's design (mockups V3, docs/ai-context/AGENT_HANDOFF_TELNYX_10DLC_2026-09-16.md):
 * the customer fills in only what we need from them; platform staff press
 * "File with Telnyx"; everything after that runs unattended.
 *
 * ⛔ RULES THIS FILE KEEPS
 * 1. States advance ONLY from a fresh read of the registry. A webhook is a
 *    trigger to re-read, never a source of truth.
 * 2. Creating writes are sent EXACTLY ONCE, guarded by a conditional update
 *    (`…StartedAt` set only while it is null), so a double-press, two sweeps
 *    or a webhook racing the sweep cannot file twice. A timeout is reconciled
 *    by listing (brands by display name, campaigns by referenceId), never by
 *    resending — after RECONCILE_GIVE_UP_MS with nothing found, the row goes to
 *    `error` for a person. Campaign create charges three months up front.
 * 3. The EIN exists only as a token (tokens.ts). It is opened for the brand
 *    call and destroyed the moment the registry verifies the business.
 * 4. Customer-facing wording never names a carrier.
 * 5. Rows of the sign-up wizard's TenantSmsRegistration are never touched; a
 *    tenant the wizard already filed at Telnyx is refused (one brand per EIN).
 */
import {
  buildCampaignContent,
  buildPrivacyPolicy,
  buildSmsTerms,
  checksBlockFiling,
  cleanName,
  normalizeEin,
  runFilingChecks,
  slugify,
  validateCustomerAnswers,
  type BusinessFacts,
  type CampaignContent,
  type Check,
  type CustomerAnswers,
} from "./content";
import {
  CONVERSATIONAL_SUB_USECASES,
  NEEDS_STAFF,
  STATUS_LABEL,
  SWEEP_STATUSES,
  assignmentPhase,
  brandPhase,
  campaignPhase,
  carrierReviews,
  pickConversationalUsecase,
  type RegistrationStatus,
} from "./phases";
import * as registry from "./registryClient";
import { detokenizeEin, einTokenExpired, hashLinkToken, isWellFormedLinkToken, linkExpiry, linkState, newLinkToken, tokenizeEin } from "./tokens";

export const RECONCILE_GIVE_UP_MS = 20 * 60_000;
export const REGISTRATION_CHARGE_CENTS = 2400;
export const REGISTRATION_CHARGE_DESCRIPTION = "Business texting (10DLC) registration";
export const PIN_ATTEMPT_LIMIT = 5;

export type Db = any;

export interface EngineDeps {
  db: Db;
  resolveCreds: () => Promise<any | null>;
  registry: typeof registry;
  now: () => Date;
  portalOrigin: () => string;
  publicApiBase: () => string;
  /** Adds the one-time registration charge; returns a reference (invoice number). */
  addRegistrationCharge?: (tenantId: string, registrationId: string, actorUserId: string | null) => Promise<string>;
  /** Queues a customer email (never ADMIN_ALERT). */
  queueEmail?: (email: { tenantId: string; type: string; to: string; subject: string; html: string; text: string }) => Promise<void>;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

export class RegistrationError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

export function policyUrls(portalOrigin: string, slug: string): { privacyUrl: string; termsUrl: string } {
  const base = `${portalOrigin.replace(/\/+$/, "")}/texting-policy/${encodeURIComponent(slug)}`;
  return { privacyUrl: base, termsUrl: `${base}#terms` };
}

export function webhookUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}/webhooks/telnyx/10dlc`;
}

export function factsOf(reg: any, portalOrigin: string): BusinessFacts {
  return {
    displayName: reg.displayName,
    legalName: reg.legalName,
    businessPhone: reg.businessPhone,
    businessEmail: reg.businessEmail,
    ...policyUrls(portalOrigin, reg.publicSlug),
  };
}

export function contentOf(reg: any, portalOrigin: string): CampaignContent {
  const generated = buildCampaignContent(factsOf(reg, portalOrigin));
  const stored = reg.content && typeof reg.content === "object" ? reg.content : {};
  const out: any = { ...generated };
  for (const k of Object.keys(generated)) if (typeof stored[k] === "string" && stored[k].trim()) out[k] = stored[k];
  return out;
}

export function answersOf(reg: any): Partial<CustomerAnswers> {
  return {
    legalName: reg.legalName ?? "",
    entityType: reg.entityType ?? "",
    ein: null,
    street: reg.street ?? "",
    city: reg.city ?? "",
    state: reg.state ?? "",
    postalCode: reg.postalCode ?? "",
    website: reg.website ?? "",
  };
}

async function event(db: Db, registrationId: string, kind: string, message: string, actorUserId?: string | null, detail?: unknown): Promise<void> {
  await db.textingRegistrationEvent.create({ data: { registrationId, kind, message: message.slice(0, 500), actorUserId: actorUserId ?? null, detail: (detail ?? undefined) as any } });
}

function digits10(raw: string | null | undefined): string {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d.slice(-10);
}

function e164(raw: string | null | undefined): string | null {
  const d = digits10(raw);
  return d.length === 10 ? `+1${d}` : null;
}

// ── Prefill + create ────────────────────────────────────────────────────────

export interface Prefill {
  displayName: string;
  businessPhone: string;
  businessEmail: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  numbers: string[];
}

export async function loadPrefill(db: Db, tenantId: string): Promise<Prefill> {
  const [tenant, settings, owner, submission, smsNumbers] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }),
    db.tenantBillingSettings.findUnique({ where: { tenantId } }).catch(() => null),
    db.user.findFirst({ where: { tenantId, status: "ACTIVE", role: "TENANT_ADMIN" }, orderBy: { createdAt: "asc" }, select: { email: true, firstName: true, lastName: true, phone: true } }).catch(() => null),
    db.onboardingSubmission.findFirst({ where: { createdTenantId: tenantId }, orderBy: { createdAt: "desc" }, select: { companyName: true, contactFirstName: true, contactLastName: true, mainEmail: true, mainPhone: true } }).catch(() => null),
    db.tenantSmsNumber.findMany({ where: { tenantId, active: true }, select: { phoneE164: true }, orderBy: { createdAt: "asc" } }).catch(() => []),
  ]);
  if (!tenant) throw new RegistrationError("tenant_not_found", "That customer does not exist.", 404);
  const displayName = cleanName(settings?.invoiceCompanyName) || cleanName(submission?.companyName) || cleanName(tenant.name);
  const businessPhone = digits10(settings?.invoiceSupportPhone) || digits10(submission?.mainPhone) || digits10(owner?.phone) || digits10(smsNumbers[0]?.phoneE164) || "";
  const businessEmail = String(settings?.invoiceSupportEmail || settings?.billingEmail || submission?.mainEmail || owner?.email || "").trim();
  return {
    displayName,
    businessPhone,
    businessEmail,
    contactFirstName: cleanName(owner?.firstName) || cleanName(submission?.contactFirstName) || null,
    contactLastName: cleanName(owner?.lastName) || cleanName(submission?.contactLastName) || null,
    numbers: smsNumbers.map((n: any) => n.phoneE164).filter(Boolean),
  };
}

async function uniqueSlug(db: Db, base: string): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const taken = await db.textingRegistration.findUnique({ where: { publicSlug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** One open registration per customer. Returns the existing one when there is one. */
export async function createRegistration(deps: EngineDeps, tenantId: string, actorUserId: string | null): Promise<any> {
  const { db } = deps;
  const existing = await db.textingRegistration.findFirst({ where: { tenantId, status: { not: "deactivated" } }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;
  const wizard = await db.tenantSmsRegistration
    .findFirst({ where: { tenantId, provider: "telnyx", brandId: { not: null } }, select: { id: true } })
    .catch(() => null);
  if (wizard) {
    throw new RegistrationError("already_registered_by_signup", "This customer's business was already registered for texting during sign-up. A second registration would be refused (one registration per EIN).", 409);
  }
  const p = await loadPrefill(db, tenantId);
  if (!p.displayName) throw new RegistrationError("missing_business_name", "This customer has no business name on the account. Add one in billing settings first.");
  const slug = await uniqueSlug(db, p.displayName);
  const reg = await db.textingRegistration.create({
    data: {
      tenantId,
      status: "draft",
      publicSlug: slug,
      referenceKey: `loopcom-10dlc-${slug}-${deps.now().getTime().toString(36)}`,
      displayName: p.displayName.slice(0, 100),
      businessPhone: p.businessPhone,
      businessEmail: p.businessEmail,
      contactFirstName: p.contactFirstName,
      contactLastName: p.contactLastName,
      numbers: p.numbers,
      content: {},
      createdByUserId: actorUserId,
    },
  });
  await event(db, reg.id, "created", "Registration created", actorUserId);
  return reg;
}

// ── Customer links ──────────────────────────────────────────────────────────

export async function createLink(deps: EngineDeps, registrationId: string, actorUserId: string | null): Promise<{ url: string; linkId: string; expiresAt: Date }> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
  if (!["draft", "awaiting_customer", "needs_fix", "submitted"].includes(reg.status)) {
    throw new RegistrationError("link_not_allowed", `A customer link can't be created while the registration is "${STATUS_LABEL[reg.status as RegistrationStatus] || reg.status}".`, 409);
  }
  const now = deps.now();
  const { token, hash } = newLinkToken();
  const expiresAt = linkExpiry(now);
  await db.textingRegistrationLink.updateMany({ where: { registrationId, revokedAt: null, usedAt: null }, data: { revokedAt: now } });
  const link = await db.textingRegistrationLink.create({ data: { registrationId, tokenHash: hash, expiresAt, createdByUserId: actorUserId } });
  if (reg.status === "draft" || reg.status === "submitted") {
    await db.textingRegistration.update({ where: { id: registrationId }, data: { status: reg.status === "draft" ? "awaiting_customer" : reg.status } });
  }
  await event(db, registrationId, "link_created", "Customer link created (older links turned off)", actorUserId);
  return { url: `${deps.portalOrigin().replace(/\/+$/, "")}/texting-registration/${token}`, linkId: link.id, expiresAt };
}

export async function revokeLinks(deps: EngineDeps, registrationId: string, actorUserId: string | null): Promise<number> {
  const r = await deps.db.textingRegistrationLink.updateMany({ where: { registrationId, revokedAt: null, usedAt: null }, data: { revokedAt: deps.now() } });
  if (r.count) await event(deps.db, registrationId, "link_revoked", "Customer link turned off", actorUserId);
  return r.count;
}

export type PublicLinkResult =
  | { state: "ok"; link: any; reg: any }
  | { state: "expired" | "revoked" | "used" | "not_found"; reg: any | null };

export async function resolvePublicLink(deps: EngineDeps, token: string): Promise<PublicLinkResult> {
  if (!isWellFormedLinkToken(token)) return { state: "not_found", reg: null };
  const link = await deps.db.textingRegistrationLink.findUnique({ where: { tokenHash: hashLinkToken(token) }, include: { registration: true } });
  if (!link) return { state: "not_found", reg: null };
  const reg = link.registration;
  // A sole proprietor's used link stays usable for the PIN step only.
  const st = linkState(link, deps.now());
  if (st === "used" && reg.status === "awaiting_pin") return { state: "ok", link, reg };
  if (st !== "ok") return { state: st, reg };
  if (!link.openedAt) {
    await deps.db.textingRegistrationLink.update({ where: { id: link.id }, data: { openedAt: deps.now() } });
    await event(deps.db, reg.id, "link_opened", "Customer opened the link");
  }
  return { state: "ok", link, reg };
}

/** Everything the customer page shows. ⛔ Never the EIN, never a carrier name, never staff notes beyond fixNote. */
export function publicView(deps: Pick<EngineDeps, "portalOrigin">, reg: any, opts: { einOnFile: boolean }) {
  const facts = factsOf(reg, deps.portalOrigin());
  const content = contentOf(reg, deps.portalOrigin());
  const fixFields: string[] | null = Array.isArray(reg.fixFields) ? reg.fixFields : null;
  const phase =
    reg.status === "awaiting_pin" ? "pin" :
    ["awaiting_customer", "needs_fix", "draft"].includes(reg.status) ? "form" : "sent";
  return {
    phase,
    displayName: reg.displayName,
    businessPhone: reg.businessPhone,
    businessEmail: reg.businessEmail,
    contactName: [reg.contactFirstName, reg.contactLastName].filter(Boolean).join(" ") || null,
    numbers: Array.isArray(reg.numbers) ? reg.numbers : [],
    answers: { ...answersOf(reg), mobilePhone: reg.mobilePhone ?? "" },
    einOnFile: opts.einOnFile,
    fixFields,
    fixNote: fixFields ? reg.fixNote ?? null : null,
    submittedAt: reg.submittedAt,
    signatureName: phase === "sent" ? reg.signatureName : null,
    wording: {
      description: content.description,
      sample1: content.sample1,
      sample2: content.sample2,
      optinFlow: content.messageFlow,
      helpMessage: content.helpMessage,
      optoutMessage: content.optoutMessage,
      optinMessage: content.optinMessage,
      optoutKeywords: content.optoutKeywords,
      helpKeywords: content.helpKeywords,
    },
    privacyUrl: facts.privacyUrl,
    termsUrl: facts.termsUrl,
  };
}

const CUSTOMER_FIELDS = ["legalName", "entityType", "ein", "street", "city", "state", "postalCode", "website", "mobilePhone"] as const;

function pickAnswers(body: any, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allowed) if (k !== "ein" && typeof body?.[k] === "string") out[k] = body[k].slice(0, 200);
  return out;
}

function allowedFields(reg: any): string[] {
  return Array.isArray(reg.fixFields) && reg.fixFields.length ? reg.fixFields.filter((f: string) => (CUSTOMER_FIELDS as readonly string[]).includes(f)) : [...CUSTOMER_FIELDS];
}

/** Autosave while the customer types. ⛔ The EIN is never part of a draft. */
export async function saveDraft(deps: EngineDeps, token: string, body: any): Promise<void> {
  const r = await resolvePublicLink(deps, token);
  if (r.state !== "ok" || !["awaiting_customer", "needs_fix", "draft"].includes(r.reg.status)) throw new RegistrationError("link_unavailable", "This link can no longer be edited.", 410);
  const data = pickAnswers(body, allowedFields(r.reg));
  if (data.state) data.state = data.state.toUpperCase();
  if (Object.keys(data).length) await deps.db.textingRegistration.update({ where: { id: r.reg.id }, data });
}

export async function submitCustomerForm(
  deps: EngineDeps,
  token: string,
  body: any,
  meta: { ip: string | null },
): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
  const { db } = deps;
  const r = await resolvePublicLink(deps, token);
  if (r.state !== "ok") throw new RegistrationError("link_unavailable", "This link is no longer active.", 410);
  const reg = r.reg;
  if (!["awaiting_customer", "needs_fix", "draft"].includes(reg.status)) throw new RegistrationError("already_sent", "This registration was already sent.", 409);

  const allowed = allowedFields(reg);
  const merged: any = { ...answersOf(reg), mobilePhone: reg.mobilePhone ?? "", ...pickAnswers(body, allowed) };
  merged.state = String(merged.state || "").toUpperCase();
  const existingEin = await db.textingRegistrationEin.findUnique({ where: { registrationId: reg.id } });
  const einTyped = allowed.includes("ein") ? normalizeEin(body?.ein) : null;
  const einRequired = merged.entityType !== "SOLE_PROPRIETOR" && !(existingEin && !allowed.includes("ein"));
  const errors = validateCustomerAnswers({ ...merged, ein: einTyped ?? (existingEin && !allowed.includes("ein") ? "000000000" : null) }, { einRequired });
  if (merged.entityType === "SOLE_PROPRIETOR" && !e164(merged.mobilePhone)) errors.mobilePhone = "Enter the mobile number where the owner can receive a text.";
  const signature = cleanName(body?.signatureName);
  if (signature.length < 2) errors.signatureName = "Type your full name to sign.";
  if (body?.consent !== true) errors.consent = "Tick the box to confirm you're authorized to register this business.";
  if (Object.keys(errors).length) return { ok: false, errors };

  const now = deps.now();
  const data: any = {};
  for (const k of allowed) if (k !== "ein") data[k] = merged[k];
  data.mobilePhone = merged.entityType === "SOLE_PROPRIETOR" ? e164(merged.mobilePhone) : null;
  data.signatureName = signature.slice(0, 120);
  data.consentAt = now;
  data.submittedAt = now;
  data.submittedIp = meta.ip ? String(meta.ip).slice(0, 64) : null;
  data.status = "submitted";
  data.fixFields = null;
  data.fixNote = null;

  // Claim the link first: two tabs pressing Send at once produce one submission.
  const claimed = await db.textingRegistrationLink.updateMany({ where: { id: r.link.id, usedAt: null, revokedAt: null }, data: { usedAt: now } });
  if (!claimed.count) throw new RegistrationError("already_sent", "This registration was already sent.", 409);

  if (einTyped) {
    const t = tokenizeEin(einTyped, reg.id);
    await db.textingRegistrationEin.upsert({ where: { registrationId: reg.id }, create: { registrationId: reg.id, token: t.token, last4: t.last4, createdAt: now }, update: { token: t.token, last4: t.last4, createdAt: now } });
  } else if (merged.entityType === "SOLE_PROPRIETOR") {
    await db.textingRegistrationEin.deleteMany({ where: { registrationId: reg.id } });
  }
  await db.textingRegistration.update({ where: { id: reg.id }, data });
  await event(db, reg.id, "customer_submitted", `Sent by ${signature}`, null, { fields: allowed.filter((f) => f !== "ein"), einUpdated: !!einTyped });
  return { ok: true };
}

// ── Staff: review, edit, send back ──────────────────────────────────────────

export async function registrationChecks(deps: EngineDeps, reg: any): Promise<Check[]> {
  const ein = await deps.db.textingRegistrationEin.findUnique({ where: { registrationId: reg.id }, select: { registrationId: true } });
  const numbers = await telnyxNumbersFor(deps, reg.tenantId);
  return runFilingChecks({
    facts: factsOf(reg, deps.portalOrigin()),
    answers: answersOf(reg),
    content: contentOf(reg, deps.portalOrigin()),
    einPresent: !!ein || !!reg.telnyxBrandId,
    numbersOnTelnyx: numbers.length,
  });
}

export async function telnyxNumbersFor(deps: EngineDeps, tenantId: string): Promise<string[]> {
  const rows = await deps.db.tenantSmsNumber.findMany({ where: { tenantId, active: true, provider: "TELNYX" }, select: { phoneE164: true } });
  return rows.map((r: any) => r.phoneE164).filter(Boolean);
}

const EDITABLE_CONTENT = ["description", "messageFlow", "sample1", "sample2", "helpMessage", "optoutMessage", "optinMessage"] as const;
const EDITABLE_AFTER_FILING = ["sample1", "sample2", "helpMessage", "messageFlow"] as const;

export async function updateContent(deps: EngineDeps, registrationId: string, patch: Record<string, unknown>, actorUserId: string | null): Promise<any> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
  const filed = !!reg.telnyxCampaignId;
  const allowed: readonly string[] = filed ? EDITABLE_AFTER_FILING : EDITABLE_CONTENT;
  const next: any = { ...(reg.content && typeof reg.content === "object" ? reg.content : {}) };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k)) {
      if ((EDITABLE_CONTENT as readonly string[]).includes(k)) throw new RegistrationError("locked_after_filing", `"${k}" can't be changed after the campaign is filed. Only sample messages, the HELP reply and the opt-in description can.`, 409);
      continue;
    }
    if (typeof v !== "string") continue;
    const clean = v.trim();
    if (clean === String(next[k] ?? "")) continue;
    next[k] = clean || undefined;
    changed.push(k);
  }
  if (!changed.length) return reg;
  if (filed) {
    const creds = await deps.resolveCreds();
    if (!creds) throw new RegistrationError("telnyx_not_configured", "Telnyx isn't connected.", 503);
    const content = { ...contentOf({ ...reg, content: next }, deps.portalOrigin()) } as any;
    const body: any = {};
    for (const k of changed) body[k] = content[k];
    try {
      await deps.registry.updateCampaignWording(creds, reg.telnyxCampaignId, body);
    } catch (err) {
      throw new RegistrationError("registry_refused", `Telnyx refused the change: ${deps.registry.registryReason(err)}`, 502);
    }
  }
  const updated = await db.textingRegistration.update({ where: { id: registrationId }, data: { content: next } });
  await event(db, registrationId, "content_edited", `Wording edited: ${changed.join(", ")}${filed ? " (sent to Telnyx)" : ""}`, actorUserId);
  return updated;
}

/** Staff fill in / correct the customer's answers ("Fill it in myself"). */
export async function staffUpdateBusiness(deps: EngineDeps, registrationId: string, body: any, actorUserId: string | null): Promise<any> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
  if (!["draft", "awaiting_customer", "needs_fix", "submitted", "brand_failed"].includes(reg.status)) {
    throw new RegistrationError("locked", "Business details can't be edited at this stage.", 409);
  }
  const data: any = pickAnswers(body, CUSTOMER_FIELDS);
  if (data.state) data.state = data.state.toUpperCase();
  for (const k of ["displayName", "businessPhone", "businessEmail", "vertical"] as const) {
    if (typeof body?.[k] === "string" && body[k].trim()) data[k] = body[k].trim().slice(0, 100);
  }
  if (data.businessPhone) data.businessPhone = digits10(data.businessPhone);
  if (typeof body?.mobilePhone === "string") data.mobilePhone = e164(body.mobilePhone);
  const ein = normalizeEin(body?.ein);
  if (body?.ein && !ein) throw new RegistrationError("ein_invalid", "Enter all 9 digits of the EIN.");
  if (body?.markSubmitted === true) {
    data.status = "submitted";
    data.submittedAt = deps.now();
    data.signatureName = cleanName(body?.signatureName) || reg.signatureName || "Entered by Loopcom staff";
    data.consentAt = reg.consentAt ?? deps.now();
    data.fixFields = null;
    data.fixNote = null;
  }
  if (ein) {
    const t = tokenizeEin(ein, reg.id);
    await db.textingRegistrationEin.upsert({ where: { registrationId: reg.id }, create: { registrationId: reg.id, token: t.token, last4: t.last4 }, update: { token: t.token, last4: t.last4, createdAt: deps.now() } });
  }
  const updated = await db.textingRegistration.update({ where: { id: registrationId }, data });
  const fields = Object.keys(data).filter((k) => !["status", "submittedAt", "consentAt", "fixFields", "fixNote"].includes(k));
  await event(db, registrationId, "staff_edited", `Business details edited by staff${fields.length ? `: ${fields.join(", ")}` : ""}${ein ? " (EIN re-entered)" : ""}${body?.markSubmitted ? "; marked ready to file" : ""}`, actorUserId);
  return updated;
}

export async function revealEin(deps: EngineDeps, registrationId: string, actorUserId: string | null): Promise<string> {
  const row = await deps.db.textingRegistrationEin.findUnique({ where: { registrationId } });
  if (!row) throw new RegistrationError("no_ein", "No EIN is on file. It is deleted once the business is verified.", 404);
  const ein = detokenizeEin(row.token, registrationId);
  if (!ein) throw new RegistrationError("ein_unreadable", "The stored EIN token could not be opened. Ask the customer to enter it again.", 500);
  await event(deps.db, registrationId, "ein_revealed", "EIN shown to staff", actorUserId);
  return `${ein.slice(0, 2)}-${ein.slice(2)}`;
}

export async function sendBackToCustomer(deps: EngineDeps, registrationId: string, fields: string[], note: string, actorUserId: string | null): Promise<any> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
  if (!["submitted", "brand_failed", "needs_fix", "awaiting_customer"].includes(reg.status)) {
    throw new RegistrationError("not_allowed", "This registration can't be sent back at this stage.", 409);
  }
  const clean = Array.from(new Set((fields || []).filter((f) => (CUSTOMER_FIELDS as readonly string[]).includes(f))));
  if (!clean.length) throw new RegistrationError("no_fields", "Choose at least one field for the customer to fix.");
  const text = String(note || "").trim();
  if (text.length < 5) throw new RegistrationError("no_note", "Write a short note telling the customer what to fix.");
  // Changing the legal name, type or address on an existing brand needs the EIN again.
  if (reg.telnyxBrandId && !clean.includes("ein") && clean.some((f) => ["legalName", "entityType"].includes(f))) clean.push("ein");
  const updated = await db.textingRegistration.update({ where: { id: registrationId }, data: { status: "needs_fix", fixFields: clean, fixNote: text.slice(0, 1000) } });
  await event(db, registrationId, "sent_back", `Sent back to the customer to fix: ${clean.join(", ")}`, actorUserId, { note: text.slice(0, 1000) });
  return updated;
}

// ── Filing ──────────────────────────────────────────────────────────────────

function brandInputFor(reg: any, ein: string | null, apiBase: string): registry.BrandInput {
  const sole = reg.entityType === "SOLE_PROPRIETOR";
  return {
    entityType: reg.entityType,
    displayName: reg.displayName,
    companyName: sole ? cleanName(reg.legalName) : cleanName(reg.legalName),
    ein: sole ? null : ein,
    phone: `+1${digits10(reg.businessPhone)}`,
    email: reg.businessEmail,
    street: reg.street,
    city: reg.city,
    state: reg.state,
    postalCode: reg.postalCode,
    website: reg.website,
    vertical: reg.vertical || "PROFESSIONAL",
    firstName: reg.contactFirstName || (sole ? cleanName(reg.legalName).split(" ")[0] : null),
    lastName: reg.contactLastName || (sole ? cleanName(reg.legalName).split(" ").slice(1).join(" ") || null : null),
    mobilePhone: sole ? reg.mobilePhone : null,
    webhookURL: webhookUrl(apiBase),
  };
}

export async function fileWithTelnyx(deps: EngineDeps, registrationId: string, actorUserId: string | null): Promise<any> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
  if (reg.status !== "submitted") throw new RegistrationError("not_ready", `Only a registration that is "Ready to file" can be filed (this one is "${STATUS_LABEL[reg.status as RegistrationStatus] || reg.status}").`, 409);
  const checks = await registrationChecks(deps, reg);
  if (checksBlockFiling(checks)) {
    throw new RegistrationError("checks_failed", `Fix these before filing: ${checks.filter((c) => c.level === "fail").map((c) => c.message).join(" · ")}`, 422);
  }
  const creds = await deps.resolveCreds();
  if (!creds) throw new RegistrationError("telnyx_not_configured", "Telnyx isn't connected. Save the API key on the Telnyx page first.", 503);

  const sole = reg.entityType === "SOLE_PROPRIETOR";
  let ein: string | null = null;
  if (!sole) {
    const row = await db.textingRegistrationEin.findUnique({ where: { registrationId } });
    ein = row ? detokenizeEin(row.token, registrationId) : null;
    if (!ein && !reg.telnyxBrandId) throw new RegistrationError("no_ein", "No EIN on file. Send the registration back to the customer to enter it.", 409);
  }

  const now = deps.now();
  // ⛔ The claim: only one press can move submitted → filing.
  const claim = await db.textingRegistration.updateMany({
    where: { id: registrationId, status: "submitted" },
    data: { status: "filing", filedAt: reg.filedAt ?? now, filedByUserId: actorUserId, lastError: null, ...(reg.telnyxBrandId ? {} : { brandCreateStartedAt: now }) },
  });
  if (!claim.count) throw new RegistrationError("already_filing", "Someone already pressed File on this registration.", 409);
  await event(db, registrationId, "filing", reg.telnyxBrandId ? "Filing the corrected business details with Telnyx" : "Filing with Telnyx", actorUserId);

  const input = brandInputFor(reg, ein, deps.publicApiBase());
  try {
    const brand = reg.telnyxBrandId
      ? await deps.registry.updateBrand(creds, reg.telnyxBrandId, input)
      : await deps.registry.createBrand(creds, input);
    await db.textingRegistration.update({
      where: { id: registrationId },
      data: { telnyxBrandId: brand.brandId, tcrBrandId: brand.tcrBrandId, brandIdentityStatus: brand.identityStatus, brandStatus: brand.status, status: "brand_review", brandFeedback: null, lastCheckedAt: deps.now() },
    });
    await event(db, registrationId, reg.telnyxBrandId ? "brand_updated" : "brand_created", reg.telnyxBrandId ? "Business details updated at Telnyx" : "Business (brand) created at Telnyx", actorUserId, { brandId: brand.brandId });
    if (!reg.telnyxBrandId) await addChargeOnce(deps, registrationId, actorUserId);
    if (reg.telnyxBrandId) {
      try {
        await deps.registry.revetBrand(creds, reg.telnyxBrandId);
        await event(db, registrationId, "brand_revet", "Asked the registry to check the business again", actorUserId);
      } catch (err) {
        await event(db, registrationId, "brand_revet_refused", `Re-check request refused: ${deps.registry.registryReason(err)}`, actorUserId);
      }
    }
  } catch (err) {
    const reason = deps.registry.registryReason(err);
    if (deps.registry.isDefiniteRefusal(err)) {
      await db.textingRegistration.update({ where: { id: registrationId }, data: { status: "submitted", brandCreateStartedAt: reg.telnyxBrandId ? reg.brandCreateStartedAt : null, lastError: `Telnyx refused the business details: ${reason}` } });
      await event(db, registrationId, "filing_refused", `Telnyx refused the business details: ${reason}`, actorUserId);
      throw new RegistrationError("registry_refused", `Telnyx refused the business details: ${reason}`, 422);
    }
    // Timeout / network / 5xx: it MAY have happened. The sweep reconciles by listing — never resends.
    await db.textingRegistration.update({ where: { id: registrationId }, data: { lastError: `Telnyx did not confirm the filing (${reason}). Checking again automatically.` } });
    await event(db, registrationId, "filing_uncertain", `Telnyx did not confirm the filing (${reason}); reconciling`, actorUserId);
    return db.textingRegistration.findUnique({ where: { id: registrationId } });
  }
  return advanceRegistration(deps, registrationId);
}

async function addChargeOnce(deps: EngineDeps, registrationId: string, actorUserId: string | null): Promise<void> {
  if (!deps.addRegistrationCharge) return;
  const { db } = deps;
  const claim = await db.textingRegistration.updateMany({ where: { id: registrationId, chargeAddedAt: null }, data: { chargeAddedAt: deps.now() } });
  if (!claim.count) return;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  try {
    const ref = await deps.addRegistrationCharge(reg.tenantId, registrationId, actorUserId);
    await db.textingRegistration.update({ where: { id: registrationId }, data: { chargeReference: ref } });
    await event(db, registrationId, "charge_added", `Registration charge added for the customer (${ref})`, actorUserId);
  } catch (err: any) {
    await db.textingRegistration.update({ where: { id: registrationId }, data: { chargeAddedAt: null } });
    await event(db, registrationId, "charge_failed", `Could not add the registration charge: ${String(err?.message || err).slice(0, 200)}`, actorUserId);
    deps.log?.error({ err: String(err?.message || err), registrationId }, "texting_registration_charge_failed");
  }
}

// ── Advancing from the registry ─────────────────────────────────────────────

let usecaseCache: { value: string; at: number } | null = null;
let mnoCache: { value: Record<string, string>; at: number } | null = null;
export function resetRegistryCaches(): void {
  usecaseCache = null;
  mnoCache = null;
}

async function conversationalUsecase(deps: EngineDeps, creds: any): Promise<string> {
  const now = deps.now().getTime();
  if (usecaseCache && now - usecaseCache.at < 6 * 3600_000) return usecaseCache.value;
  const list = await deps.registry.listUsecases(creds);
  const picked = pickConversationalUsecase(list);
  if (!picked) throw new Error(`registry_has_no_low_volume_usecase (saw: ${list.slice(0, 20).join(",")})`);
  usecaseCache = { value: picked, at: now };
  return picked;
}

async function mnoNames(deps: EngineDeps, creds: any): Promise<Record<string, string>> {
  const now = deps.now().getTime();
  if (mnoCache && now - mnoCache.at < 24 * 3600_000) return mnoCache.value;
  const names = await deps.registry.listMnoNames(creds).catch(() => ({}));
  mnoCache = { value: names, at: now };
  return names;
}

const PIN_SMS = (name: string) => `${name.slice(0, 60)}: your texting registration code is @OTP_PIN@. Enter it on your registration page. It expires in 24 hours.`;
const PIN_SUCCESS_SMS = (name: string) => `${name.slice(0, 60)}: thank you, your texting registration is verified.`;

/**
 * One check per registration at a time in this process: the sweep, a webhook
 * and a staff "Check now" arriving together share the SAME run instead of
 * each attaching numbers or filing a campaign. (The creating writes also carry
 * their own conditional-update claims, so a second api instance during a
 * blue/green deploy still cannot double-create a brand or campaign.)
 */
const inFlight = new Map<string, Promise<any>>();

export function advanceRegistration(deps: EngineDeps, registrationId: string): Promise<any> {
  const running = inFlight.get(registrationId);
  if (running) return running;
  const p = advanceOnce(deps, registrationId).finally(() => inFlight.delete(registrationId));
  inFlight.set(registrationId, p);
  return p;
}

async function advanceOnce(deps: EngineDeps, registrationId: string): Promise<any> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg || !(SWEEP_STATUSES as string[]).includes(reg.status)) return reg;
  const creds = await deps.resolveCreds();
  if (!creds) return reg;
  const now = deps.now();
  try {
    switch (reg.status as RegistrationStatus) {
      case "filing":
        return await reconcileBrandCreate(deps, creds, reg);
      case "awaiting_pin":
      case "brand_review":
        return await advanceBrand(deps, creds, reg);
      case "campaign_review":
        return await advanceCampaign(deps, creds, reg);
      case "assigning":
      case "live":
        return await advanceNumbers(deps, creds, reg);
      default:
        return reg;
    }
  } catch (err) {
    const reason = deps.registry.registryReason(err);
    await db.textingRegistration.update({ where: { id: registrationId }, data: { lastError: `Last check failed: ${reason}`, lastCheckedAt: now } });
    deps.log?.warn({ registrationId, reason }, "texting_registration_check_failed");
    return db.textingRegistration.findUnique({ where: { id: registrationId } });
  }
}

async function reconcileBrandCreate(deps: EngineDeps, creds: any, reg: any): Promise<any> {
  const { db } = deps;
  if (reg.telnyxBrandId) {
    await db.textingRegistration.update({ where: { id: reg.id }, data: { status: "brand_review" } });
    return advanceBrand(deps, creds, { ...reg, status: "brand_review" });
  }
  const started = reg.brandCreateStartedAt ? new Date(reg.brandCreateStartedAt).getTime() : 0;
  const found = (await deps.registry.findBrandsByDisplayName(creds, reg.displayName)).filter((b) => b.brandId);
  const taken = new Set(
    (await db.textingRegistration.findMany({ where: { telnyxBrandId: { in: found.map((b) => b.brandId) } }, select: { telnyxBrandId: true } })).map((r: any) => r.telnyxBrandId),
  );
  const candidates = found.filter((b) => !taken.has(b.brandId));
  if (candidates.length === 1) {
    const b = candidates[0];
    await db.textingRegistration.update({ where: { id: reg.id }, data: { telnyxBrandId: b.brandId, tcrBrandId: b.tcrBrandId, brandIdentityStatus: b.identityStatus, brandStatus: b.status, status: "brand_review", lastError: null, lastCheckedAt: deps.now() } });
    await event(db, reg.id, "brand_reconciled", "Found the business filed at Telnyx after an unconfirmed filing");
    await addChargeOnce(deps, reg.id, reg.filedByUserId);
    return advanceBrand(deps, creds, { ...reg, telnyxBrandId: b.brandId, status: "brand_review" });
  }
  if (candidates.length > 1 || deps.now().getTime() - started > RECONCILE_GIVE_UP_MS) {
    const msg = candidates.length > 1
      ? `Filing unconfirmed and ${candidates.length} matching businesses exist at Telnyx. Check the Telnyx portal before doing anything — do not file again.`
      : "Filing unconfirmed and no business appeared at Telnyx. Check the Telnyx portal before filing again.";
    await db.textingRegistration.update({ where: { id: reg.id }, data: { status: "error", lastError: msg, lastCheckedAt: deps.now() } });
    await event(db, reg.id, "filing_needs_person", msg);
  }
  return db.textingRegistration.findUnique({ where: { id: reg.id } });
}

async function purgeEin(deps: EngineDeps, registrationId: string, why: string): Promise<void> {
  const r = await deps.db.textingRegistrationEin.deleteMany({ where: { registrationId } });
  if (r.count) await event(deps.db, registrationId, "ein_destroyed", `EIN token destroyed (${why})`);
}

async function advanceBrand(deps: EngineDeps, creds: any, reg: any): Promise<any> {
  const { db } = deps;
  const brand = await deps.registry.getBrand(creds, reg.telnyxBrandId);
  const phase = brandPhase(brand);
  const base = { brandIdentityStatus: brand.identityStatus, brandStatus: brand.status, tcrBrandId: brand.tcrBrandId ?? reg.tcrBrandId, lastCheckedAt: deps.now(), lastError: null };

  if (phase === "failed") {
    const feedback = await deps.registry.getBrandFeedback(creds, reg.telnyxBrandId).catch(() => []);
    await db.textingRegistration.update({ where: { id: reg.id }, data: { ...base, status: "brand_failed", brandFeedback: { categories: feedback, reasons: brand.failureReasons } as any } });
    if (reg.status !== "brand_failed") await event(db, reg.id, "brand_failed", `The registry could not verify the business${feedback.length ? `: ${feedback.map((f) => f.displayName).join(", ")}` : ""}`);
    return db.textingRegistration.findUnique({ where: { id: reg.id } });
  }

  if (phase === "pending") {
    const sole = reg.entityType === "SOLE_PROPRIETOR";
    if (sole && !reg.pinSentAt && reg.mobilePhone) {
      const claim = await db.textingRegistration.updateMany({ where: { id: reg.id, pinSentAt: null }, data: { pinSentAt: deps.now() } });
      if (claim.count) {
        await deps.registry.sendBrandPin(creds, reg.telnyxBrandId, PIN_SMS(reg.displayName), PIN_SUCCESS_SMS(reg.displayName));
        await db.textingRegistration.update({ where: { id: reg.id }, data: { ...base, status: "awaiting_pin" } });
        await event(db, reg.id, "pin_sent", "Verification PIN texted to the owner");
        return db.textingRegistration.findUnique({ where: { id: reg.id } });
      }
    }
    await db.textingRegistration.update({ where: { id: reg.id }, data: base });
    return db.textingRegistration.findUnique({ where: { id: reg.id } });
  }

  // Verified.
  await db.textingRegistration.update({ where: { id: reg.id }, data: { ...base, brandVerifiedAt: reg.brandVerifiedAt ?? deps.now(), status: "brand_review" } });
  if (!reg.brandVerifiedAt) await event(db, reg.id, "brand_verified", "The registry verified the business");
  await purgeEin(deps, reg.id, "business verified");
  return fileCampaign(deps, creds, await db.textingRegistration.findUnique({ where: { id: reg.id } }));
}

async function fileCampaign(deps: EngineDeps, creds: any, reg: any): Promise<any> {
  const { db } = deps;
  if (reg.telnyxCampaignId) {
    await db.textingRegistration.update({ where: { id: reg.id }, data: { status: "campaign_review" } });
    return advanceCampaign(deps, creds, { ...reg, status: "campaign_review" });
  }
  if (reg.campaignCreateStartedAt) {
    // A create was sent and never confirmed — reconcile by referenceId, never resend.
    const list = await deps.registry.listCampaignsForBrand(creds, reg.telnyxBrandId);
    const mine = list.find((c) => c.referenceId === reg.referenceKey);
    if (mine) {
      await db.textingRegistration.update({ where: { id: reg.id }, data: { telnyxCampaignId: mine.campaignId, tcrCampaignId: mine.tcrCampaignId, campaignStatus: mine.campaignStatus, status: "campaign_review", lastError: null } });
      await event(db, reg.id, "campaign_reconciled", "Found the campaign filed at Telnyx after an unconfirmed filing");
      return advanceCampaign(deps, creds, { ...reg, telnyxCampaignId: mine.campaignId, status: "campaign_review" });
    }
    if (deps.now().getTime() - new Date(reg.campaignCreateStartedAt).getTime() > RECONCILE_GIVE_UP_MS) {
      const msg = "Campaign filing unconfirmed and it did not appear at Telnyx. Check the Telnyx portal before filing again.";
      await db.textingRegistration.update({ where: { id: reg.id }, data: { status: "error", lastError: msg } });
      await event(db, reg.id, "campaign_needs_person", msg);
    }
    return db.textingRegistration.findUnique({ where: { id: reg.id } });
  }

  const usecase = await conversationalUsecase(deps, creds);
  let subUsecases = CONVERSATIONAL_SUB_USECASES;
  try {
    const q = await deps.registry.qualifyUsecase(creds, reg.telnyxBrandId, usecase);
    if (q.maxSubUsecases === 0) subUsecases = [];
  } catch (err) {
    const reason = deps.registry.registryReason(err);
    if (deps.registry.isDefiniteRefusal(err)) {
      await db.textingRegistration.update({ where: { id: reg.id }, data: { status: "error", lastError: `This business does not qualify for the conversational program: ${reason}` } });
      await event(db, reg.id, "campaign_not_qualified", `Not qualified: ${reason}`);
      return db.textingRegistration.findUnique({ where: { id: reg.id } });
    }
    throw err;
  }

  const claim = await db.textingRegistration.updateMany({ where: { id: reg.id, campaignCreateStartedAt: null, telnyxCampaignId: null }, data: { campaignCreateStartedAt: deps.now() } });
  if (!claim.count) return db.textingRegistration.findUnique({ where: { id: reg.id } });

  const content = contentOf(reg, deps.portalOrigin());
  const urls = policyUrls(deps.portalOrigin(), reg.publicSlug);
  try {
    const c = await deps.registry.createCampaign(creds, {
      brandId: reg.telnyxBrandId,
      usecase,
      subUsecases,
      referenceId: reg.referenceKey,
      ...content,
      privacyPolicyLink: urls.privacyUrl,
      termsAndConditionsLink: urls.termsUrl,
      webhookURL: webhookUrl(deps.publicApiBase()),
    });
    await db.textingRegistration.update({
      where: { id: reg.id },
      data: { telnyxCampaignId: c.campaignId, tcrCampaignId: c.tcrCampaignId, campaignStatus: c.campaignStatus, failureReasons: c.failureReasons, status: "campaign_review", lastError: null, lastCheckedAt: deps.now() },
    });
    await event(db, reg.id, "campaign_created", `Campaign filed (${usecase}); Telnyx and the carriers are reviewing`, null, { campaignId: c.campaignId });
    return db.textingRegistration.findUnique({ where: { id: reg.id } });
  } catch (err) {
    const reason = deps.registry.registryReason(err);
    if (deps.registry.isDefiniteRefusal(err)) {
      await db.textingRegistration.update({ where: { id: reg.id }, data: { status: "error", campaignCreateStartedAt: null, lastError: `Telnyx refused the campaign: ${reason}` } });
      await event(db, reg.id, "campaign_refused", `Telnyx refused the campaign: ${reason}`);
      return db.textingRegistration.findUnique({ where: { id: reg.id } });
    }
    await db.textingRegistration.update({ where: { id: reg.id }, data: { lastError: `Campaign filing unconfirmed (${reason}); checking again automatically` } });
    await event(db, reg.id, "campaign_uncertain", `Campaign filing unconfirmed (${reason}); reconciling`);
    return db.textingRegistration.findUnique({ where: { id: reg.id } });
  }
}

async function advanceCampaign(deps: EngineDeps, creds: any, reg: any): Promise<any> {
  const { db } = deps;
  const c = await deps.registry.getCampaign(creds, reg.telnyxCampaignId);
  const op = await deps.registry.getOperationStatus(creds, reg.telnyxCampaignId).catch(() => ({}));
  const reviews = carrierReviews(op, await mnoNames(deps, creds));
  const phase = campaignPhase(c);
  const base: any = {
    campaignStatus: c.campaignStatus,
    tcrCampaignId: c.tcrCampaignId ?? reg.tcrCampaignId,
    carrierReviews: reviews,
    failureReasons: c.failureReasons,
    renewsAt: c.nextRenewalOrExpirationDate ? new Date(c.nextRenewalOrExpirationDate) : reg.renewsAt,
    lastCheckedAt: deps.now(),
    lastError: null,
  };
  if (phase === "rejected") {
    await db.textingRegistration.update({ where: { id: reg.id }, data: { ...base, status: "campaign_rejected" } });
    if (reg.status !== "campaign_rejected") await event(db, reg.id, "campaign_rejected", `Campaign rejected (${c.campaignStatus})${c.failureReasons.length ? `: ${c.failureReasons.join("; ").slice(0, 300)}` : ""}`);
    return db.textingRegistration.findUnique({ where: { id: reg.id } });
  }
  if (phase === "suspended") {
    await db.textingRegistration.update({ where: { id: reg.id }, data: { ...base, status: "suspended" } });
    if (reg.status !== "suspended") await event(db, reg.id, "campaign_suspended", `Campaign suspended or expired (${c.campaignStatus})`);
    return db.textingRegistration.findUnique({ where: { id: reg.id } });
  }
  if (phase === "approved") {
    await db.textingRegistration.update({ where: { id: reg.id }, data: { ...base, status: "assigning" } });
    if (reg.status === "campaign_review") await event(db, reg.id, "campaign_approved", "Carriers approved the campaign; attaching numbers");
    return advanceNumbers(deps, creds, await db.textingRegistration.findUnique({ where: { id: reg.id } }));
  }
  const prev = JSON.stringify(reg.carrierReviews ?? null);
  await db.textingRegistration.update({ where: { id: reg.id }, data: base });
  if (prev !== JSON.stringify(reviews)) {
    for (const r of reviews) {
      const before = Array.isArray(reg.carrierReviews) ? reg.carrierReviews.find((x: any) => x.networkId === r.networkId) : null;
      if (!before || before.state !== r.state) await event(db, reg.id, "carrier_review", `${r.carrier}: ${r.state}`);
    }
  }
  return db.textingRegistration.findUnique({ where: { id: reg.id } });
}

async function advanceNumbers(deps: EngineDeps, creds: any, reg: any): Promise<any> {
  const { db } = deps;
  if (reg.status === "live") {
    // Keep watching a live campaign: suspension, or new Telnyx numbers to attach.
    const c = await deps.registry.getCampaign(creds, reg.telnyxCampaignId);
    const phase = campaignPhase(c);
    if (phase === "suspended" || phase === "rejected") {
      await db.textingRegistration.update({ where: { id: reg.id }, data: { campaignStatus: c.campaignStatus, status: phase === "suspended" ? "suspended" : "campaign_rejected", lastCheckedAt: deps.now() } });
      await event(db, reg.id, "campaign_lost", `Live campaign is now ${c.campaignStatus}`);
      return db.textingRegistration.findUnique({ where: { id: reg.id } });
    }
  }
  const numbers = await telnyxNumbersFor(deps, reg.tenantId);
  const prior: Record<string, any> = reg.numberAssignments && typeof reg.numberAssignments === "object" ? reg.numberAssignments : {};
  const next: Record<string, any> = {};
  let assigned = 0;
  for (const n of numbers) {
    const a = await deps.registry.getNumberAssignment(creds, n);
    let phase = assignmentPhase(a, reg.telnyxCampaignId);
    let note: string | null = a?.failureReasons?.join("; ") || null;
    if (phase === "none") {
      const lastTry = prior[n]?.attemptedAt ? new Date(prior[n].attemptedAt).getTime() : 0;
      if (deps.now().getTime() - lastTry > 30 * 60_000) {
        try {
          const r = await deps.registry.assignNumber(creds, n, reg.telnyxCampaignId);
          phase = assignmentPhase(r, reg.telnyxCampaignId) === "none" ? "pending" : assignmentPhase(r, reg.telnyxCampaignId);
          await event(db, reg.id, "number_assign_sent", `Attaching ${n}`);
        } catch (err) {
          note = deps.registry.registryReason(err);
          phase = deps.registry.isDefiniteRefusal(err) ? "failed" : "pending";
          await event(db, reg.id, "number_assign_refused", `Attaching ${n} failed: ${note}`);
        }
        next[n] = { state: phase, note, attemptedAt: deps.now().toISOString() };
        if (phase === "assigned") assigned++;
        continue;
      }
      phase = "pending";
    }
    if (phase === "failed" && a?.campaignId && a.campaignId !== reg.telnyxCampaignId) note = `Already attached to another campaign (${a.campaignId})`;
    next[n] = { state: phase, note, attemptedAt: prior[n]?.attemptedAt ?? null };
    if (phase === "assigned") {
      assigned++;
      if (prior[n]?.state !== "assigned") await event(db, reg.id, "number_assigned", `${n} attached`);
    }
  }
  const data: any = { numberAssignments: next, lastCheckedAt: deps.now(), lastError: null };
  if (assigned > 0 && reg.status !== "live") {
    data.status = "live";
    data.liveAt = reg.liveAt ?? deps.now();
  }
  await db.textingRegistration.update({ where: { id: reg.id }, data });
  if (data.status === "live") {
    await event(db, reg.id, "live", "Texting is live");
    await queueReadyEmailOnce(deps, reg.id);
  }
  return db.textingRegistration.findUnique({ where: { id: reg.id } });
}

// ── Sole proprietor PIN (customer link) ─────────────────────────────────────

export async function verifyOwnerPin(deps: EngineDeps, token: string, pin: string): Promise<{ ok: boolean; message: string }> {
  const { db } = deps;
  const r = await resolvePublicLink(deps, token);
  if (r.state !== "ok" || r.reg.status !== "awaiting_pin") throw new RegistrationError("pin_not_expected", "There is no code waiting on this registration.", 409);
  const reg = r.reg;
  const clean = String(pin || "").replace(/\D/g, "");
  if (clean.length !== 6) return { ok: false, message: "Enter the 6-digit code from the text message." };
  const attempts = await db.textingRegistrationEvent.count({ where: { registrationId: reg.id, kind: "pin_wrong", createdAt: { gt: reg.pinSentAt ?? new Date(0) } } });
  if (attempts >= PIN_ATTEMPT_LIMIT) return { ok: false, message: "Too many wrong codes. Ask for a new code." };
  const creds = await deps.resolveCreds();
  if (!creds) throw new RegistrationError("unavailable", "Verification is unavailable right now. Try again in a few minutes.", 503);
  try {
    await deps.registry.verifyBrandPin(creds, reg.telnyxBrandId, clean);
  } catch (err) {
    if (deps.registry.isDefiniteRefusal(err)) {
      await event(db, reg.id, "pin_wrong", "Owner entered a code that was not accepted");
      return { ok: false, message: "That code wasn't accepted. Check the text message and try again." };
    }
    throw new RegistrationError("unavailable", "Verification is unavailable right now. Try again in a few minutes.", 503);
  }
  await db.textingRegistration.update({ where: { id: reg.id }, data: { status: "brand_review" } });
  await event(db, reg.id, "pin_verified", "Owner verified the code");
  await advanceRegistration(deps, reg.id).catch(() => null);
  return { ok: true, message: "Verified. Thank you." };
}

export async function resendOwnerPin(deps: EngineDeps, token: string): Promise<void> {
  const { db } = deps;
  const r = await resolvePublicLink(deps, token);
  if (r.state !== "ok" || r.reg.status !== "awaiting_pin") throw new RegistrationError("pin_not_expected", "There is no code waiting on this registration.", 409);
  const reg = r.reg;
  if (reg.pinSentAt && deps.now().getTime() - new Date(reg.pinSentAt).getTime() < 60_000) throw new RegistrationError("too_soon", "A code was just sent. Wait a minute before asking for another.", 429);
  const creds = await deps.resolveCreds();
  if (!creds) throw new RegistrationError("unavailable", "Unavailable right now.", 503);
  await deps.registry.sendBrandPin(creds, reg.telnyxBrandId, PIN_SMS(reg.displayName), PIN_SUCCESS_SMS(reg.displayName));
  await db.textingRegistration.update({ where: { id: reg.id }, data: { pinSentAt: deps.now() } });
  await event(db, reg.id, "pin_sent", "New verification code texted to the owner");
}

// ── Staff actions after filing ──────────────────────────────────────────────

export async function appeal(deps: EngineDeps, registrationId: string, reason: string, actorUserId: string | null): Promise<any> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg || reg.status !== "campaign_rejected" || !reg.telnyxCampaignId) throw new RegistrationError("not_rejected", "Only a rejected campaign can be appealed.", 409);
  const text = String(reason || "").trim();
  if (text.length < 10) throw new RegistrationError("no_reason", "Explain what was fixed (at least a sentence).");
  const creds = await deps.resolveCreds();
  if (!creds) throw new RegistrationError("telnyx_not_configured", "Telnyx isn't connected.", 503);
  try {
    await deps.registry.appealCampaign(creds, reg.telnyxCampaignId, text);
  } catch (err) {
    throw new RegistrationError("registry_refused", `Telnyx refused the appeal: ${deps.registry.registryReason(err)}`, 502);
  }
  await db.textingRegistration.update({ where: { id: registrationId }, data: { status: "campaign_review", lastError: null } });
  await event(db, registrationId, "appealed", "Appeal sent to Telnyx", actorUserId, { reason: text.slice(0, 1000) });
  return db.textingRegistration.findUnique({ where: { id: registrationId } });
}

export async function deactivate(deps: EngineDeps, registrationId: string, confirmName: string, actorUserId: string | null): Promise<any> {
  const { db } = deps;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
  if (cleanName(confirmName).toLowerCase() !== cleanName(reg.displayName).toLowerCase()) {
    throw new RegistrationError("confirm_mismatch", `Type "${reg.displayName}" exactly to confirm.`);
  }
  if (reg.telnyxCampaignId) {
    const creds = await deps.resolveCreds();
    if (!creds) throw new RegistrationError("telnyx_not_configured", "Telnyx isn't connected.", 503);
    try {
      await deps.registry.deactivateCampaign(creds, reg.telnyxCampaignId);
    } catch (err) {
      throw new RegistrationError("registry_refused", `Telnyx refused: ${deps.registry.registryReason(err)}`, 502);
    }
  }
  await db.textingRegistrationLink.updateMany({ where: { registrationId, revokedAt: null, usedAt: null }, data: { revokedAt: deps.now() } });
  await db.textingRegistrationEin.deleteMany({ where: { registrationId } });
  await db.textingRegistration.update({ where: { id: registrationId }, data: { status: "deactivated" } });
  await event(db, registrationId, "deactivated", reg.telnyxCampaignId ? "Campaign permanently deactivated at Telnyx" : "Registration closed", actorUserId);
  return db.textingRegistration.findUnique({ where: { id: registrationId } });
}

// ── Emails ──────────────────────────────────────────────────────────────────

async function queueReadyEmailOnce(deps: EngineDeps, registrationId: string): Promise<void> {
  if (!deps.queueEmail) return;
  const { db } = deps;
  const claim = await db.textingRegistration.updateMany({ where: { id: registrationId, readyEmailSentAt: null }, data: { readyEmailSentAt: deps.now() } });
  if (!claim.count) return;
  const reg = await db.textingRegistration.findUnique({ where: { id: registrationId } });
  if (!reg?.businessEmail) return;
  const { buildReadyEmail } = await import("./emails");
  const mail = buildReadyEmail({ displayName: reg.displayName, firstName: reg.contactFirstName });
  try {
    await deps.queueEmail({ tenantId: reg.tenantId, type: "TEXTING_REGISTRATION_READY", to: reg.businessEmail, ...mail });
    await event(db, registrationId, "ready_email", `"Texting is ready" email queued to ${reg.businessEmail}`);
  } catch (err: any) {
    await db.textingRegistration.update({ where: { id: registrationId }, data: { readyEmailSentAt: null } });
    deps.log?.error({ registrationId, err: String(err?.message || err) }, "texting_registration_ready_email_failed");
  }
}

// ── Sweep ───────────────────────────────────────────────────────────────────

export async function sweepRegistrations(deps: EngineDeps, opts: { batch?: number } = {}): Promise<{ checked: number; einExpired: number }> {
  const { db } = deps;
  const rows = await db.textingRegistration.findMany({
    where: { status: { in: SWEEP_STATUSES } },
    orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    take: opts.batch ?? 50,
    select: { id: true, status: true, lastCheckedAt: true },
  });
  let checked = 0;
  for (const r of rows) {
    // Live rows only need an hourly look.
    if (r.status === "live" && r.lastCheckedAt && deps.now().getTime() - new Date(r.lastCheckedAt).getTime() < 55 * 60_000) continue;
    await advanceRegistration(deps, r.id);
    checked++;
  }
  // Unfiled EIN tokens past their TTL are destroyed.
  const stale = await db.textingRegistrationEin.findMany({ select: { registrationId: true, createdAt: true, registration: { select: { status: true } } } });
  let einExpired = 0;
  for (const s of stale) {
    if (!["awaiting_customer", "submitted", "needs_fix", "draft", "brand_failed"].includes(s.registration?.status)) continue;
    if (!einTokenExpired(new Date(s.createdAt), deps.now())) continue;
    await purgeEin(deps, s.registrationId, "not filed within 14 days");
    einExpired++;
  }
  return { checked, einExpired };
}

export const SWEEP_INTERVAL_MS = 10 * 60_000;
export const SWEEP_BOOT_DELAY_MS = 2 * 60_000;
export const sweepState = { lastRunAt: null as Date | null, lastResult: null as null | { checked: number; einExpired: number }, lastError: null as string | null, running: false };

export function startTextingRegistrationSweep(deps: EngineDeps): { stop: () => void } | null {
  if (String(process.env.TEXTING_REGISTRATION_SWEEP_DISABLED || "") === "1") {
    deps.log?.warn({}, "TEXTING_REGISTRATION_SWEEP_DISABLED");
    return null;
  }
  const run = async () => {
    if (sweepState.running) return;
    sweepState.running = true;
    try {
      sweepState.lastResult = await sweepRegistrations(deps);
      sweepState.lastError = null;
    } catch (err: any) {
      sweepState.lastError = String(err?.message || err).slice(0, 300);
      deps.log?.error({ err: sweepState.lastError }, "texting_registration_sweep_failed");
    } finally {
      sweepState.lastRunAt = new Date();
      sweepState.running = false;
    }
  };
  const boot = setTimeout(run, SWEEP_BOOT_DELAY_MS);
  const interval = setInterval(run, SWEEP_INTERVAL_MS);
  (boot as any).unref?.();
  (interval as any).unref?.();
  deps.log?.info({ intervalMs: SWEEP_INTERVAL_MS, bootDelayMs: SWEEP_BOOT_DELAY_MS }, "TEXTING_REGISTRATION_SWEEP_ARMED");
  return { stop: () => { clearTimeout(boot); clearInterval(interval); } };
}

export { buildPrivacyPolicy, buildSmsTerms, NEEDS_STAFF, STATUS_LABEL };
