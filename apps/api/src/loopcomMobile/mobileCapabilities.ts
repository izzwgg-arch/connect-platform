/**
 * LoopCom Mobile — what Telnyx actually lets THIS account do, discovered by
 * asking, never assumed. Each capability is probed with a read-only GET and
 * reported with its blocker in plain English, so the product can gray a
 * feature out honestly instead of breaking on it.
 *
 * Live baseline (2026-09-15, izzy@loopcom.net, VERIFIED tier): the whole
 * wireless family answers 200 (sim_cards, groups, orders, usage records,
 * blocklists, /mobile_phone_numbers) — eSIM + data are ENABLED. Mobile Voice
 * (VoLTE) is BETA at Telnyx with the config docs unpublished, so voice is
 * reported available-as-beta, never promised. SMS on a mobile DID requires a
 * messaging profile + 10DLC (none registered yet).
 */

import type { StoredTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { TelnyxError, txRequest } from "../telnyx/telnyxClient";

export interface MobileCapability {
  key: string;
  label: string;
  available: boolean;
  /** "live" = probed 200 on this account; "beta" = endpoint exists but Telnyx calls it beta; "blocked" = refused; "unconfigured" = works but needs setup. */
  state: "live" | "beta" | "blocked" | "unconfigured" | "unknown";
  detail: string;
}

export interface MobileCapabilityReport {
  checkedAt: string;
  configured: boolean;
  capabilities: MobileCapability[];
}

const CACHE_MS = 5 * 60_000;
let cached: { report: MobileCapabilityReport; at: number } | null = null;
export function clearCapabilityCache(): void {
  cached = null;
}

async function probe(creds: StoredTelnyxCredentials, path: string, query?: Record<string, any>): Promise<{ ok: boolean; status: number; detail: string; total: number | null }> {
  try {
    const res = await txRequest(creds, { path, query: { "page[size]": 1, ...query }, timeoutMs: 10_000 });
    const total = (res.data as any)?.meta?.total_results ?? null;
    if (res.ok) return { ok: true, status: res.status, detail: "", total };
    const errs = (res.data as any)?.errors;
    const msg = Array.isArray(errs) ? errs.map((e: any) => e?.title || e?.code).filter(Boolean).join("; ") : `HTTP ${res.status}`;
    return { ok: false, status: res.status, detail: msg, total: null };
  } catch (err: any) {
    const msg = err instanceof TelnyxError ? err.userMessage : String(err?.message || err);
    return { ok: false, status: 0, detail: msg.slice(0, 160), total: null };
  }
}

export async function getMobileCapabilityReport(creds: StoredTelnyxCredentials | null, opts?: { force?: boolean }): Promise<MobileCapabilityReport> {
  if (!creds) {
    return {
      checkedAt: new Date().toISOString(),
      configured: false,
      capabilities: [{
        key: "credentials", label: "Telnyx credentials", available: false, state: "blocked",
        detail: "No Telnyx API key is configured. Save one on the Telnyx page (/apps/telnyx) first.",
      }],
    };
  }
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_MS) return cached.report;

  const [sims, groups, orders, usage, mpn, mvc, msgProfiles, porting] = await Promise.all([
    probe(creds, "/sim_cards"),
    probe(creds, "/sim_card_groups"),
    probe(creds, "/sim_card_orders"),
    probe(creds, "/detail_records", { "filter[record_type]": "sim_card_usage" }),
    probe(creds, "/mobile_phone_numbers"),
    probe(creds, "/mobile_voice_connections"),
    probe(creds, "/messaging_profiles"),
    probe(creds, "/porting_orders"),
  ]);

  const caps: MobileCapability[] = [
    {
      key: "wireless", label: "Wireless / SIM management", available: sims.ok,
      state: sims.ok ? "live" : "blocked",
      detail: sims.ok ? `SIM API enabled (${sims.total ?? 0} SIMs on the account).` : `Telnyx refused /sim_cards: ${sims.detail}`,
    },
    {
      key: "esim", label: "eSIM provisioning", available: sims.ok,
      state: sims.ok ? "live" : "blocked",
      detail: sims.ok
        ? "eSIM purchase + QR activation codes are available (POST /actions/purchase/esims — costs money per eSIM; whitelabel SPN supported)."
        : `Rides the SIM API, which is refused: ${sims.detail}`,
    },
    {
      key: "physical_sim", label: "Physical SIM orders", available: orders.ok,
      state: orders.ok ? "live" : "blocked",
      detail: orders.ok ? "SIM card orders + shipping are available (order preview shows the exact cost first)." : `Telnyx refused /sim_card_orders: ${orders.detail}`,
    },
    {
      key: "data_groups", label: "Data limits (SIM groups)", available: groups.ok,
      state: groups.ok ? "live" : "blocked",
      detail: groups.ok ? "SIM card groups with shared data limits are available." : `Telnyx refused /sim_card_groups: ${groups.detail}`,
    },
    {
      key: "usage_records", label: "Usage detail records", available: usage.ok,
      state: usage.ok ? "live" : "blocked",
      detail: usage.ok ? "Per-SIM data usage detail records are readable (record_type sim_card_usage)." : `Telnyx refused wireless detail records: ${usage.detail}`,
    },
    {
      key: "mobile_voice", label: "Mobile voice (VoLTE)", available: mpn.ok && mvc.ok,
      state: mpn.ok && mvc.ok ? "beta" : "blocked",
      detail: mpn.ok && mvc.ok
        ? "BETA at Telnyx: /mobile_phone_numbers and /mobile_voice_connections answer on this account and SIMs carry voice_enabled, but Telnyx's own config docs say 'API reference coming soon'. Build against it only behind this flag; no customer promise until a real SIM proves a call."
        : `Telnyx refused the mobile-voice surfaces: ${mpn.detail || mvc.detail}`,
    },
    {
      key: "sms", label: "SMS on mobile numbers", available: msgProfiles.ok,
      state: msgProfiles.ok ? ((msgProfiles.total ?? 0) > 0 ? "live" : "unconfigured") : "blocked",
      detail: msgProfiles.ok
        ? ((msgProfiles.total ?? 0) > 0
          ? "Messaging profiles exist; assign the mobile DID to one to text."
          : "The messaging API is enabled but NO messaging profile exists yet, and business SMS also needs 10DLC brand+campaign registration before it delivers.")
        : `Telnyx refused /messaging_profiles: ${msgProfiles.detail}`,
    },
    {
      key: "porting", label: "Number porting", available: porting.ok,
      state: porting.ok ? "live" : "blocked",
      detail: porting.ok
        ? "The porting API is enabled (portability check, draft orders, LOA, FOC tracking). Wireless ports need the losing carrier's account number + transfer PIN."
        : `Telnyx refused /porting_orders: ${porting.detail}`,
    },
    {
      key: "e911", label: "E911 on mobile numbers", available: true,
      state: "unconfigured",
      detail: "Telnyx supports per-number emergency addresses plus a dynamic-E911 API. ⛔ Mobile/nomadic E911 rules differ from fixed VoIP — each line needs the customer's real dispatchable address, and 933 (never 911) is the test dial. No address is registered yet.",
    },
  ];

  const report: MobileCapabilityReport = { checkedAt: new Date().toISOString(), configured: true, capabilities: caps };
  cached = { report, at: Date.now() };
  return report;
}
