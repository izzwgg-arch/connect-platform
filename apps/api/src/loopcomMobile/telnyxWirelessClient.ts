/**
 * Telnyx WIRELESS client — the provider layer under LoopCom Mobile.
 *
 * Same transport discipline as the voice bench (`../telnyx/telnyxClient`):
 * plain fetch, no SDK (the undici boot-kill lesson), injectable fetch for
 * tests, and ⛔ NOTHING that costs money or creates a durable provider object
 * is ever retried — a timeout on `purchaseEsims` or `createSimOrder` is
 * reported as "unknown — list before trying again", never re-sent.
 *
 * The endpoint set below was taken from Telnyx's official OpenAPI spec
 * (team-telnyx/openapi, fetched 2026-09-15) and the account was live-probed
 * the same day: /sim_cards, /sim_card_groups, /sim_card_orders, /ota_updates,
 * /wireless_blocklists, /mobile_operator_networks, wireless detail records and
 * /v2/mobile_phone_numbers ALL answer 200 on izzy@loopcom.net (empty — no SIM
 * exists yet). Mobile Voice (VoLTE) is BETA at Telnyx: the endpoints exist in
 * the spec (`/mobile_voice_connections`, `enable_voice`) but the public docs
 * say "API reference coming soon" — everything voice-shaped here must stay
 * capability-gated in the product until a real SIM proves it.
 *
 * Provider abstraction: routes/services import THIS module, never
 * ../telnyx/telnyxClient directly, so a second mobile carrier would be a new
 * client behind the same function shapes.
 */

import type { StoredTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { TelnyxError, classifyError, txRequest } from "../telnyx/telnyxClient";

export { TelnyxError };

async function wx<T = any>(creds: StoredTelnyxCredentials, req: Parameters<typeof txRequest>[1]): Promise<T> {
  const res = await txRequest<T>(creds, req);
  if (!res.ok) throw classifyError(res);
  return (res.data ?? ({} as T)) as T;
}

// ── SIM cards ────────────────────────────────────────────────────────────────

export interface WirelessSimCard {
  id: string;
  type: "physical" | "esim" | string;
  status: string | null;
  statusReason: string | null;
  iccid: string | null;
  imsi: string | null;
  msisdn: string | null;
  simCardGroupId: string | null;
  tags: string[];
  eid: string | null;
  esimInstallationStatus: string | null;
  voiceEnabled: boolean;
  dataLimitMb: number | null;
  currentPeriodDataMb: number | null;
  liveDataSession: string | null;
  currentMcc: string | null;
  currentMnc: string | null;
  currentImei: string | null;
  actionsInProgress: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  raw: any;
}

function toMb(obj: any): number | null {
  const amount = Number(obj?.amount);
  if (!Number.isFinite(amount)) return null;
  const unit = String(obj?.unit ?? "MB").toUpperCase();
  return unit === "GB" ? Math.round(amount * 1024) : Math.round(amount);
}

export function mapSimCard(r: any): WirelessSimCard {
  return {
    id: String(r?.id ?? ""),
    type: r?.type ?? "",
    status: r?.status?.value ?? null,
    statusReason: r?.status?.reason ?? null,
    iccid: r?.iccid ?? null,
    imsi: r?.imsi ?? null,
    msisdn: r?.msisdn ?? null,
    simCardGroupId: r?.sim_card_group_id ?? null,
    tags: Array.isArray(r?.tags) ? r.tags.map(String) : [],
    eid: r?.eid ?? null,
    esimInstallationStatus: r?.esim_installation_status ?? null,
    voiceEnabled: Boolean(r?.voice_enabled),
    dataLimitMb: toMb(r?.data_limit),
    currentPeriodDataMb: toMb(r?.current_billing_period_consumed_data),
    liveDataSession: r?.live_data_session ?? null,
    currentMcc: r?.current_mcc ?? null,
    currentMnc: r?.current_mnc ?? null,
    currentImei: r?.current_imei ?? null,
    actionsInProgress: Boolean(r?.actions_in_progress),
    createdAt: r?.created_at ?? null,
    updatedAt: r?.updated_at ?? null,
    raw: r,
  };
}

export async function listSimCards(creds: StoredTelnyxCredentials, opts?: { pageSize?: number; iccid?: string; status?: string }): Promise<WirelessSimCard[]> {
  const body = await wx<any>(creds, {
    path: "/sim_cards",
    query: {
      "page[size]": Math.min(Math.max(opts?.pageSize ?? 250, 1), 250),
      "filter[iccid]": opts?.iccid,
      "filter[status]": opts?.status,
    },
  });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map(mapSimCard).filter((s) => s.id);
}

export async function getSimCard(creds: StoredTelnyxCredentials, id: string): Promise<WirelessSimCard | null> {
  try {
    const body = await wx<any>(creds, { path: `/sim_cards/${encodeURIComponent(id)}` });
    return body?.data ? mapSimCard(body.data) : null;
  } catch (err) {
    if (err instanceof TelnyxError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The eSIM activation QR contents (LPA:1$smdp$matchingId). ⛔ Sensitive: it is
 * the key to installing the line on a device. Callers encrypt it at rest and
 * never log it.
 */
export async function getEsimActivationCode(creds: StoredTelnyxCredentials, id: string): Promise<string | null> {
  const body = await wx<any>(creds, { path: `/sim_cards/${encodeURIComponent(id)}/activation_code` });
  return body?.data?.activation_code ?? null;
}

export async function getSimDeviceDetails(creds: StoredTelnyxCredentials, id: string): Promise<any> {
  const body = await wx<any>(creds, { path: `/sim_cards/${encodeURIComponent(id)}/device_details` });
  return body?.data ?? null;
}

/** ⛔ Releases the SIM back to Telnyx. Not recoverable. */
export async function deleteSimCard(creds: StoredTelnyxCredentials, id: string): Promise<void> {
  await wx(creds, { path: `/sim_cards/${encodeURIComponent(id)}`, method: "DELETE" });
}

// ── SIM card actions (all async on Telnyx's side; poll the action) ──────────

export interface SimCardAction {
  id: string;
  simCardId: string | null;
  actionType: string | null;
  status: string | null;
  statusReason: string | null;
}

function mapAction(r: any): SimCardAction {
  return {
    id: String(r?.id ?? ""),
    simCardId: r?.sim_card_id ?? null,
    actionType: r?.action_type ?? null,
    status: r?.status?.value ?? null,
    statusReason: r?.status?.reason ?? null,
  };
}

async function simAction(creds: StoredTelnyxCredentials, id: string, action: string, json?: unknown): Promise<SimCardAction> {
  const body = await wx<any>(creds, { path: `/sim_cards/${encodeURIComponent(id)}/actions/${action}`, method: "POST", json });
  return mapAction(body?.data ?? {});
}

/** Connect the SIM to the network (requires a SIM card group). */
export const enableSim = (c: StoredTelnyxCredentials, id: string) => simAction(c, id, "enable");
/** Take the SIM off the network — the suspend lever. Reversible, free. */
export const disableSim = (c: StoredTelnyxCredentials, id: string) => simAction(c, id, "disable");
export const setSimStandby = (c: StoredTelnyxCredentials, id: string) => simAction(c, id, "set_standby");
/** Mobile Voice (BETA at Telnyx). connectionId = a Mobile Voice Connection. */
export const enableSimVoice = (c: StoredTelnyxCredentials, id: string, connectionId?: string | null) =>
  simAction(c, id, "enable_voice", connectionId ? { connection_id: connectionId } : undefined);
export const disableSimVoice = (c: StoredTelnyxCredentials, id: string) => simAction(c, id, "disable_voice");

export async function getSimCardAction(creds: StoredTelnyxCredentials, actionId: string): Promise<SimCardAction | null> {
  const body = await wx<any>(creds, { path: `/sim_card_actions/${encodeURIComponent(actionId)}` });
  return body?.data ? mapAction(body.data) : null;
}

// ── eSIM purchase + physical registration ────────────────────────────────────

/**
 * ⛔ REAL MONEY — buys eSIM profiles on the Telnyx account. Never retried.
 * `whitelabelName` puts a custom Service Provider Name (e.g. "LoopCom") on the
 * device's carrier line — the branded-eSIM lever.
 */
export async function purchaseEsims(creds: StoredTelnyxCredentials, opts: {
  amount: number;
  simCardGroupId?: string | null;
  whitelabelName?: string | null;
  status?: "enabled" | "disabled" | "standby";
  tags?: string[];
}): Promise<WirelessSimCard[]> {
  const json: any = { amount: Math.max(1, Math.floor(opts.amount)) };
  if (opts.simCardGroupId) json.sim_card_group_id = opts.simCardGroupId;
  if (opts.whitelabelName) {
    json.product = "whitelabel";
    json.whitelabel_name = opts.whitelabelName;
  }
  if (opts.status) json.status = opts.status;
  if (opts.tags?.length) json.tags = opts.tags;
  const body = await wx<any>(creds, { path: "/actions/purchase/esims", method: "POST", json });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map(mapSimCard).filter((s) => s.id);
}

/** Register physical SIMs by their registration codes (free — claims stock already shipped). */
export async function registerSimCards(creds: StoredTelnyxCredentials, registrationCodes: string[], simCardGroupId?: string | null, tags?: string[]): Promise<WirelessSimCard[]> {
  const json: any = { registration_codes: registrationCodes };
  if (simCardGroupId) json.sim_card_group_id = simCardGroupId;
  if (tags?.length) json.tags = tags;
  const body = await wx<any>(creds, { path: "/actions/register/sim_cards", method: "POST", json });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map(mapSimCard).filter((s) => s.id);
}

// ── SIM card groups (shared data limits) ─────────────────────────────────────

export interface SimCardGroup {
  id: string;
  name: string | null;
  isDefault: boolean;
  dataLimitMb: number | null;
  consumedDataMb: number | null;
}

export async function listSimCardGroups(creds: StoredTelnyxCredentials): Promise<SimCardGroup[]> {
  const body = await wx<any>(creds, { path: "/sim_card_groups", query: { "page[size]": 100 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    name: r?.name ?? null,
    isDefault: Boolean(r?.default),
    dataLimitMb: toMb(r?.data_limit),
    consumedDataMb: toMb(r?.consumed_data),
  })).filter((g) => g.id);
}

export async function createSimCardGroup(creds: StoredTelnyxCredentials, name: string, dataLimitMb?: number | null): Promise<{ id: string | null }> {
  const json: any = { name };
  if (dataLimitMb != null) json.data_limit = { amount: String(dataLimitMb), unit: "MB" };
  const body = await wx<any>(creds, { path: "/sim_card_groups", method: "POST", json });
  return { id: body?.data?.id ?? null };
}

// ── Physical SIM orders ──────────────────────────────────────────────────────

export interface SimCardOrder {
  id: string;
  quantity: number | null;
  status: string | null;
  costAmount: string | null;
  costCurrency: string | null;
  trackingUrl: string | null;
  createdAt: string | null;
  raw: any;
}

function mapOrder(r: any): SimCardOrder {
  return {
    id: String(r?.id ?? ""),
    quantity: typeof r?.quantity === "number" ? r.quantity : null,
    status: r?.status ?? null,
    costAmount: r?.cost?.amount ?? null,
    costCurrency: r?.cost?.currency ?? null,
    trackingUrl: r?.tracking_url ?? null,
    createdAt: r?.created_at ?? null,
    raw: r,
  };
}

/** Free: what would this order cost? (async preview) */
export async function previewSimCardOrder(creds: StoredTelnyxCredentials, quantity: number, addressId: string): Promise<{ totalCost: string | null; currency: string | null; shippingCost: string | null; simCardsCost: string | null }> {
  const body = await wx<any>(creds, { path: "/sim_card_order_preview", method: "POST", json: { quantity, address_id: addressId } });
  const d = body?.data ?? {};
  return {
    totalCost: d?.total_cost?.amount ?? null,
    currency: d?.total_cost?.currency ?? null,
    shippingCost: d?.shipping_cost?.amount ?? null,
    simCardsCost: d?.sim_cards_cost?.amount ?? null,
  };
}

/** ⛔ REAL MONEY — orders physical SIM stock shipped to an address. Never retried. */
export async function createSimCardOrder(creds: StoredTelnyxCredentials, quantity: number, addressId: string): Promise<SimCardOrder> {
  const body = await wx<any>(creds, { path: "/sim_card_orders", method: "POST", json: { quantity, address_id: addressId } });
  return mapOrder(body?.data ?? {});
}

export async function listSimCardOrders(creds: StoredTelnyxCredentials): Promise<SimCardOrder[]> {
  const body = await wx<any>(creds, { path: "/sim_card_orders", query: { "page[size]": 50 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map(mapOrder).filter((o) => o.id);
}

// ── Data usage notifications (provider-side thresholds → webhooks) ───────────

export async function createDataUsageNotification(creds: StoredTelnyxCredentials, simCardId: string, thresholdMb: number): Promise<{ id: string | null }> {
  const body = await wx<any>(creds, {
    path: "/sim_card_data_usage_notifications",
    method: "POST",
    json: { sim_card_id: simCardId, threshold: { amount: String(thresholdMb), unit: "MB" } },
  });
  return { id: body?.data?.id ?? null };
}

// ── Usage detail records ─────────────────────────────────────────────────────

export interface SimUsageDetailRecord {
  id: string | null;
  simCardId: string | null;
  recordedAt: string | null;
  dataMb: number | null;
  cost: string | null;
  raw: any;
}

/**
 * SIM data-usage detail records. ⛔ The record_type string is
 * "sim_card_usage" — live-probed 2026-09-15 (answers 200; "wireless" also
 * answers 200 but the spec's usage schema is SimCardUsageDetailRecord).
 */
export async function listSimUsageRecords(creds: StoredTelnyxCredentials, opts?: { pageSize?: number; startedAtGte?: string }): Promise<SimUsageDetailRecord[]> {
  const body = await wx<any>(creds, {
    path: "/detail_records",
    query: {
      "filter[record_type]": "sim_card_usage",
      "page[size]": Math.min(Math.max(opts?.pageSize ?? 50, 1), 50),
      "filter[date_range]": undefined,
      "filter[started_at][gte]": opts?.startedAtGte,
    },
  });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => {
    const down = Number(r?.downlink_data ?? r?.data_downlink ?? 0);
    const up = Number(r?.uplink_data ?? r?.data_uplink ?? 0);
    const unit = String(r?.data_unit ?? "MB").toUpperCase();
    let mb: number | null = Number.isFinite(down + up) ? down + up : null;
    if (mb != null && unit === "GB") mb = mb * 1024;
    if (mb != null && unit === "B") mb = mb / (1024 * 1024);
    if (mb != null && unit === "KB") mb = mb / 1024;
    return {
      id: r?.id ? String(r.id) : null,
      simCardId: r?.sim_card_id ?? null,
      recordedAt: r?.created_at ?? r?.close_time ?? null,
      dataMb: mb,
      cost: r?.cost?.amount ?? r?.cost ?? null,
      raw: r,
    };
  });
}

// ── Mobile Voice surfaces (BETA at Telnyx — read-mostly until GA) ────────────

export interface MobilePhoneNumber {
  id: string;
  phoneNumber: string | null;
  simCardId: string | null;
  status: string | null;
  connectionId: string | null;
  mobileVoiceEnabled: boolean;
  raw: any;
}

export async function listMobilePhoneNumbers(creds: StoredTelnyxCredentials): Promise<MobilePhoneNumber[]> {
  const body = await wx<any>(creds, { path: "/mobile_phone_numbers", query: { "page[size]": 100 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    phoneNumber: r?.phone_number ?? null,
    simCardId: r?.sim_card_id ?? null,
    status: r?.status ?? null,
    connectionId: r?.connection_id ?? null,
    mobileVoiceEnabled: Boolean(r?.mobile_voice_enabled),
    raw: r,
  })).filter((n) => n.id);
}

export async function listMobileVoiceConnections(creds: StoredTelnyxCredentials): Promise<Array<{ id: string; name: string | null; active: boolean }>> {
  const body = await wx<any>(creds, { path: "/mobile_voice_connections", query: { "page[size]": 100 } });
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({ id: String(r?.id ?? ""), name: r?.connection_name ?? null, active: Boolean(r?.active) })).filter((c) => c.id);
}
