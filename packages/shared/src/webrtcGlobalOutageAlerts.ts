/**
 * Platform-wide WebRTC outage detection — aggregates schema v2 diag rows across tenants.
 */
import {
  isInboundAnswerFailure,
  isOutboundWebrtcFailure,
  isSdp488Failure,
  isWebrtcFailurePayload,
  isWebrtcSuccessPayload,
  type WebrtcDiagEventRow,
} from "./webrtcIncidentAlerts";

export const GLOBAL_WEBRTC_OUTAGE_TYPE = "GLOBAL_WEBRTC_OUTAGE" as const;

export const GLOBAL_OUTAGE_WINDOW_MS = 15 * 60 * 1000;
export const GLOBAL_OUTAGE_DISMISS_COOLDOWN_MS = 30 * 60 * 1000;

/** Minimum diag attempts before global success-rate can fire. */
export const GLOBAL_SUCCESS_RATE_MIN_ATTEMPTS = 10;
export const GLOBAL_SUCCESS_RATE_CRITICAL = 0.25;
export const GLOBAL_SUCCESS_RATE_WARNING = 0.4;

export const GLOBAL_MULTI_TENANT_MIN = 3;
export const GLOBAL_SDP_CLUSTER_MIN = 10;
export const GLOBAL_INBOUND_CLUSTER_MIN = 10;
export const GLOBAL_MIXED_DIRECTION_MIN_EACH = 2;
export const GLOBAL_MIXED_DIRECTION_MIN_TENANTS = 2;

export type GlobalOutageTriggerReason =
  | "multi_tenant_failures"
  | "sdp_cluster"
  | "inbound_cluster"
  | "success_rate_collapse"
  | "mixed_direction_outage";

export type GlobalWebrtcOutageSnapshot = {
  failureType: typeof GLOBAL_WEBRTC_OUTAGE_TYPE;
  severity: "critical" | "warning";
  reasons: GlobalOutageTriggerReason[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  affectedTenantIds: string[];
  affectedUserIds: string[];
  activeIncidentCount: number;
  outboundFailureCount: number;
  inboundFailureCount: number;
  sdpFailureCount: number;
  successRate: number | null;
  successAttempts: number;
  successCount: number;
  latestDiagnosisCategory: string | null;
  latestSipCode: number | null;
  latestSipReason: string | null;
  sampleDiagEventIds: string[];
  diagnosisSummary: string;
};

function ts(row: WebrtcDiagEventRow): number {
  const t = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function inWindow(rows: WebrtcDiagEventRow[], nowMs: number, windowMs: number): WebrtcDiagEventRow[] {
  const cutoff = nowMs - windowMs;
  return rows.filter((r) => ts(r) >= cutoff);
}

function distinctTenants(rows: WebrtcDiagEventRow[]): string[] {
  return [...new Set(rows.map((r) => r.tenantId).filter(Boolean))];
}

function extractLatestDiagnosis(rows: WebrtcDiagEventRow[]): string | null {
  if (rows.length === 0) return null;
  const last = rows.reduce((a, b) => (ts(a) > ts(b) ? a : b));
  const cat = String(last.payload.diagnosisCategory ?? "");
  if (cat) return cat;
  const dk = String(last.payload.debugKind ?? "");
  return dk || null;
}

function extractLatestSip(last: WebrtcDiagEventRow): { code: number | null; reason: string | null } {
  const p = last.payload;
  const sipFailure = p.sipFailure as Record<string, unknown> | undefined;
  const code =
    typeof sipFailure?.sipStatusCode === "number"
      ? sipFailure.sipStatusCode
      : typeof p.sipStatusCode === "number"
        ? p.sipStatusCode
        : null;
  const reason = String(
    sipFailure?.sipReasonPhrase ?? sipFailure?.failedCause ?? p.failedCause ?? p.endReason ?? "",
  ).slice(0, 128) || null;
  return { code, reason };
}

export function buildGlobalOutageFingerprint(nowMs: number, bucketMinutes = 15): string {
  const bucket = Math.floor(nowMs / (bucketMinutes * 60 * 1000));
  return `webrtc:platform:${GLOBAL_WEBRTC_OUTAGE_TYPE}:${bucket}`;
}

/** Evaluate platform-wide WebRTC outage from cross-tenant diag rows + open tenant incidents. */
export function evaluateGlobalWebrtcOutage(input: {
  diagRows: WebrtcDiagEventRow[];
  openIncidentTenantIds?: string[];
  activeOpenIncidentCount?: number;
  nowMs?: number;
}): GlobalWebrtcOutageSnapshot | null {
  const nowMs = input.nowMs ?? Date.now();
  const window = inWindow(input.diagRows, nowMs, GLOBAL_OUTAGE_WINDOW_MS);
  const failureRows = window.filter((r) => isWebrtcFailurePayload(r.payload));
  const outboundFails = window.filter((r) => isOutboundWebrtcFailure(r.payload));
  const inboundFails = window.filter((r) => isInboundAnswerFailure(r.payload));
  const sdpFails = window.filter((r) => isSdp488Failure(r.payload));

  const failureTenants = distinctTenants(failureRows);
  const openTenants = [...new Set(input.openIncidentTenantIds ?? [])];
  const allAffectedTenants = [...new Set([...failureTenants, ...openTenants])];

  const attempts = window.filter(
    (r) => isWebrtcFailurePayload(r.payload) || isWebrtcSuccessPayload(r.payload),
  );
  const successes = attempts.filter((r) => isWebrtcSuccessPayload(r.payload));
  const successRate = attempts.length > 0 ? successes.length / attempts.length : null;

  const reasons: GlobalOutageTriggerReason[] = [];
  let severity: "critical" | "warning" = "warning";

  const multiTenantByFailures = failureTenants.length >= GLOBAL_MULTI_TENANT_MIN;
  const multiTenantByIncidents = openTenants.length >= GLOBAL_MULTI_TENANT_MIN;
  const multiTenantCombined = allAffectedTenants.length >= GLOBAL_MULTI_TENANT_MIN;
  if (multiTenantByFailures || multiTenantByIncidents || multiTenantCombined) {
    reasons.push("multi_tenant_failures");
    severity = "critical";
  }

  if (sdpFails.length >= GLOBAL_SDP_CLUSTER_MIN) {
    reasons.push("sdp_cluster");
    severity = "critical";
  } else if (sdpFails.length >= 5) {
    reasons.push("sdp_cluster");
    if (severity !== "critical") severity = "warning";
  }

  if (inboundFails.length >= GLOBAL_INBOUND_CLUSTER_MIN) {
    reasons.push("inbound_cluster");
    severity = "critical";
  } else if (inboundFails.length >= 5) {
    reasons.push("inbound_cluster");
    if (severity !== "critical") severity = "warning";
  }

  const outboundTenants = distinctTenants(outboundFails);
  const inboundTenants = distinctTenants(inboundFails);
  const mixedTenants = [...new Set([...outboundTenants, ...inboundTenants])];
  if (
    outboundFails.length >= GLOBAL_MIXED_DIRECTION_MIN_EACH &&
    inboundFails.length >= GLOBAL_MIXED_DIRECTION_MIN_EACH &&
    mixedTenants.length >= GLOBAL_MIXED_DIRECTION_MIN_TENANTS
  ) {
    reasons.push("mixed_direction_outage");
    severity = "critical";
  }

  if (attempts.length >= GLOBAL_SUCCESS_RATE_MIN_ATTEMPTS && successRate != null) {
    if (successRate < GLOBAL_SUCCESS_RATE_CRITICAL) {
      reasons.push("success_rate_collapse");
      severity = "critical";
    } else if (successRate < GLOBAL_SUCCESS_RATE_WARNING) {
      reasons.push("success_rate_collapse");
      if (severity !== "critical") severity = "warning";
    }
  }

  if (reasons.length === 0) return null;

  const sorted = failureRows.length > 0
    ? [...failureRows].sort((a, b) => ts(a) - ts(b))
    : [...window].sort((a, b) => ts(a) - ts(b));
  const firstSeenAt = sorted.length > 0 ? new Date(ts(sorted[0]!)) : new Date(nowMs);
  const lastRow = failureRows.length > 0
    ? failureRows.reduce((a, b) => (ts(a) > ts(b) ? a : b))
    : window.reduce((a, b) => (ts(a) > ts(b) ? a : b), sorted[0]!);
  const lastSeenAt = new Date(ts(lastRow));
  const sip = extractLatestSip(lastRow);

  const summaryParts: string[] = [];
  if (multiTenantCombined) summaryParts.push(`${allAffectedTenants.length} tenants affected`);
  if (sdpFails.length > 0) summaryParts.push(`${sdpFails.length} SDP/488 failures`);
  if (inboundFails.length > 0) summaryParts.push(`${inboundFails.length} inbound answer failures`);
  if (outboundFails.length > 0) summaryParts.push(`${outboundFails.length} outbound failures`);
  if (successRate != null && attempts.length >= GLOBAL_SUCCESS_RATE_MIN_ATTEMPTS) {
    summaryParts.push(`success rate ${Math.round(successRate * 100)}%`);
  }

  const userIds = [...new Set(failureRows.map((r) => r.userId).filter(Boolean) as string[])];

  return {
    failureType: GLOBAL_WEBRTC_OUTAGE_TYPE,
    severity,
    reasons,
    firstSeenAt,
    lastSeenAt,
    affectedTenantIds: allAffectedTenants.slice(0, 50),
    affectedUserIds: userIds.slice(0, 100),
    activeIncidentCount: input.activeOpenIncidentCount ?? openTenants.length,
    outboundFailureCount: outboundFails.length,
    inboundFailureCount: inboundFails.length,
    sdpFailureCount: sdpFails.length,
    successRate,
    successAttempts: attempts.length,
    successCount: successes.length,
    latestDiagnosisCategory: extractLatestDiagnosis(failureRows),
    latestSipCode: sip.code,
    latestSipReason: sip.reason,
    sampleDiagEventIds: failureRows.map((r) => r.id).filter(Boolean).slice(0, 10) as string[],
    diagnosisSummary: `Platform WebRTC outage signals: ${summaryParts.join("; ")}`,
  };
}

export type WebrtcPlatformHealthStatus = "healthy" | "degraded" | "critical";

export function computeWebrtcPlatformHealth(input: {
  diagRows: WebrtcDiagEventRow[];
  activeOpenIncidentCount: number;
  activeGlobalOutage: boolean;
  nowMs?: number;
}): {
  status: WebrtcPlatformHealthStatus;
  lastSuccessfulInbound: string | null;
  lastSuccessfulOutbound: string | null;
  activeIncidents: number;
  successRate: number | null;
  successAttempts: number;
  affectedTenants: number;
  outboundFailureCount15m: number;
  inboundFailureCount15m: number;
} {
  const nowMs = input.nowMs ?? Date.now();
  const window = inWindow(input.diagRows, nowMs, GLOBAL_OUTAGE_WINDOW_MS);
  const successes = window.filter((r) => isWebrtcSuccessPayload(r.payload));

  const lastInbound = successes
    .filter((r) => String(r.payload.direction ?? "") === "inbound" || debugIsInbound(r.payload))
    .sort((a, b) => ts(b) - ts(a))[0];
  const lastOutbound = successes
    .filter((r) => String(r.payload.direction ?? "") === "outbound" || !debugIsInbound(r.payload))
    .sort((a, b) => ts(b) - ts(a))[0];

  const attempts = window.filter(
    (r) => isWebrtcFailurePayload(r.payload) || isWebrtcSuccessPayload(r.payload),
  );
  const successRate = attempts.length > 0
    ? attempts.filter((r) => isWebrtcSuccessPayload(r.payload)).length / attempts.length
    : null;

  const outage = evaluateGlobalWebrtcOutage({
    diagRows: input.diagRows,
    activeOpenIncidentCount: input.activeOpenIncidentCount,
    nowMs,
  });

  let status: WebrtcPlatformHealthStatus = "healthy";
  if (input.activeGlobalOutage || outage?.severity === "critical") {
    status = "critical";
  } else if (outage?.severity === "warning" || input.activeOpenIncidentCount > 0) {
    status = "degraded";
  }

  return {
    status,
    lastSuccessfulInbound: lastInbound ? new Date(ts(lastInbound)).toISOString() : null,
    lastSuccessfulOutbound: lastOutbound ? new Date(ts(lastOutbound)).toISOString() : null,
    activeIncidents: input.activeOpenIncidentCount,
    successRate,
    successAttempts: attempts.length,
    affectedTenants: distinctTenants(window.filter((r) => isWebrtcFailurePayload(r.payload))).length,
    outboundFailureCount15m: window.filter((r) => isOutboundWebrtcFailure(r.payload)).length,
    inboundFailureCount15m: window.filter((r) => isInboundAnswerFailure(r.payload)).length,
  };
}

function debugIsInbound(p: Record<string, unknown>): boolean {
  return String(p.debugKind ?? "") === "WEBRTC_INBOUND_ANSWER_FAIL" ||
    String(p.debugKind ?? "") === "WEBRTC_INBOUND_SUMMARY";
}
