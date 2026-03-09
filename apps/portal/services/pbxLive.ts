/**
 * PBX Live Metrics Service
 * Calls the real VitalPBX-backed live endpoints in the API.
 * VitalPBX /api/v2/cdr = completed calls only (written at hangup).
 * Active calls require Asterisk ARI; see /pbx/live/active-calls.
 */
import { apiGet } from "./apiClient";

export type PbxLiveSummary = {
  tenantId: string;
  callsToday: number;
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  answeredToday: number;
  missedToday: number;
  activeCalls: number;
  /** "ari" when real-time channel data was available; "unavailable" when ARI not configured */
  activeCallsSource: "ari" | "unavailable";
  /** Registered P/SIP endpoint count from ARI /ari/endpoints; null when ARI not configured */
  registeredEndpoints: number | null;
  /** Unregistered P/SIP endpoint count; null when ARI not configured */
  unregisteredEndpoints: number | null;
  lastUpdatedAt: string;
};

export type PbxActiveCall = {
  channelId: string;
  tenantId: string | null;
  direction: "incoming" | "outgoing" | "internal";
  caller: string;
  callee: string;
  extension: string | null;
  startedAt: string | null;
  durationSeconds: number;
  state: string;
  queue: string | null;
};

export type PbxActiveCallsResponse = {
  calls: PbxActiveCall[];
  source: "ari" | "unavailable";
  lastUpdatedAt: string;
};

export type AdminPbxLiveSummary = {
  totalCallsToday: number;
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  answeredToday: number;
  missedToday: number;
  totalActiveCalls: number;
  activeTenantsCount: number;
  topTenants: Array<{
    tenantId: string;
    callsToday: number;
    incomingToday: number;
    outgoingToday: number;
    internalToday: number;
    activeCalls: number;
    activeCallsSource: string;
  }>;
  lastUpdatedAt: string;
};

// Combined loaders — preferred.  One HTTP request returns both summary + calls.
export type PbxLiveCombined = { summary: PbxLiveSummary; activeCalls: PbxActiveCallsResponse };
export type AdminPbxLiveCombined = { summary: AdminPbxLiveSummary; activeCalls: PbxActiveCallsResponse };

export async function loadPbxLiveCombined(): Promise<PbxLiveCombined> {
  return apiGet<PbxLiveCombined>("/pbx/live/combined");
}

export async function loadAdminPbxLiveCombined(): Promise<AdminPbxLiveCombined> {
  return apiGet<AdminPbxLiveCombined>("/admin/pbx/live/combined");
}

// Legacy single-resource loaders kept for narrow consumers.
export async function loadPbxLiveSummary(): Promise<PbxLiveSummary> {
  return apiGet<PbxLiveSummary>("/pbx/live/summary");
}

export async function loadPbxActiveCalls(): Promise<PbxActiveCallsResponse> {
  return apiGet<PbxActiveCallsResponse>("/pbx/live/active-calls");
}

export async function loadAdminPbxLiveSummary(): Promise<AdminPbxLiveSummary> {
  return apiGet<AdminPbxLiveSummary>("/admin/pbx/live/summary");
}

export async function loadAdminPbxActiveCalls(): Promise<PbxActiveCallsResponse> {
  return apiGet<PbxActiveCallsResponse>("/admin/pbx/live/active-calls");
}

/** Format a duration in seconds as mm:ss */
export function formatDurationSec(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

/** Compact direction label */
export function directionLabel(d: "incoming" | "outgoing" | "internal"): string {
  if (d === "incoming") return "Inbound";
  if (d === "outgoing") return "Outbound";
  return "Internal";
}

/** CSS class for direction chips */
export function directionClass(d: "incoming" | "outgoing" | "internal"): string {
  if (d === "incoming") return "success";
  if (d === "outgoing") return "warning";
  return "info";
}
