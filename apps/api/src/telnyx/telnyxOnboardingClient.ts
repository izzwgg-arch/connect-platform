/**
 * Telnyx calls the SIGN-UP WIZARD needs (2026-09-16, Izzy: "switch the
 * onboarding wizard to Telnyx … make sure that it works end to end").
 *
 * Kept beside — not inside — `telnyxClient.ts`: the bench client carries its
 * own source guards and its "nothing here is wired into onboarding" promise,
 * and this file is exactly the part that IS wired into onboarding. Same one
 * transport (`txRequest`), same error classing, no SDK.
 *
 * Every shape below was read off the LIVE account before it was written
 * (2026-09-16 probe from inside app-api-1):
 *   • `filter[phone_number][starts_with|ends_with|contains]` match the
 *     NATIONAL number ("845…" finds +1845…), `national_destination_code` is
 *     the area code, `administrative_area` the state.
 *   • A `locality` that is not an exact rate-center name answers 400 code
 *     10031 "No numbers found … try again with best_effort=true" — so an
 *     empty locality search is a 400, NOT an empty 200. Callers must treat
 *     10031 as "nothing matched", never as an outage.
 *   • Number-order responses carry `phone_numbers[].status`; the owned-number
 *     id only exists once the order succeeds, found via /phone_numbers.
 *
 * ⛔ Mutating calls (orders, addresses, emergency, porting, 10DLC) are sent
 * EXACTLY ONCE. A timeout is "I stopped listening", never "it did not
 * happen" — callers reconcile by re-reading, never by re-sending.
 */
import type { StoredTelnyxCredentials } from "./telnyxCredentials";
import { classifyError, txRequest, TelnyxError, type TxRequest } from "./telnyxClient";

async function expect<T = any>(creds: StoredTelnyxCredentials, req: TxRequest): Promise<T> {
  const res = await txRequest<T>(creds, req);
  if (!res.ok) throw classifyError(res);
  return (res.data ?? ({} as T)) as T;
}

/** Telnyx's error codes, flattened — `10031` etc. — for callers that branch on them. */
export function telnyxErrorCodes(err: unknown): string[] {
  const d: any = err instanceof TelnyxError ? err.detail : null;
  return Array.isArray(d?.errors) ? d.errors.map((e: any) => String(e?.code ?? "")).filter(Boolean) : [];
}

/** One-line provider detail for a sign-up timeline. Never includes secrets. */
export function telnyxErrorDetail(err: unknown): string {
  if (err instanceof TelnyxError) {
    const d: any = err.detail;
    const inner = Array.isArray(d?.errors)
      ? d.errors.map((e: any) => [e?.code, e?.title, e?.detail, e?.source?.pointer].filter(Boolean).join(" ")).join("; ")
      : err.userMessage;
    return `${err.code}: ${String(inner).slice(0, 300)}`;
  }
  return String((err as any)?.message || err).slice(0, 300);
}

// ── Number search ────────────────────────────────────────────────────────────

export interface TxSearchInput {
  numberType: "local" | "toll_free";
  areaCode?: string;
  startsWith?: string;
  endsWith?: string;
  contains?: string;
  state?: string;
  locality?: string;
  limit?: number;
  /** Require these features (e.g. ["sms","voice"]). */
  features?: string[];
}

export interface TxAvailable {
  phoneNumber: string;
  state: string | null;
  locality: string | null;
  features: string[];
  numberType: string | null;
}

/** Search. A 10031 "no numbers found" is an EMPTY RESULT, not a failure. */
export async function searchAvailable(creds: StoredTelnyxCredentials, input: TxSearchInput): Promise<TxAvailable[]> {
  const query: Record<string, string | number | undefined> = {
    "filter[country_code]": "US",
    "filter[phone_number_type]": input.numberType,
    "filter[limit]": Math.min(Math.max(input.limit ?? 12, 1), 50),
  };
  if (input.areaCode) query["filter[national_destination_code]"] = input.areaCode;
  if (input.startsWith) query["filter[phone_number][starts_with]"] = input.startsWith;
  if (input.endsWith) query["filter[phone_number][ends_with]"] = input.endsWith;
  if (input.contains) query["filter[phone_number][contains]"] = input.contains;
  if (input.state) query["filter[administrative_area]"] = input.state;
  if (input.locality) query["filter[locality]"] = input.locality;
  if (input.features?.length) query["filter[features]"] = input.features.join(",");
  let body: any;
  try {
    body = await expect<any>(creds, { path: "/available_phone_numbers", query });
  } catch (e) {
    if (telnyxErrorCodes(e).includes("10031")) return [];
    throw e;
  }
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((r) => ({
      phoneNumber: String(r?.phone_number ?? ""),
      state: r?.region_information?.find?.((x: any) => x?.region_type === "state")?.region_name ?? null,
      locality: r?.region_information?.find?.((x: any) => x?.region_type === "location")?.region_name ?? null,
      features: Array.isArray(r?.features) ? r.features.map((f: any) => String(f?.name ?? "")).filter(Boolean) : [],
      numberType: r?.phone_number_type ?? null,
    }))
    .filter((r) => r.phoneNumber);
}

// ── Owned numbers + orders ───────────────────────────────────────────────────

export interface TxOwned {
  id: string;
  phoneNumber: string;
  status: string | null;
  connectionId: string | null;
  messagingProfileId: string | null;
  emergencyEnabled: boolean;
  emergencyStatus: string | null;
  emergencyAddressId: string | null;
  customerReference: string | null;
}

function mapOwned(r: any): TxOwned {
  return {
    id: String(r?.id ?? ""),
    phoneNumber: String(r?.phone_number ?? ""),
    status: r?.status ?? null,
    connectionId: r?.connection_id ? String(r.connection_id) : null,
    messagingProfileId: r?.messaging_profile_id ? String(r.messaging_profile_id) : null,
    emergencyEnabled: Boolean(r?.emergency_enabled),
    emergencyStatus: r?.emergency_status ?? null,
    emergencyAddressId: r?.emergency_address_id ? String(r.emergency_address_id) : null,
    customerReference: r?.customer_reference ?? null,
  };
}

/** The owned-number record for one E.164, or null. Read-only. */
export async function findOwnedNumber(creds: StoredTelnyxCredentials, e164: string): Promise<TxOwned | null> {
  const body = await expect<any>(creds, { path: "/phone_numbers", query: { "filter[phone_number]": e164, "page[size]": 5 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  const want = e164.replace(/\D/g, "");
  const hit = rows.find((r) => String(r?.phone_number ?? "").replace(/\D/g, "") === want);
  return hit ? mapOwned(hit) : null;
}

export interface TxOrder {
  id: string;
  status: string | null;
  numberStatus: string | null;
}

/** ⛔ Real money. Sent once. */
export async function placeNumberOrder(
  creds: StoredTelnyxCredentials,
  input: { e164: string; connectionId: string; messagingProfileId?: string | null; customerReference?: string | null },
): Promise<TxOrder> {
  const json: any = { phone_numbers: [{ phone_number: input.e164 }], connection_id: input.connectionId };
  if (input.messagingProfileId) json.messaging_profile_id = input.messagingProfileId;
  if (input.customerReference) json.customer_reference = input.customerReference.slice(0, 100);
  const body = await expect<any>(creds, { path: "/number_orders", method: "POST", json, timeoutMs: 45_000 });
  const d = body?.data ?? {};
  return { id: String(d?.id ?? ""), status: d?.status ?? null, numberStatus: d?.phone_numbers?.[0]?.status ?? null };
}

export async function getNumberOrder(creds: StoredTelnyxCredentials, id: string): Promise<TxOrder> {
  const body = await expect<any>(creds, { path: `/number_orders/${encodeURIComponent(id)}` });
  const d = body?.data ?? {};
  return { id: String(d?.id ?? id), status: d?.status ?? null, numberStatus: d?.phone_numbers?.[0]?.status ?? null };
}

/** Point an owned number at the connection / messaging profile, stamp the customer. */
export async function configureOwnedNumber(
  creds: StoredTelnyxCredentials,
  id: string,
  patch: { connectionId?: string; messagingProfileId?: string | null; customerReference?: string | null; tags?: string[] },
): Promise<void> {
  const json: any = {};
  if (patch.connectionId) json.connection_id = patch.connectionId;
  if (patch.customerReference) json.customer_reference = patch.customerReference.slice(0, 100);
  if (patch.tags) json.tags = patch.tags;
  if (Object.keys(json).length) {
    await expect(creds, { path: `/phone_numbers/${encodeURIComponent(id)}`, method: "PATCH", json });
  }
  // ⛔ Proven live 2026-09-16 (the first real Telnyx sign-up): the general
  // number PATCH refuses messaging_profile_id with 422/10027 "not reachable
  // here" — the messaging profile lives on its OWN sub-resource.
  if (patch.messagingProfileId) {
    await expect(creds, {
      path: `/phone_numbers/${encodeURIComponent(id)}/messaging`,
      method: "PATCH",
      json: { messaging_profile_id: patch.messagingProfileId },
    });
  }
}

/** Outbound CNAM — ≤15 chars, A-Z 0-9 space. Free. */
export function cnamFor(company: string): string {
  return String(company || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15)
    .trim();
}

export async function setNumberCnam(creds: StoredTelnyxCredentials, id: string, name: string): Promise<void> {
  const cnam = cnamFor(name);
  if (!cnam) return;
  await expect(creds, {
    path: `/phone_numbers/${encodeURIComponent(id)}/voice`,
    method: "PATCH",
    json: { cnam_listing: { cnam_listing_enabled: true, cnam_listing_details: cnam } },
  });
}

/** ⛔ Releases a number. Used only for a temporary port number AFTER the port completed. */
export async function releaseOwnedNumber(creds: StoredTelnyxCredentials, id: string): Promise<void> {
  await expect(creds, { path: `/phone_numbers/${encodeURIComponent(id)}`, method: "DELETE" });
}

// ── Emergency (E911) ─────────────────────────────────────────────────────────

export interface TxAddressInput {
  firstName: string;
  lastName: string;
  businessName: string;
  streetAddress: string;
  extendedAddress?: string | null;
  locality: string;
  administrativeArea: string;
  postalCode: string;
  phoneNumber?: string | null;
  customerReference?: string | null;
}

export interface TxAddress {
  id: string;
  streetAddress: string | null;
  extendedAddress: string | null;
  locality: string | null;
  administrativeArea: string | null;
  postalCode: string | null;
}

export interface TxAddressValidation {
  /** "valid" only when Telnyx says so; anything else is not registrable. */
  result: "valid" | "invalid";
  /** Telnyx error codes, e.g. 85009 (needs manual validation — NO suggestion), 20207/20209. */
  codes: string[];
  detail: string;
  suggested: { streetAddress: string; extendedAddress: string; locality: string; administrativeArea: string; postalCode: string } | null;
}

/**
 * Free, side-effect-free address check (`POST /addresses/actions/validate`).
 * ⛔ Telnyx puts its SUGGESTION in the body of the 422 — a client that turns a
 * non-2xx into a bare error throws the correction away (the VoIP.ms E911
 * lesson), so this reads the raw response.
 */
export async function validateAddress(
  creds: StoredTelnyxCredentials,
  input: { streetAddress: string; extendedAddress?: string | null; locality: string; administrativeArea: string; postalCode: string },
): Promise<TxAddressValidation> {
  const json: any = {
    street_address: input.streetAddress,
    locality: input.locality,
    administrative_area: input.administrativeArea,
    postal_code: input.postalCode,
    country_code: "US",
  };
  if (input.extendedAddress) json.extended_address = input.extendedAddress;
  const res = await txRequest<any>(creds, { path: "/addresses/actions/validate", method: "POST", json, timeoutMs: 30_000 });
  const d: any = res.data || {};
  if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) throw classifyError(res);
  const errors: any[] = Array.isArray(d.errors) ? d.errors : [];
  const s = d?.data?.suggested;
  return {
    result: res.ok && String(d?.data?.result || "").toLowerCase() === "valid" ? "valid" : "invalid",
    codes: errors.map((e) => String(e?.code ?? "")).filter(Boolean),
    detail: errors.map((e) => [e?.code, e?.title].filter(Boolean).join(" ")).join("; "),
    suggested: s && s.street_address
      ? {
          streetAddress: String(s.street_address || ""),
          extendedAddress: String(s.extended_address || ""),
          locality: String(s.locality || ""),
          administrativeArea: String(s.administrative_area || ""),
          postalCode: String(s.postal_code || ""),
        }
      : null,
  };
}

/** Create a validated address (Telnyx refuses an undeliverable one with suggestions). */
export async function createAddress(creds: StoredTelnyxCredentials, input: TxAddressInput): Promise<TxAddress> {
  const json: any = {
    first_name: input.firstName.slice(0, 50),
    last_name: input.lastName.slice(0, 50),
    business_name: input.businessName.slice(0, 100),
    street_address: input.streetAddress,
    locality: input.locality,
    administrative_area: input.administrativeArea,
    postal_code: input.postalCode,
    country_code: "US",
    address_book: false,
    validate_address: true,
  };
  if (input.extendedAddress) json.extended_address = input.extendedAddress;
  if (input.phoneNumber) json.phone_number = input.phoneNumber;
  if (input.customerReference) json.customer_reference = input.customerReference.slice(0, 100);
  const body = await expect<any>(creds, { path: "/addresses", method: "POST", json, timeoutMs: 45_000 });
  const d = body?.data ?? {};
  return {
    id: String(d?.id ?? ""),
    streetAddress: d?.street_address ?? null,
    extendedAddress: d?.extended_address ?? null,
    locality: d?.locality ?? null,
    administrativeArea: d?.administrative_area ?? null,
    postalCode: d?.postal_code ?? null,
  };
}

/** Enable E911 on an owned number at an address. Telnyx activates it asynchronously. */
export async function enableEmergency(creds: StoredTelnyxCredentials, numberId: string, addressId: string): Promise<{ status: string | null }> {
  const body = await expect<any>(creds, {
    path: `/phone_numbers/${encodeURIComponent(numberId)}/actions/enable_emergency`,
    method: "POST",
    json: { emergency_enabled: true, emergency_address_id: addressId },
    timeoutMs: 45_000,
  });
  const d = body?.data ?? {};
  return { status: d?.emergency_status ?? d?.emergency?.emergency_status ?? null };
}

// ── Porting ──────────────────────────────────────────────────────────────────

export interface TxPortingOrder {
  id: string;
  status: string | null;
  statusDetails: string[];
  phoneNumbers: string[];
  focDate: string | null;
  supportKey: string | null;
  /** Telnyx's own verdict (activation_settings.fast_port_eligible) — read live 2026-09-16. */
  fastPortEligible: boolean;
  focRequested: string | null;
}

function mapPortingOrder(r: any): TxPortingOrder {
  const status = r?.status?.value ?? r?.status ?? null;
  const details: any[] = Array.isArray(r?.status?.details) ? r.status.details : [];
  return {
    id: String(r?.id ?? ""),
    status: status ? String(status) : null,
    statusDetails: details.map((x: any) => [x?.code, x?.description].filter(Boolean).join(" ")).filter(Boolean),
    phoneNumbers: Array.isArray(r?.phone_numbers) ? r.phone_numbers.map((p: any) => String(p?.phone_number ?? p)) : [],
    focDate: r?.activation_settings?.foc_datetime_actual ?? r?.activation_settings?.foc_datetime_requested ?? null,
    supportKey: r?.support_key ?? null,
    fastPortEligible: r?.activation_settings?.fast_port_eligible === true,
    focRequested: r?.activation_settings?.foc_datetime_requested ?? null,
  };
}

/** Create DRAFT order(s) — Telnyx splits by losing carrier. Files nothing. */
export async function createPortingOrders(creds: StoredTelnyxCredentials, numbers: string[], customerReference?: string | null): Promise<TxPortingOrder[]> {
  const json: any = { phone_numbers: numbers };
  if (customerReference) json.customer_reference = customerReference.slice(0, 100);
  const body = await expect<any>(creds, { path: "/porting_orders", method: "POST", json, timeoutMs: 45_000 });
  const rows: any[] = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
  return rows.map(mapPortingOrder).filter((o) => o.id);
}

export async function getPortingOrder(creds: StoredTelnyxCredentials, id: string): Promise<TxPortingOrder> {
  const body = await expect<any>(creds, { path: `/porting_orders/${encodeURIComponent(id)}` });
  return mapPortingOrder(body?.data ?? {});
}

export async function listPortingOrdersByReference(creds: StoredTelnyxCredentials, customerReference: string): Promise<TxPortingOrder[]> {
  const body = await expect<any>(creds, {
    path: "/porting_orders",
    query: { "filter[customer_reference]": customerReference, "page[size]": 25 },
  });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map(mapPortingOrder).filter((o) => o.id);
}

export async function updatePortingOrder(creds: StoredTelnyxCredentials, id: string, json: Record<string, unknown>): Promise<TxPortingOrder> {
  const body = await expect<any>(creds, { path: `/porting_orders/${encodeURIComponent(id)}`, method: "PATCH", json, timeoutMs: 45_000 });
  return mapPortingOrder(body?.data ?? {});
}

/**
 * The switch-over windows Telnyx will accept for this order (FastPort orders are
 * "scheduled": the number moves at the requested moment). Read live 2026-09-16:
 * business-day windows 11:00Z–01:00Z (7 AM–9 PM ET), earliest two days out.
 */
export async function getAllowedFocWindows(creds: StoredTelnyxCredentials, id: string): Promise<Array<{ start: string; end: string }>> {
  const body = await expect<any>(creds, { path: `/porting_orders/${encodeURIComponent(id)}/allowed_foc_windows` });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((w) => ({ start: String(w?.started_at ?? w?.start_time ?? ""), end: String(w?.ended_at ?? w?.end_time ?? "") }))
    .filter((w) => w.start)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** ⛔ SUBMITS the port — the customer's number starts moving. Sent once. */
export async function confirmPortingOrder(creds: StoredTelnyxCredentials, id: string): Promise<TxPortingOrder> {
  const body = await expect<any>(creds, { path: `/porting_orders/${encodeURIComponent(id)}/actions/confirm`, method: "POST", timeoutMs: 45_000 });
  return mapPortingOrder(body?.data ?? {});
}

/** Upload a document (LOA / bill). Base64 JSON form. */
export async function uploadDocument(creds: StoredTelnyxCredentials, filename: string, bytes: Buffer, customerReference?: string | null): Promise<string> {
  const json: any = { file: bytes.toString("base64"), filename };
  if (customerReference) json.customer_reference = customerReference.slice(0, 100);
  const body = await expect<any>(creds, { path: "/documents", method: "POST", json, timeoutMs: 60_000 });
  const id = String(body?.data?.id ?? "");
  if (!id) throw new Error("telnyx_document_upload_returned_no_id");
  return id;
}

export async function getPortingRequirements(creds: StoredTelnyxCredentials, id: string): Promise<Array<{ typeId: string; name: string; fieldType: string | null; status: string | null }>> {
  const body = await expect<any>(creds, { path: `/porting_orders/${encodeURIComponent(id)}/requirements` });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    typeId: String(r?.requirement_type?.id ?? r?.requirement_type_id ?? ""),
    name: String(r?.requirement_type?.name ?? r?.field_type ?? ""),
    fieldType: r?.field_type ?? r?.requirement_type?.type ?? null,
    status: r?.requirement_status ?? null,
  }));
}

// ── 10DLC ────────────────────────────────────────────────────────────────────

export interface TxBrandInput {
  entityType: string;
  displayName: string;
  companyName: string;
  ein: string;
  phone: string;
  email: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  website?: string | null;
  vertical?: string | null;
}

export interface TxRegistryRecord {
  id: string;
  state: string | null;
}

/** ⛔ The EIN passes THROUGH this call and is not returned, logged or kept. */
export async function createTenDlcBrand(creds: StoredTelnyxCredentials, input: TxBrandInput): Promise<TxRegistryRecord> {
  const json: any = {
    entityType: input.entityType,
    displayName: input.displayName.slice(0, 100),
    companyName: input.companyName.slice(0, 100),
    ein: input.ein.replace(/\D/g, ""),
    einIssuingCountry: "US",
    phone: input.phone,
    email: input.email,
    street: input.street.slice(0, 100),
    city: input.city.slice(0, 100),
    state: input.state,
    postalCode: input.postalCode,
    country: "US",
    vertical: input.vertical || "PROFESSIONAL",
  };
  if (input.website) json.website = input.website;
  const body = await expect<any>(creds, { path: "/10dlc/brand", method: "POST", json, timeoutMs: 60_000 });
  return { id: String(body?.brandId ?? body?.data?.brandId ?? ""), state: brandState(body) };
}

function brandState(b: any): string | null {
  const identity = String(b?.identityStatus ?? "").toUpperCase();
  const status = String(b?.status ?? "").toUpperCase();
  if (status === "REGISTRATION_FAILED") return "failed";
  if (identity === "VERIFIED" || identity === "VETTED_VERIFIED" || identity === "SELF_DECLARED") return "approved";
  if (identity === "UNVERIFIED" && status === "OK") return "failed";
  return status || identity || null;
}

export async function getTenDlcBrand(creds: StoredTelnyxCredentials, brandId: string): Promise<TxRegistryRecord> {
  const body = await expect<any>(creds, { path: `/10dlc/brand/${encodeURIComponent(brandId)}` });
  return { id: brandId, state: brandState(body) };
}

export interface TxCampaignInput {
  usecase: string;
  subUsecases?: string[];
  description: string;
  sample1: string;
  sample2: string;
  messageFlow: string;
  helpMessage: string;
  optoutMessage: string;
}

function campaignState(c: any): string | null {
  const s = String(c?.campaignStatus ?? "").toUpperCase();
  if (["TCR_ACCEPTED", "TELNYX_ACCEPTED", "MNO_PENDING", "MNO_PROVISIONED", "ACTIVE"].includes(s)) return "approved";
  if (["TCR_FAILED", "TELNYX_FAILED", "MNO_REJECTED", "TCR_SUSPENDED", "TCR_EXPIRED", "DORMANT"].includes(s)) return "failed";
  return s || (c?.status ? String(c.status) : null);
}

export async function createTenDlcCampaign(creds: StoredTelnyxCredentials, brandId: string, input: TxCampaignInput): Promise<TxRegistryRecord> {
  const json: any = {
    brandId,
    usecase: input.usecase,
    ...(input.subUsecases?.length ? { subUsecases: input.subUsecases } : {}),
    description: input.description,
    sample1: input.sample1,
    sample2: input.sample2,
    messageFlow: input.messageFlow,
    helpMessage: input.helpMessage,
    optoutMessage: input.optoutMessage,
    helpKeywords: "HELP",
    optoutKeywords: "STOP",
    embeddedLink: false,
    embeddedPhone: false,
    numberPool: false,
    ageGated: false,
    directLending: false,
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    termsAndConditions: true,
    autoRenewal: true,
  };
  const body = await expect<any>(creds, { path: "/10dlc/campaignBuilder", method: "POST", json, timeoutMs: 60_000 });
  return { id: String(body?.campaignId ?? body?.data?.campaignId ?? ""), state: campaignState(body) };
}

export async function getTenDlcCampaign(creds: StoredTelnyxCredentials, campaignId: string): Promise<TxRegistryRecord> {
  const body = await expect<any>(creds, { path: `/10dlc/campaign/${encodeURIComponent(campaignId)}` });
  return { id: campaignId, state: campaignState(body) };
}

export async function assignNumberToCampaign(creds: StoredTelnyxCredentials, campaignId: string, e164: string): Promise<void> {
  await expect(creds, { path: "/10dlc/phone_number_campaigns", method: "POST", json: { phoneNumber: e164, campaignId }, timeoutMs: 45_000 });
}

// ── Messaging profile for onboarding numbers ────────────────────────────────

export async function listMessagingProfilesRaw(creds: StoredTelnyxCredentials): Promise<Array<{ id: string; name: string; webhookUrl: string | null }>> {
  const body = await expect<any>(creds, { path: "/messaging_profiles", query: { "page[size]": 100 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({ id: String(r?.id ?? ""), name: String(r?.name ?? ""), webhookUrl: r?.webhook_url ?? null })).filter((r) => r.id);
}

export async function createMessagingProfileWithWebhook(creds: StoredTelnyxCredentials, name: string, webhookUrl: string): Promise<string> {
  const body = await expect<any>(creds, {
    path: "/messaging_profiles",
    method: "POST",
    json: { name, enabled: true, webhook_url: webhookUrl, webhook_api_version: "2", whitelisted_destinations: ["US", "CA"] },
  });
  const id = String(body?.data?.id ?? "");
  if (!id) throw new Error("telnyx_messaging_profile_create_returned_no_id");
  return id;
}
