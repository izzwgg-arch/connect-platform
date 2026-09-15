/**
 * Telnyx client — the second carrier on the evaluation bench (beside
 * SignalWire), reached the same way: plain `fetch`, no SDK. ⛔ apps/api has
 * been killed on boot before by an import that was not in its package.json
 * (`undici` — blue/green refused the cutover, see dependencyHygiene.test.ts).
 * Telnyx's API v2 is one JSON surface with one auth header; an SDK would buy
 * nothing and could cost the container.
 *
 * ── The one API surface ─────────────────────────────────────────────────────
 * Everything lives under `https://api.telnyx.com/v2`, authenticated with
 * `Authorization: Bearer KEY…`. Responses are `{ data: … }` (single object or
 * array) with `{ errors: [{code, title, detail}] }` on failure, and list
 * endpoints page with `page[number]` / `page[size]` + `meta`.
 *
 * The families this bench wires in (each maps to a panel on /apps/telnyx):
 *   /balance                      account balance + currency (also the
 *                                 cheapest "are the credentials live" probe)
 *   /available_phone_numbers      number search (area code / contains /
 *                                 locality / state / type)
 *   /number_orders                buying a number  ⛔ real money
 *   /phone_numbers                owned numbers, per-number config (connection
 *                                 assignment, tags, customer_reference) and
 *                                 /phone_numbers/{id}/voice (CNAM, emergency)
 *   /connections                  SIP connections (credential / FQDN / IP),
 *                                 read-only here — they are created in the
 *                                 Telnyx portal where their secrets stay
 *   /outbound_voice_profiles      outbound permission/limit profiles
 *   /portability_checks           "can this number port to Telnyx?"
 *   /messages                     sending SMS  ⛔ real money
 *   /detail_records               CDR/MDR search (the proof a call happened
 *                                 and what STIR/SHAKEN attestation it got —
 *                                 the record carries a `stir_shaken` field)
 *
 * ── Why this is a CLIENT and not yet a provider ────────────────────────────
 * Nothing here is wired into onboarding, chat, billing SMS, the worker or the
 * PBX. Those all ride the `GlobalVoipMsConfig` singleton + `vms()` today (with
 * SignalWire behind `ONBOARDING_NUMBER_PROVIDER` for new sign-ups). This
 * module exists so the platform owner can prove, from inside Loopcom, that
 * Telnyx can do each job — and see the attestation each call actually got —
 * before any cut-over decision.
 *
 * ⛔ Every real call here can cost money (a purchase, a message) or create a
 * durable object on the Telnyx account. Nothing retries a mutating request: a
 * timeout on `orderNumber` is reported as "unknown — check the number list",
 * never re-sent.
 */

import type { StoredTelnyxCredentials } from "./telnyxCredentials";

// ── Transport ────────────────────────────────────────────────────────────────

export const TELNYX_API_BASE = "https://api.telnyx.com/v2";

export interface TxRequest {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  timeoutMs?: number;
}

export interface TxResponse<T = any> {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON, else null. */
  data: T | null;
  /** Raw text when the response was not JSON (HTML error pages etc.). */
  text: string | null;
  url: string;
}

export class TelnyxError extends Error {
  status: number;
  code: string;
  /** Plain-English explanation for the owner page. */
  userMessage: string;
  detail: unknown;
  constructor(status: number, code: string, userMessage: string, detail?: unknown) {
    super(userMessage);
    this.name = "TelnyxError";
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
    this.detail = detail;
  }
}

/** Bearer auth header. Never logged. */
export function authHeader(creds: StoredTelnyxCredentials): string {
  return `Bearer ${creds.apiKey}`;
}

export function buildUrl(req: TxRequest): string {
  const url = new URL(`${TELNYX_API_BASE}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Turn a non-2xx response into something a person can act on. Telnyx answers
 * `{errors: [{code, title, detail, source}]}` on every failure; the account
 * LEVEL matters a lot here (a Trial account cannot buy numbers or place
 * calls), so the 4xx explanations say so instead of "forbidden".
 */
export function classifyError(res: TxResponse): TelnyxError {
  const d: any = res.data;
  const providerMessage: string =
    (d && typeof d === "object" && Array.isArray(d.errors) &&
      d.errors.map((e: any) => [e?.title, e?.detail].filter(Boolean).join(" — ") || e?.code || JSON.stringify(e)).join("; ")) ||
    (d && typeof d === "object" && (d.message || d.error)) ||
    (res.text ? res.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "") ||
    `HTTP ${res.status}`;

  switch (res.status) {
    case 401:
      return new TelnyxError(401, "unauthorized",
        "Telnyx rejected the credentials. Check the API key — v2 keys start with KEY, and a key deleted or regenerated in the portal stops working immediately.", d);
    case 403:
      return new TelnyxError(403, "forbidden",
        `Telnyx refused this call (${providerMessage}). On a Trial-level account most things are locked until the account is upgraded (service address + card + verified phone on the Account Levels page); otherwise the key may belong to the wrong account.`, d);
    case 404:
      return new TelnyxError(404, "not_found", `Telnyx has no such thing (${providerMessage}).`, d);
    case 402:
      return new TelnyxError(402, "payment_required",
        `Telnyx refused for billing reasons (${providerMessage}). The balance is too low for this — add funds in the Telnyx portal.`, d);
    case 422:
    case 400:
      return new TelnyxError(res.status, "invalid_request", `Telnyx refused the request: ${providerMessage}`, d);
    case 429:
      return new TelnyxError(429, "rate_limited", "Telnyx is rate-limiting this account. Wait a moment and try again.", d);
    default:
      if (res.status >= 500) {
        return new TelnyxError(res.status, "provider_error", `Telnyx answered ${res.status} — that is their side. Try again in a minute.`, d);
      }
      return new TelnyxError(res.status, "unexpected", `Unexpected answer from Telnyx (${res.status}): ${providerMessage}`, d);
  }
}

/** The one transport. Injectable fetch so tests never touch the network. */
export type FetchLike = (url: string, init: any) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

let fetchImpl: FetchLike = (globalThis as any).fetch;
export function setTelnyxFetch(f: FetchLike | null): void {
  fetchImpl = f ?? (globalThis as any).fetch;
}

export async function txRequest<T = any>(creds: StoredTelnyxCredentials, req: TxRequest): Promise<TxResponse<T>> {
  const url = buildUrl(req);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = req.timeoutMs ?? 20_000;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const headers: Record<string, string> = {
      Authorization: authHeader(creds),
      Accept: "application/json",
    };
    const init: any = { method: req.method ?? "GET", headers, signal: controller?.signal };
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.json);
    }
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let data: T | null = null;
    let rawText: string | null = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        rawText = text;
      }
    }
    return { ok: res.ok, status: res.status, data, text: rawText, url };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new TelnyxError(0, "timeout", `Telnyx didn't answer within ${Math.round(timeout / 1000)}s. If this was a purchase or a send, it MAY still have gone through — refresh the list before trying again.`);
    }
    throw new TelnyxError(0, "network", `Couldn't reach Telnyx (${String(err?.message || err).slice(0, 120)}).`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function txExpect<T = any>(creds: StoredTelnyxCredentials, req: TxRequest): Promise<T> {
  const res = await txRequest<T>(creds, req);
  if (!res.ok) throw classifyError(res);
  return (res.data ?? ({} as T)) as T;
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface TelnyxConnectionCheck {
  ok: boolean;
  balance: string | null;
  currency: string | null;
  ownedNumberCount: number | null;
  message: string | null;
  code: string | null;
}

/** The cheapest "are the credentials live" probe: balance + one-number page. */
export async function checkConnection(creds: StoredTelnyxCredentials): Promise<TelnyxConnectionCheck> {
  try {
    const bal = await txExpect<any>(creds, { path: "/balance" });
    let ownedNumberCount: number | null = null;
    try {
      const nums = await txExpect<any>(creds, { path: "/phone_numbers", query: { "page[size]": 1 } });
      ownedNumberCount = nums?.meta?.total_results ?? (Array.isArray(nums?.data) ? nums.data.length : null);
    } catch {
      // Balance proved auth; a numbers listing refused by account level is
      // still a working credential. Leave the count unknown.
    }
    return {
      ok: true,
      balance: bal?.data?.balance ?? null,
      currency: bal?.data?.currency ?? null,
      ownedNumberCount,
      message: null,
      code: null,
    };
  } catch (err: any) {
    if (err instanceof TelnyxError) {
      return { ok: false, balance: null, currency: null, ownedNumberCount: null, message: err.userMessage, code: err.code };
    }
    return { ok: false, balance: null, currency: null, ownedNumberCount: null, message: String(err?.message || err), code: "unknown" };
  }
}

// ── Numbers ──────────────────────────────────────────────────────────────────

export interface TelnyxAvailableNumber {
  number: string;
  region: string | null;
  locality: string | null;
  numberType: string | null;
  upfrontCost: string | null;
  monthlyCost: string | null;
  features: string[];
}

export async function searchNumbers(creds: StoredTelnyxCredentials, opts: {
  numberType?: "local" | "toll_free";
  areaCode?: string;
  contains?: string;
  locality?: string;
  state?: string;
  limit?: number;
}): Promise<TelnyxAvailableNumber[]> {
  const query: Record<string, string | number | undefined> = {
    "filter[country_code]": "US",
    "filter[phone_number_type]": opts.numberType === "toll_free" ? "toll_free" : "local",
    "filter[limit]": Math.min(Math.max(opts.limit ?? 20, 1), 50),
    "filter[best_effort]": undefined,
  };
  if (opts.areaCode) query["filter[national_destination_code]"] = opts.areaCode;
  if (opts.contains) query["filter[phone_number][contains]"] = opts.contains;
  if (opts.locality) query["filter[locality]"] = opts.locality;
  if (opts.state) query["filter[administrative_area]"] = opts.state;

  const body = await txExpect<any>(creds, { path: "/available_phone_numbers", query });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    number: r?.phone_number ?? "",
    region: r?.region_information?.find?.((x: any) => x?.region_type === "state")?.region_name ?? null,
    locality: r?.region_information?.find?.((x: any) => x?.region_type === "location")?.region_name ?? null,
    numberType: r?.phone_number_type ?? null,
    upfrontCost: r?.cost_information?.upfront_cost ?? null,
    monthlyCost: r?.cost_information?.monthly_cost ?? null,
    features: Array.isArray(r?.features) ? r.features.map((f: any) => f?.name).filter(Boolean) : [],
  })).filter((r) => r.number);
}

/**
 * Buy ONE number. ⛔ Real money, never retried — the route reports a timeout
 * as "unknown, refresh the list", exactly like the SignalWire purchase.
 * `connectionId` pre-assigns the number to a SIP connection at activation.
 */
export async function orderNumber(creds: StoredTelnyxCredentials, phoneNumber: string, connectionId?: string | null): Promise<{ orderId: string | null; status: string | null }> {
  const body: any = { phone_numbers: [{ phone_number: phoneNumber }] };
  if (connectionId) body.connection_id = connectionId;
  const res = await txExpect<any>(creds, { path: "/number_orders", method: "POST", json: body });
  return { orderId: res?.data?.id ?? null, status: res?.data?.status ?? null };
}

export interface TelnyxOwnedNumber {
  id: string;
  number: string;
  status: string | null;
  connectionId: string | null;
  connectionName: string | null;
  emergencyEnabled: boolean;
  emergencyAddressId: string | null;
  cnamListingEnabled: boolean;
  cnamListingDetails: string | null;
  tags: string[];
  customerReference: string | null;
  createdAt: string | null;
}

export async function listNumbers(creds: StoredTelnyxCredentials): Promise<TelnyxOwnedNumber[]> {
  const body = await txExpect<any>(creds, { path: "/phone_numbers", query: { "page[size]": 250 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    number: r?.phone_number ?? "",
    status: r?.status ?? null,
    connectionId: r?.connection_id ? String(r.connection_id) : null,
    connectionName: r?.connection_name ?? null,
    emergencyEnabled: Boolean(r?.emergency_enabled),
    emergencyAddressId: r?.emergency_address_id ? String(r.emergency_address_id) : null,
    cnamListingEnabled: Boolean(r?.cnam_listing_enabled),
    cnamListingDetails: r?.cnam_listing_details ?? null,
    tags: Array.isArray(r?.tags) ? r.tags.map(String) : [],
    customerReference: r?.customer_reference ?? null,
    createdAt: r?.created_at ?? null,
  })).filter((r) => r.id && r.number);
}

/** Point a number at a SIP connection / stamp tags + customer reference. */
export async function updateNumber(creds: StoredTelnyxCredentials, id: string, patch: {
  connectionId?: string | null;
  tags?: string[];
  customerReference?: string | null;
}): Promise<void> {
  const body: any = {};
  if (patch.connectionId !== undefined) body.connection_id = patch.connectionId;
  if (patch.tags !== undefined) body.tags = patch.tags;
  if (patch.customerReference !== undefined) body.customer_reference = patch.customerReference;
  await txExpect(creds, { path: `/phone_numbers/${encodeURIComponent(id)}`, method: "PATCH", json: body });
}

/**
 * Outbound CNAM listing — free on Telnyx numbers, ≤15 chars A-Z 0-9 and
 * spaces, and this is the per-customer caller-name lever (ABC PLUMBING on
 * ABC's number, XYZ MEDICAL on XYZ's — never LOOPCOM on everyone's).
 */
export async function setCnamListing(creds: StoredTelnyxCredentials, id: string, enabled: boolean, details?: string | null): Promise<void> {
  const cnam: any = { cnam_listing_enabled: enabled };
  if (enabled) cnam.cnam_listing_details = String(details ?? "").toUpperCase();
  await txExpect(creds, { path: `/phone_numbers/${encodeURIComponent(id)}/voice`, method: "PATCH", json: { cnam_listing: cnam } });
}

/** ⛔ Releases the number back to Telnyx — it may not be recoverable. */
export async function releaseNumber(creds: StoredTelnyxCredentials, id: string): Promise<void> {
  await txExpect(creds, { path: `/phone_numbers/${encodeURIComponent(id)}`, method: "DELETE" });
}

// ── SIP connections + outbound profiles (read-only on the bench) ────────────

export interface TelnyxConnectionSummary {
  id: string;
  name: string | null;
  active: boolean;
  recordType: string | null;
}

export async function listConnections(creds: StoredTelnyxCredentials): Promise<TelnyxConnectionSummary[]> {
  const body = await txExpect<any>(creds, { path: "/connections", query: { "page[size]": 100 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    name: r?.connection_name ?? null,
    active: Boolean(r?.active),
    recordType: r?.record_type ?? null,
  })).filter((r) => r.id);
}

export interface TelnyxOutboundProfile {
  id: string;
  name: string | null;
  enabled: boolean;
  dailySpendLimit: string | null;
  dailySpendLimitEnabled: boolean;
  allowedDestinations: string[];
}

export async function listOutboundProfiles(creds: StoredTelnyxCredentials): Promise<TelnyxOutboundProfile[]> {
  const body = await txExpect<any>(creds, { path: "/outbound_voice_profiles", query: { "page[size]": 100 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    name: r?.name ?? null,
    enabled: Boolean(r?.enabled),
    dailySpendLimit: r?.daily_spend_limit ?? null,
    dailySpendLimitEnabled: Boolean(r?.daily_spend_limit_enabled),
    allowedDestinations: Array.isArray(r?.whitelisted_destinations) ? r.whitelisted_destinations.map(String) : [],
  })).filter((r) => r.id);
}

// ── Porting ──────────────────────────────────────────────────────────────────

export interface TelnyxPortabilityResult {
  number: string;
  portable: boolean | null;
  fastPortable: boolean | null;
  carrier: string | null;
  reason: string | null;
}

export async function checkPortability(creds: StoredTelnyxCredentials, numbers: string[]): Promise<TelnyxPortabilityResult[]> {
  const body = await txExpect<any>(creds, { path: "/portability_checks", method: "POST", json: { phone_numbers: numbers } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    number: r?.phone_number ?? "",
    portable: typeof r?.portable === "boolean" ? r.portable : null,
    fastPortable: typeof r?.fast_portable === "boolean" ? r.fast_portable : null,
    carrier: r?.carrier_name ?? null,
    reason: r?.not_portable_reason ?? null,
  })).filter((r) => r.number);
}

// ── Messaging ────────────────────────────────────────────────────────────────

/** ⛔ Real money, never retried. */
export async function sendMessage(creds: StoredTelnyxCredentials, from: string, to: string, text: string): Promise<{ id: string | null }> {
  const res = await txExpect<any>(creds, { path: "/messages", method: "POST", json: { from, to, text } });
  return { id: res?.data?.id ?? null };
}

// ── Detail records (the attestation proof) ──────────────────────────────────

export interface TelnyxDetailRecord {
  recordType: string | null;
  startedAt: string | null;
  from: string | null;
  to: string | null;
  direction: string | null;
  durationSec: number | null;
  /** A / B / C / Unavailable / Invalid — Telnyx stamps outbound US calls. */
  stirShaken: string | null;
  cost: string | null;
}

export async function listVoiceDetailRecords(creds: StoredTelnyxCredentials, limit = 20): Promise<TelnyxDetailRecord[]> {
  // ⛔ Proven live 2026-09-15: the record type is "sip-trunking" (hyphenated;
  // "voice" answers 400 code 10011) and the attestation field is
  // `shaken_stir` — the first three real calls all read A, so touch these two
  // strings only with a CDR row on screen.
  const body = await txExpect<any>(creds, {
    path: "/detail_records",
    query: { "filter[record_type]": "sip-trunking", "page[size]": Math.min(Math.max(limit, 1), 50) },
  });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  const sipUser = (v: unknown): string | null => {
    const m = String(v ?? "").match(/sip:(\+?[^@;>]+)@/);
    return m ? m[1] : null;
  };
  return rows.map((r) => ({
    recordType: r?.record_type ?? null,
    startedAt: r?.started_at ?? r?.created_at ?? null,
    from: r?.from || sipUser(r?.sip_from_url) || null,
    to: r?.to || sipUser(r?.sip_full_to) || null,
    direction: r?.direction ?? null,
    durationSec: typeof r?.billed_sec === "number" ? r.billed_sec : (typeof r?.duration_sec === "number" ? r.duration_sec : null),
    stirShaken: r?.shaken_stir ?? r?.stir_shaken ?? null,
    cost: r?.cost ?? null,
  }));
}

// ── Number lookup ────────────────────────────────────────────────────────────

export interface TelnyxLookupResult {
  number: string;
  callerName: string | null;
  carrier: string | null;
  lineType: string | null;
  ported: string | null;
}

/** Carrier + caller-name lookup (~$0.002–0.007 per query — pennies, still money). */
export async function lookupNumber(creds: StoredTelnyxCredentials, number: string): Promise<TelnyxLookupResult> {
  // ⛔ Proven live 2026-09-15: the quickstart's bare-flag form
  // (`?carrier&caller-name`) answers 200 but with EMPTY carrier/caller_name
  // blocks — the add-ons only activate with repeated `type=` params (the SDK
  // form). Keep them on the path so buildUrl's empty-value skip can't touch
  // them.
  const body = await txExpect<any>(creds, { path: `/number_lookup/${encodeURIComponent(number)}?type=carrier&type=caller-name` });
  const d = body?.data ?? {};
  return {
    number: d?.phone_number ?? number,
    callerName: d?.caller_name?.caller_name ?? null,
    carrier: d?.carrier?.name ?? null,
    lineType: d?.carrier?.type ?? null,
    ported: d?.portability?.ported_status ?? null,
  };
}

// ── Messaging profiles ───────────────────────────────────────────────────────

export interface TelnyxMessagingProfile {
  id: string;
  name: string | null;
  enabled: boolean;
  webhookUrl: string | null;
}

export async function listMessagingProfiles(creds: StoredTelnyxCredentials): Promise<TelnyxMessagingProfile[]> {
  const body = await txExpect<any>(creds, { path: "/messaging_profiles", query: { "page[size]": 100 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    name: r?.name ?? null,
    enabled: Boolean(r?.enabled),
    webhookUrl: r?.webhook_url ?? null,
  })).filter((r) => r.id);
}

export async function createMessagingProfile(creds: StoredTelnyxCredentials, name: string, webhookUrl?: string | null): Promise<{ id: string | null }> {
  const json: any = { name, enabled: true };
  if (webhookUrl) json.webhook_url = webhookUrl;
  const res = await txExpect<any>(creds, { path: "/messaging_profiles", method: "POST", json });
  return { id: res?.data?.id ?? null };
}

// ── RCS ──────────────────────────────────────────────────────────────────────

export interface TelnyxRcsAgent {
  id: string;
  agentId: string | null;
  name: string | null;
  status: string | null;
}

/** RCS agents (brand-verified senders). Empty until an agent is registered. */
export async function listRcsAgents(creds: StoredTelnyxCredentials): Promise<TelnyxRcsAgent[]> {
  const body = await txExpect<any>(creds, { path: "/rcs_agents", query: { "page[size]": 50 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? r?.agent_id ?? ""),
    agentId: r?.agent_id ?? null,
    name: r?.agent_name ?? r?.name ?? null,
    status: r?.status ?? null,
  })).filter((r) => r.id);
}

/**
 * Send an RCS message with SMS fallback. ⛔ Real money, never retried.
 * The response's data.type says which path delivered ("RCS" or "SMS").
 */
export async function sendRcsMessage(creds: StoredTelnyxCredentials, input: {
  agentId: string;
  to: string;
  messagingProfileId: string;
  text: string;
  smsFallbackFrom?: string | null;
}): Promise<{ id: string | null; deliveredAs: string | null }> {
  const json: any = {
    agent_id: input.agentId,
    to: input.to,
    messaging_profile_id: input.messagingProfileId,
    agent_message: { content_message: { text: input.text } },
  };
  if (input.smsFallbackFrom) json.sms_fallback = { from: input.smsFallbackFrom, text: input.text };
  const res = await txExpect<any>(creds, { path: "/messages/rcs", method: "POST", json });
  return { id: res?.data?.id ?? null, deliveredAs: res?.data?.type ?? null };
}

// ── Email ────────────────────────────────────────────────────────────────────

export interface TelnyxEmailDomain {
  id: string;
  domain: string | null;
  status: string | null;
}

export async function listEmailDomains(creds: StoredTelnyxCredentials): Promise<TelnyxEmailDomain[]> {
  const body = await txExpect<any>(creds, { path: "/email_domains", query: { "page[size]": 50 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    domain: r?.domain ?? r?.domain_name ?? null,
    status: r?.status ?? r?.verification_status ?? null,
  })).filter((r) => r.id);
}

/** ⛔ Real money (fractions of a cent), never retried. */
export async function sendEmail(creds: StoredTelnyxCredentials, input: {
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<{ id: string | null }> {
  const res = await txExpect<any>(creds, {
    path: "/email_messages",
    method: "POST",
    json: { from: input.from, to: input.to, subject: input.subject, text: input.text },
  });
  return { id: res?.data?.id ?? null };
}

// ── Porting orders ───────────────────────────────────────────────────────────

export interface TelnyxPortingOrder {
  id: string;
  status: string | null;
  customerReference: string | null;
  phoneNumberCount: number | null;
  createdAt: string | null;
}

export async function listPortingOrders(creds: StoredTelnyxCredentials): Promise<TelnyxPortingOrder[]> {
  const body = await txExpect<any>(creds, { path: "/porting_orders", query: { "page[size]": 50 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    status: r?.status?.value ?? r?.status ?? null,
    customerReference: r?.customer_reference ?? null,
    phoneNumberCount: typeof r?.phone_number_count === "number" ? r.phone_number_count : (Array.isArray(r?.phone_numbers) ? r.phone_numbers.length : null),
    createdAt: r?.created_at ?? null,
  })).filter((r) => r.id);
}

/**
 * Create a DRAFT porting order. Free, files nothing — Telnyx auto-splits by
 * carrier/SPID/FastPort eligibility, and NOTHING moves until a separate
 * /submit (deliberately not wired here: submitting a port is a customer's
 * number changing carrier, an Izzy-gated act).
 */
export async function createPortingOrderDraft(creds: StoredTelnyxCredentials, numbers: string[], customerReference?: string | null): Promise<{ ids: string[] }> {
  const json: any = { phone_numbers: numbers };
  if (customerReference) json.customer_reference = customerReference;
  const res = await txExpect<any>(creds, { path: "/porting_orders", method: "POST", json });
  const rows: any[] = Array.isArray(res?.data) ? res.data : (res?.data ? [res.data] : []);
  return { ids: rows.map((r) => String(r?.id ?? "")).filter(Boolean) };
}

// ── Meeting API (beta) ───────────────────────────────────────────────────────

/** ⛔ Real money while the bot sits in the meeting (~$0.02/min). */
export async function createMeetingSession(creds: StoredTelnyxCredentials, meetingUrl: string): Promise<{ id: string | null; status: string | null }> {
  const res = await txExpect<any>(creds, { path: "/meeting_sessions", method: "POST", json: { meeting_url: meetingUrl } });
  return { id: res?.data?.id ?? null, status: res?.data?.status ?? null };
}

export async function getMeetingSession(creds: StoredTelnyxCredentials, id: string): Promise<any> {
  const res = await txExpect<any>(creds, { path: `/meeting_sessions/${encodeURIComponent(id)}` });
  return res?.data ?? null;
}
