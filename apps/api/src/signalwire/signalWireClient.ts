/**
 * SignalWire client — the carrier being evaluated as VoIP.ms's replacement.
 *
 * Plain `fetch`, no SDK. ⛔ apps/api has been killed on boot before by an
 * import that was not in its package.json (`undici` — blue/green refused the
 * cutover, see dependencyHygiene.test.ts). SignalWire's REST API is JSON over
 * HTTPS with Basic auth; an SDK would buy nothing and could cost the container.
 *
 * ── The three API families, and which is used for what ─────────────────────
 * SignalWire exposes THREE REST surfaces on the same Space, same credentials:
 *
 *   /api/relay/rest/…      "SignalWire REST API" — numbers (search / buy /
 *                          list / release / handlers), E911 addresses, the
 *                          10DLC registry, lookups. The number-management
 *                          surface lives here and nowhere else.
 *   /api/fabric/…          Call Fabric — SIP objects: SIP credentials (a
 *                          registering endpoint, i.e. what the PBX would
 *                          register as), SIP gateways (SignalWire pushing a
 *                          call TO an external SIP host, i.e. inbound to the
 *                          PBX without registration), phone routes.
 *   /api/laml/2010-04-01/… "Compatibility API" — Twilio-shaped. Used ONLY for
 *                          sending SMS/MMS and for the inbound-message webhook
 *                          contract, because that is the surface whose webhook
 *                          parameters and signature are actually documented.
 *
 * Auth is identical across all three: HTTP Basic, username = Project ID,
 * password = API token. Tokens do not expire but carry SCOPES — a 403 usually
 * means the token lacks `numbers` / `messaging` / `calling` for that call, and
 * `classifyError` says so in plain English rather than "forbidden".
 *
 * ── Why this is a CLIENT and not yet a provider ────────────────────────────
 * Nothing here is wired into onboarding, chat, billing SMS or the worker.
 * Those all ride the `GlobalVoipMsConfig` singleton + `vms()` today, and
 * cutting them over is a separate decision that needs a `TenantSmsNumber.
 * provider = SIGNALWIRE` migration, a worker change and a PBX trunk change.
 * This module exists so the platform owner can prove, from inside Loopcom,
 * that SignalWire can do each job before any of that is touched.
 *
 * ⛔ Every real call here can cost money (a purchase, a message, an E911
 * registration) or create a durable object on the SignalWire account. Nothing
 * retries a mutating request: a timeout on `purchaseNumber` is reported as
 * "unknown — check the number list", never re-sent.
 */

import type { StoredSignalWireCredentials } from "./signalWireCredentials";

// ── Transport ────────────────────────────────────────────────────────────────

export type SwFamily = "relay" | "fabric" | "laml" | "projects";

const FAMILY_PREFIX: Record<SwFamily, (creds: StoredSignalWireCredentials) => string> = {
  relay: () => "/api/relay/rest",
  fabric: () => "/api/fabric",
  laml: (c) => `/api/laml/2010-04-01/Accounts/${encodeURIComponent(c.projectId)}`,
  projects: () => "/api",
};

export interface SwRequest {
  family: SwFamily;
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body (relay / fabric / projects). */
  json?: unknown;
  /** Form body (Compatibility API). */
  form?: Record<string, string | number | boolean | undefined | null | Array<string>>;
  timeoutMs?: number;
}

export interface SwResponse<T = any> {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON, else null. */
  data: T | null;
  /** Raw text when the response was not JSON (HTML error pages etc.). */
  text: string | null;
  url: string;
}

export class SignalWireError extends Error {
  status: number;
  code: string;
  /** Plain-English explanation for the owner page. */
  userMessage: string;
  detail: unknown;
  constructor(status: number, code: string, userMessage: string, detail?: unknown) {
    super(userMessage);
    this.name = "SignalWireError";
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
    this.detail = detail;
  }
}

/** Basic auth header for a Space. Never logged. */
export function authHeader(creds: StoredSignalWireCredentials): string {
  return "Basic " + Buffer.from(`${creds.projectId}:${creds.apiToken}`, "utf8").toString("base64");
}

export function buildUrl(creds: StoredSignalWireCredentials, req: SwRequest): string {
  const url = new URL(`https://${creds.spaceUrl}${FAMILY_PREFIX[req.family](creds)}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Turn a non-2xx response into something a person can act on. The status
 * codes are the same across the three families; the bodies differ (relay /
 * fabric answer `{errors:[{detail}]}` or `{message}`, the Compatibility API
 * answers `{code, message, more_info}`), so the message extraction tries all
 * three shapes.
 */
export function classifyError(res: SwResponse): SignalWireError {
  const d: any = res.data;
  const providerMessage: string =
    (d && typeof d === "object" && (
      d.message ||
      d.error ||
      (Array.isArray(d.errors) && d.errors.map((e: any) => e?.detail || e?.message || e?.title || JSON.stringify(e)).join("; ")) ||
      (d.errors && typeof d.errors === "object" && Object.entries(d.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join("; "))
    )) ||
    (res.text ? res.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "") ||
    `HTTP ${res.status}`;

  switch (res.status) {
    case 401:
      return new SignalWireError(401, "unauthorized",
        "SignalWire rejected the credentials. Check the Space URL, Project ID and API token — the token is the one starting with PT, and it must belong to this project.", d);
    case 403:
      return new SignalWireError(403, "forbidden",
        `SignalWire refused this call (${providerMessage}). Usually the API token is missing a scope — it needs Numbers, Messaging and Calling for everything on this page. Make a new token with those scopes ticked.`, d);
    case 404:
      return new SignalWireError(404, "not_found", `SignalWire has no such thing (${providerMessage}).`, d);
    case 402:
      return new SignalWireError(402, "payment_required",
        `SignalWire refused for billing reasons (${providerMessage}). Trial accounts can only buy one number and only message verified numbers — add a card and fund at least $5 to leave trial mode.`, d);
    case 422:
    case 400:
      return new SignalWireError(res.status, "invalid_request", `SignalWire refused the request: ${providerMessage}`, d);
    case 429:
      return new SignalWireError(429, "rate_limited", "SignalWire is rate-limiting this account. Wait a moment and try again.", d);
    default:
      if (res.status >= 500) {
        return new SignalWireError(res.status, "provider_error", `SignalWire answered ${res.status} — that is their side. Try again in a minute.`, d);
      }
      return new SignalWireError(res.status, "unexpected", `Unexpected answer from SignalWire (${res.status}): ${providerMessage}`, d);
  }
}

/** One HTTP round trip. Throws SignalWireError on non-2xx or transport failure. */
export async function swRequest<T = any>(creds: StoredSignalWireCredentials, req: SwRequest): Promise<SwResponse<T>> {
  const url = buildUrl(creds, req);
  const headers: Record<string, string> = {
    authorization: authHeader(creds),
    accept: "application/json",
  };
  let body: string | undefined;
  if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.json);
  } else if (req.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(req.form)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const item of v) p.append(k, String(item));
      else p.set(k, String(v));
    }
    body = p.toString();
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
    });
  } catch (err: any) {
    const timedOut = String(err?.name || "").includes("Timeout") || String(err?.message || "").toLowerCase().includes("timeout");
    throw new SignalWireError(0, timedOut ? "timeout" : "network",
      timedOut
        ? `SignalWire did not answer within ${Math.round((req.timeoutMs ?? 20_000) / 1000)} seconds.`
        : `Couldn't reach ${creds.spaceUrl} (${String(err?.message || err).slice(0, 120)}). Check the Space URL.`,
      { message: String(err?.message || err) });
  }

  const text = await res.text().catch(() => "");
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  const out: SwResponse<T> = { ok: res.ok, status: res.status, data, text: data === null ? text : null, url };
  if (!res.ok) throw classifyError(out);
  return out;
}

// ── Numbers ──────────────────────────────────────────────────────────────────

export interface SwNumberSearchInput {
  numberType?: "local" | "toll-free";
  areaCode?: string;
  region?: string;
  city?: string;
  startsWith?: string;
  contains?: string;
  endsWith?: string;
  maxResults?: number;
}

export interface SwAvailableNumber {
  number: string;
  region: string | null;
  city: string | null;
  rateCenter: string | null;
  capabilities: { voice: boolean; sms: boolean; mms: boolean; fax: boolean };
}

export async function searchNumbers(creds: StoredSignalWireCredentials, input: SwNumberSearchInput): Promise<SwAvailableNumber[]> {
  const digits = (s?: string) => String(s ?? "").replace(/\D/g, "");
  const res = await swRequest(creds, {
    family: "relay",
    path: "/phone_numbers/search",
    query: {
      number_type: input.numberType ?? "local",
      areacode: digits(input.areaCode) || undefined,
      region: input.region?.trim() || undefined,
      city: input.city?.trim() || undefined,
      starts_with: digits(input.startsWith) || undefined,
      contains: digits(input.contains) || undefined,
      ends_with: digits(input.endsWith) || undefined,
      max_results: Math.min(Math.max(input.maxResults ?? 25, 1), 100),
    },
  });
  const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
  return rows.map(mapAvailableNumber).filter((r) => r.number);
}

function mapAvailableNumber(r: any): SwAvailableNumber {
  const caps = r?.capabilities;
  const has = (k: string) => Array.isArray(caps) ? caps.map((c: any) => String(c).toLowerCase()).includes(k) : Boolean(caps?.[k]);
  return {
    number: String(r?.number ?? r?.e164 ?? ""),
    region: r?.region ?? null,
    city: r?.city ?? null,
    rateCenter: r?.rate_center ?? null,
    capabilities: { voice: has("voice"), sms: has("sms"), mms: has("mms"), fax: has("fax") },
  };
}

export interface SwOwnedNumber {
  id: string;
  number: string;
  name: string | null;
  numberType: string | null;
  capabilities: string[];
  callHandler: string | null;
  callRequestUrl: string | null;
  callSipEndpointId: string | null;
  messageHandler: string | null;
  messageRequestUrl: string | null;
  e911AddressId: string | null;
  e911Status: string | null;
  createdAt: string | null;
  nextBilledAt: string | null;
  raw: Record<string, unknown>;
}

function mapOwnedNumber(r: any): SwOwnedNumber {
  return {
    id: String(r?.id ?? ""),
    number: String(r?.number ?? ""),
    name: r?.name ?? null,
    numberType: r?.number_type ?? null,
    capabilities: Array.isArray(r?.capabilities) ? r.capabilities.map(String) : [],
    callHandler: r?.call_handler ?? null,
    callRequestUrl: r?.call_request_url ?? null,
    callSipEndpointId: r?.call_sip_endpoint_id ?? null,
    messageHandler: r?.message_handler ?? null,
    messageRequestUrl: r?.message_request_url ?? null,
    e911AddressId: r?.e911_address_id ?? null,
    e911Status: r?.e911_status ?? null,
    createdAt: r?.created_at ?? null,
    nextBilledAt: r?.next_billed_at ?? null,
    raw: r && typeof r === "object" ? r : {},
  };
}

/** Every number on the project, following pagination. Capped at 20 pages. */
export async function listNumbers(creds: StoredSignalWireCredentials): Promise<SwOwnedNumber[]> {
  const out: SwOwnedNumber[] = [];
  let next: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const res: SwResponse = next
      ? await swRequestAbsolute(creds, next)
      : await swRequest(creds, { family: "relay", path: "/phone_numbers", query: { page_size: 100 } });
    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
    for (const r of rows) out.push(mapOwnedNumber(r));
    next = res.data?.links?.next ?? null;
    if (!next || rows.length === 0) break;
  }
  return out;
}

/** Follow a `links.next` URL SignalWire hands back (same host, same auth). */
async function swRequestAbsolute(creds: StoredSignalWireCredentials, absoluteUrl: string): Promise<SwResponse> {
  const u = new URL(absoluteUrl);
  if (u.host !== creds.spaceUrl) throw new SignalWireError(0, "bad_link", `Refusing to follow a pagination link to ${u.host}.`);
  const res = await fetch(u.toString(), { headers: { authorization: authHeader(creds), accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text().catch(() => "");
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const out: SwResponse = { ok: res.ok, status: res.status, data, text: data === null ? text : null, url: u.toString() };
  if (!res.ok) throw classifyError(out);
  return out;
}

export async function purchaseNumber(creds: StoredSignalWireCredentials, e164: string): Promise<SwOwnedNumber> {
  const res = await swRequest(creds, { family: "relay", path: "/phone_numbers", method: "POST", json: { number: e164 }, timeoutMs: 45_000 });
  return mapOwnedNumber(res.data);
}

export async function releaseNumber(creds: StoredSignalWireCredentials, id: string): Promise<void> {
  await swRequest(creds, { family: "relay", path: `/phone_numbers/${encodeURIComponent(id)}`, method: "DELETE" });
}

export interface SwNumberHandlerPatch {
  name?: string;
  callHandler?: "laml_webhooks" | "relay_sip_endpoint" | "relay_context" | "relay_script" | "laml_application";
  callRequestUrl?: string;
  callRequestMethod?: "GET" | "POST";
  callSipEndpointId?: string;
  messageHandler?: "laml_webhooks" | "relay_context" | "laml_application";
  messageRequestUrl?: string;
  messageRequestMethod?: "GET" | "POST";
}

export async function updateNumberHandlers(creds: StoredSignalWireCredentials, id: string, patch: SwNumberHandlerPatch): Promise<SwOwnedNumber> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.callHandler) body.call_handler = patch.callHandler;
  if (patch.callRequestUrl !== undefined) body.call_request_url = patch.callRequestUrl;
  if (patch.callRequestMethod) body.call_request_method = patch.callRequestMethod;
  if (patch.callSipEndpointId !== undefined) body.call_sip_endpoint_id = patch.callSipEndpointId;
  if (patch.messageHandler) body.message_handler = patch.messageHandler;
  if (patch.messageRequestUrl !== undefined) body.message_request_url = patch.messageRequestUrl;
  if (patch.messageRequestMethod) body.message_request_method = patch.messageRequestMethod;
  const res = await swRequest(creds, { family: "relay", path: `/phone_numbers/${encodeURIComponent(id)}`, method: "PUT", json: body });
  return mapOwnedNumber(res.data);
}

// ── Account / connection check ───────────────────────────────────────────────

export interface SwConnectionCheck {
  ok: boolean;
  /** Numbers scope proven (the list call worked). */
  numbersScope: boolean;
  /** Compatibility API reachable — messaging surface. */
  lamlReachable: boolean;
  projectName: string | null;
  projectStatus: string | null;
  ownedNumberCount: number | null;
  subprojectCount: number | null;
  message: string | null;
  code: string | null;
}

/**
 * Prove the credentials with READ calls only, and prove them on the two
 * surfaces the evaluation actually needs (relay numbers + Compatibility
 * messaging). Nothing here costs money.
 */
export async function checkConnection(creds: StoredSignalWireCredentials): Promise<SwConnectionCheck> {
  const out: SwConnectionCheck = {
    ok: false, numbersScope: false, lamlReachable: false, projectName: null, projectStatus: null,
    ownedNumberCount: null, subprojectCount: null, message: null, code: null,
  };
  try {
    const nums = await swRequest(creds, { family: "relay", path: "/phone_numbers", query: { page_size: 1 } });
    out.numbersScope = true;
    const rows = Array.isArray(nums.data?.data) ? nums.data.data : [];
    // The list answer carries no total; count from a full page walk only when
    // it is small, else say "1+". The Numbers panel does the real listing.
    out.ownedNumberCount = rows.length === 0 ? 0 : null;
    out.ok = true;
  } catch (err: any) {
    out.message = err instanceof SignalWireError ? err.userMessage : String(err?.message || err);
    out.code = err instanceof SignalWireError ? err.code : "unknown";
    return out;
  }
  try {
    const acct = await swRequest(creds, { family: "laml", path: ".json" });
    out.lamlReachable = true;
    out.projectName = acct.data?.friendly_name ?? null;
    out.projectStatus = acct.data?.status ?? null;
  } catch (err: any) {
    // The messaging surface refusing while numbers work is worth telling, not
    // failing over: it is exactly the "token lacks the messaging scope" case.
    out.message = err instanceof SignalWireError ? `Numbers work, but the messaging API refused: ${err.userMessage}` : null;
  }
  try {
    const projects = await swRequest(creds, { family: "projects", path: "/projects", query: { page_size: 100 } });
    const rows: any[] = Array.isArray(projects.data?.data) ? projects.data.data : Array.isArray(projects.data) ? projects.data : [];
    out.subprojectCount = rows.filter((p) => p?.subproject === true || p?.parent_project_id).length;
  } catch {
    // Not every token can list projects; the count is a nicety.
  }
  return out;
}

// ── SMS / MMS (Compatibility API) ────────────────────────────────────────────

export interface SwSendMessageInput {
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  statusCallback?: string;
}

export interface SwSentMessage {
  sid: string;
  status: string;
  numSegments: number | null;
  price: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export async function sendMessage(creds: StoredSignalWireCredentials, input: SwSendMessageInput): Promise<SwSentMessage> {
  const res = await swRequest(creds, {
    family: "laml",
    path: "/Messages.json",
    method: "POST",
    form: {
      From: input.from,
      To: input.to,
      Body: input.body,
      MediaUrl: input.mediaUrls?.length ? input.mediaUrls : undefined,
      StatusCallback: input.statusCallback,
    },
    timeoutMs: 30_000,
  });
  const d: any = res.data ?? {};
  return {
    sid: String(d.sid ?? ""),
    status: String(d.status ?? ""),
    numSegments: d.num_segments != null ? Number(d.num_segments) : null,
    price: d.price != null ? String(d.price) : null,
    errorCode: d.error_code != null ? String(d.error_code) : null,
    errorMessage: d.error_message ?? null,
  };
}

/** Read one message back (delivery status after the send). */
export async function getMessage(creds: StoredSignalWireCredentials, sid: string): Promise<SwSentMessage & { raw: unknown }> {
  const res = await swRequest(creds, { family: "laml", path: `/Messages/${encodeURIComponent(sid)}.json` });
  const d: any = res.data ?? {};
  return {
    sid: String(d.sid ?? sid),
    status: String(d.status ?? ""),
    numSegments: d.num_segments != null ? Number(d.num_segments) : null,
    price: d.price != null ? String(d.price) : null,
    errorCode: d.error_code != null ? String(d.error_code) : null,
    errorMessage: d.error_message ?? null,
    raw: d,
  };
}

// ── SIP profile ─────────────────────────────────────────────────────────────

export interface SwSipProfile {
  /** The registrar host, e.g. `loopcom-ef2ea3442802.sip.signalwire.com`. */
  domain: string | null;
  domainIdentifier: string | null;
  defaultCodecs: string[];
  defaultCiphers: string[];
  defaultEncryption: string | null;
  defaultSendAs: string | null;
  raw: unknown;
}

/**
 * The Space's SIP profile — the ONLY reliable source of the registrar host.
 * ⛔ It is NOT `<space>.sip.signalwire.com`: proven live 2026-08-18, the Space
 * `loopcom.signalwire.com` registers at `loopcom-ef2ea3442802.sip.signalwire.com`
 * (space + domain identifier). Guessing it from the Space URL registers nothing.
 */
export async function getSipProfile(creds: StoredSignalWireCredentials): Promise<SwSipProfile> {
  const res = await swRequest(creds, { family: "relay", path: "/sip_profile" });
  const d: any = res.data ?? {};
  return {
    domain: d.domain ?? null,
    domainIdentifier: d.domain_identifier ?? null,
    defaultCodecs: Array.isArray(d.default_codecs) ? d.default_codecs.map(String) : [],
    defaultCiphers: Array.isArray(d.default_ciphers) ? d.default_ciphers.map(String) : [],
    defaultEncryption: d.default_encryption ?? null,
    defaultSendAs: d.default_send_as ?? null,
    raw: d,
  };
}

// ── SIP (Fabric) ─────────────────────────────────────────────────────────────

export const SIP_CODECS = ["PCMU", "PCMA", "G722", "OPUS", "G729"] as const;
export const SIP_CIPHERS = [
  "AES_CM_128_HMAC_SHA1_80",
  "AES_256_CM_HMAC_SHA1_80",
  "AES_CM_128_HMAC_SHA1_32",
  "AES_256_CM_HMAC_SHA1_32",
] as const;

export interface SwSipEndpointInput {
  username: string;
  password: string;
  callerId?: string;
  /** A purchased or verified number, E.164. SignalWire uses a random account number when unset. */
  sendAs?: string;
  codecs?: string[];
  ciphers?: string[];
  encryption?: "optional" | "required" | "default";
  /** `passthrough` allows dialling the PSTN through this endpoint (a trunk). */
  callHandler?: "default" | "passthrough" | "block-pstn";
}

export interface SwSipEndpoint {
  id: string;
  username: string | null;
  callerId: string | null;
  sendAs: string | null;
  callHandler: string | null;
  codecs: string[];
  encryption: string | null;
  /** Which API answered — the Fabric path or the legacy relay one. */
  via: "fabric" | "relay-legacy";
  raw: unknown;
}

function mapSipEndpoint(r: any, via: SwSipEndpoint["via"]): SwSipEndpoint {
  const inner = r?.sip_endpoint && typeof r.sip_endpoint === "object" ? r.sip_endpoint : r;
  return {
    id: String(r?.id ?? inner?.id ?? ""),
    username: inner?.username ?? null,
    callerId: inner?.caller_id ?? null,
    sendAs: inner?.send_as ?? null,
    callHandler: inner?.call_handler ?? null,
    codecs: Array.isArray(inner?.codecs) ? inner.codecs.map(String) : [],
    encryption: inner?.encryption ?? null,
    via,
    raw: r,
  };
}

/**
 * Create the credential the PBX would REGISTER with (SignalWire's "SIP
 * endpoint" / "SIP credential"). Tries the Fabric resource first; the older
 * `/api/relay/rest/endpoints/sip` path is documented as deprecated but still
 * present, so it is the fallback when Fabric answers 404 — and the result says
 * which one worked, because that is part of what the evaluation is measuring.
 */
export async function createSipEndpoint(creds: StoredSignalWireCredentials, input: SwSipEndpointInput): Promise<SwSipEndpoint> {
  const body = {
    username: input.username,
    password: input.password,
    caller_id: input.callerId || undefined,
    send_as: input.sendAs || undefined,
    codecs: input.codecs?.length ? input.codecs : ["PCMU", "PCMA", "G722", "OPUS"],
    ciphers: input.ciphers?.length ? input.ciphers : undefined,
    encryption: input.encryption ?? "optional",
    call_handler: input.callHandler ?? "passthrough",
  };
  try {
    const res = await swRequest(creds, { family: "fabric", path: "/resources/sip_endpoints", method: "POST", json: body });
    return mapSipEndpoint(res.data, "fabric");
  } catch (err) {
    if (!(err instanceof SignalWireError) || err.status !== 404) throw err;
    const res = await swRequest(creds, { family: "relay", path: "/endpoints/sip", method: "POST", json: body });
    return mapSipEndpoint(res.data, "relay-legacy");
  }
}

export async function listSipEndpoints(creds: StoredSignalWireCredentials): Promise<SwSipEndpoint[]> {
  try {
    const res = await swRequest(creds, { family: "fabric", path: "/resources/sip_endpoints", query: { page_size: 100 } });
    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
    return rows.map((r) => mapSipEndpoint(r, "fabric"));
  } catch (err) {
    if (!(err instanceof SignalWireError) || err.status !== 404) throw err;
    const res = await swRequest(creds, { family: "relay", path: "/endpoints/sip", query: { page_size: 100 } });
    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
    return rows.map((r) => mapSipEndpoint(r, "relay-legacy"));
  }
}

export interface SwSipGatewayInput {
  name: string;
  /** `user@host[:port]` — where SignalWire should push inbound calls (the PBX). */
  uri: string;
  encryption?: "optional" | "required" | "default";
  codecs?: string[];
  ciphers?: string[];
}

export interface SwSipGateway {
  id: string;
  name: string | null;
  uri: string | null;
  encryption: string | null;
  codecs: string[];
  raw: unknown;
}

function mapSipGateway(r: any): SwSipGateway {
  const inner = r?.sip_gateway && typeof r.sip_gateway === "object" ? r.sip_gateway : r;
  return {
    id: String(r?.id ?? ""),
    name: r?.display_name ?? r?.name ?? inner?.name ?? null,
    uri: inner?.uri ?? null,
    encryption: inner?.encryption ?? null,
    codecs: Array.isArray(inner?.codecs) ? inner.codecs.map(String) : [],
    raw: r,
  };
}

/**
 * A SIP gateway is SignalWire pushing a call to an external SIP host — the
 * registration-less way to deliver an inbound call to the PBX. Assign a
 * number to it with `assignPhoneRoute`.
 */
export async function createSipGateway(creds: StoredSignalWireCredentials, input: SwSipGatewayInput): Promise<SwSipGateway> {
  const res = await swRequest(creds, {
    family: "fabric",
    path: "/resources/sip_gateways",
    method: "POST",
    json: {
      name: input.name,
      uri: input.uri,
      encryption: input.encryption ?? "optional",
      codecs: input.codecs?.length ? input.codecs : ["PCMU", "PCMA", "G722", "OPUS"],
      ciphers: input.ciphers?.length ? input.ciphers : undefined,
    },
  });
  return mapSipGateway(res.data);
}

export async function listSipGateways(creds: StoredSignalWireCredentials): Promise<SwSipGateway[]> {
  const res = await swRequest(creds, { family: "fabric", path: "/resources/sip_gateways", query: { page_size: 100 } });
  const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
  return rows.map(mapSipGateway);
}

/** Point a purchased number at a Fabric resource (gateway or endpoint) for calling or messaging. */
export async function assignPhoneRoute(
  creds: StoredSignalWireCredentials,
  resourceId: string,
  phoneNumberId: string,
  handler: "calling" | "messaging" = "calling",
): Promise<unknown> {
  const res = await swRequest(creds, {
    family: "fabric",
    path: `/resources/${encodeURIComponent(resourceId)}/phone_routes`,
    method: "POST",
    json: { phone_route_id: phoneNumberId, handler },
  });
  return res.data;
}

// ── E911 ─────────────────────────────────────────────────────────────────────

export interface SwE911AddressInput {
  label: string;
  firstName: string;
  lastName: string;
  streetNumber: string;
  streetName: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  addressType?: string;
  addressNumber?: string;
  autoCorrect?: boolean;
}

export interface SwE911Address {
  id: string;
  label: string | null;
  line: string;
  emergencyEnabled: boolean | null;
  raw: unknown;
}

function mapAddress(r: any): SwE911Address {
  const parts = [
    [r?.street_number, r?.street_name].filter(Boolean).join(" "),
    [r?.address_type, r?.address_number].filter(Boolean).join(" "),
    r?.city,
    [r?.state, r?.postal_code].filter(Boolean).join(" "),
  ].filter(Boolean);
  return {
    id: String(r?.id ?? ""),
    label: r?.label ?? null,
    line: parts.join(", "),
    emergencyEnabled: typeof r?.emergency_enabled === "boolean" ? r.emergency_enabled : null,
    raw: r,
  };
}

/**
 * Create (validate + store) an emergency address. SignalWire answers 422 with
 * candidate corrections when the address will not validate — the same
 * municipality-vs-postal-town trap the VoIP.ms path already handles (Monsey →
 * SPRING VALLEY), surfaced here as `detail` so the owner can read it.
 */
export async function createE911Address(creds: StoredSignalWireCredentials, input: SwE911AddressInput): Promise<SwE911Address> {
  const res = await swRequest(creds, {
    family: "relay",
    path: "/addresses",
    method: "POST",
    json: {
      label: input.label.slice(0, 32),
      country: input.country || "US",
      first_name: input.firstName,
      last_name: input.lastName,
      street_number: input.streetNumber,
      street_name: input.streetName,
      city: input.city,
      state: input.state,
      postal_code: input.postalCode,
      address_type: input.addressType || undefined,
      address_number: input.addressNumber || undefined,
      emergency_enabled: true,
      auto_correct_address: input.autoCorrect ?? true,
    },
  });
  return mapAddress(res.data);
}

export async function listE911Addresses(creds: StoredSignalWireCredentials): Promise<SwE911Address[]> {
  const res = await swRequest(creds, { family: "relay", path: "/addresses", query: { page_size: 100 } });
  const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
  return rows.map(mapAddress);
}

export async function assignE911Address(creds: StoredSignalWireCredentials, phoneNumberId: string, addressId: string): Promise<SwOwnedNumber> {
  const res = await swRequest(creds, {
    family: "relay",
    path: `/phone_numbers/${encodeURIComponent(phoneNumberId)}/e911_address`,
    method: "POST",
    json: { e911_address_id: addressId },
  });
  return mapOwnedNumber(res.data);
}

// ── Lookup (CNAM / carrier) ─────────────────────────────────────────────────

export async function lookupNumber(creds: StoredSignalWireCredentials, e164: string): Promise<{ cnam: string | null; carrier: string | null; lineType: string | null; raw: unknown }> {
  const res = await swRequest(creds, {
    family: "relay",
    path: `/lookup/phone_number/${encodeURIComponent(e164)}`,
    query: { include: "carrier,cnam" },
  });
  const d: any = res.data ?? {};
  return {
    cnam: d?.cnam?.caller_id ?? null,
    carrier: d?.carrier?.lec ?? null,
    lineType: d?.carrier?.linetype ?? null,
    raw: d,
  };
}
