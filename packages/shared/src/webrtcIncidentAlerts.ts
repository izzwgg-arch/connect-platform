/**
 * WebRTC admin incident trigger evaluation — pure helpers for API incident service.
 */
import { isWebrtcSdpRejection } from "./webrtcCallDiagnostics";

export const WEBRTC_INCIDENT_FAILURE_TYPES = {
  OUTBOUND_FAIL_CLUSTER: "outbound_fail_cluster",
  SDP_488_CLUSTER: "sdp_488_cluster",
  INBOUND_ANSWER_FAIL_CLUSTER: "inbound_answer_fail_cluster",
  OUTBOUND_DROUGHT: "outbound_drought",
  SUCCESS_RATE_LOW: "success_rate_low",
} as const;

export type WebrtcIncidentFailureType =
  (typeof WEBRTC_INCIDENT_FAILURE_TYPES)[keyof typeof WEBRTC_INCIDENT_FAILURE_TYPES];

export type WebrtcDiagEventRow = {
  id?: string;
  tenantId: string;
  userId?: string | null;
  createdAt: Date | string;
  payload: Record<string, unknown>;
};

export type WebrtcIncidentTrigger = {
  failureType: WebrtcIncidentFailureType;
  severity: "critical" | "warning";
  direction: "inbound" | "outbound" | "both";
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  latestSipCode: number | null;
  latestSipReason: string | null;
  affectedUserIds: string[];
  affectedExtensions: string[];
  sampleEventIds: string[];
  diagnosisSummary: string;
};

export const WEBRTC_INCIDENT_DISMISS_COOLDOWN_MS = 30 * 60 * 1000;
export const WEBRTC_SUCCESS_RATE_MIN_ATTEMPTS = 5;
export const WEBRTC_SUCCESS_RATE_CRITICAL = 0.2;
export const WEBRTC_SUCCESS_RATE_WARNING = 0.5;

function ts(row: WebrtcDiagEventRow): number {
  const t = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function payloadKind(p: Record<string, unknown>): string {
  return String(p.kind ?? "");
}

function debugKind(p: Record<string, unknown>): string {
  return String(p.debugKind ?? "");
}

export function buildWebrtcIncidentFingerprint(
  tenantId: string,
  failureType: string,
  timeBucketMs: number,
  bucketMinutes = 5,
): string {
  const bucket = Math.floor(timeBucketMs / (bucketMinutes * 60 * 1000));
  return `webrtc:${tenantId}:${failureType}:${bucket}`;
}

export function isWebrtcFailurePayload(p: Record<string, unknown>): boolean {
  if (payloadKind(p) === "WEBRTC_CALL_DEBUG") {
    const dk = debugKind(p);
    return (
      dk === "WEBRTC_OUTBOUND_FAIL" ||
      dk === "WEBRTC_SDP_REJECT" ||
      dk === "WEBRTC_INBOUND_ANSWER_FAIL"
    );
  }
  const endReason = String(p.endReason ?? "");
  return isWebrtcSdpRejection({ cause: endReason }) || endReason.toLowerCase().includes("incompatible sdp");
}

export function isWebrtcSuccessPayload(p: Record<string, unknown>): boolean {
  if (payloadKind(p) === "WEBRTC_CALL_DEBUG") {
    const dk = debugKind(p);
    return dk === "WEBRTC_OUTBOUND_SUMMARY" || dk === "WEBRTC_INBOUND_SUMMARY";
  }
  const endReason = String(p.endReason ?? "").toLowerCase();
  if (endReason === "user_hangup" || endReason === "normal") {
    const duration = typeof p.durationMs === "number" ? p.durationMs : 0;
    return duration > 2000;
  }
  return false;
}

export function isOutboundWebrtcFailure(p: Record<string, unknown>): boolean {
  if (String(p.direction ?? "") === "inbound") return false;
  if (debugKind(p) === "WEBRTC_INBOUND_ANSWER_FAIL") return false;
  if (isWebrtcFailurePayload(p)) {
    const dir = String(p.direction ?? "outbound");
    return dir !== "inbound";
  }
  return isWebrtcSdpRejection({
    sipCode: typeof p.sipStatusCode === "number" ? p.sipStatusCode : null,
    cause: String(p.endReason ?? p.failedCause ?? ""),
  });
}

export function isInboundAnswerFailure(p: Record<string, unknown>): boolean {
  if (debugKind(p) === "WEBRTC_INBOUND_ANSWER_FAIL") return true;
  const cat = String(p.diagnosisCategory ?? "");
  return (
    cat === "INBOUND_SESSION_NOT_FOUND_TIMEOUT" ||
    cat === "INBOUND_INVITE_NOT_RECEIVED" ||
    cat === "INBOUND_SIP_ANSWER_FAILED" ||
    // ⛔ Added 2026-08-06 WITH the category itself. `answer_unacked` failures
    // used to be mislabelled INBOUND_SESSION_NOT_FOUND_TIMEOUT and were caught
    // by the line above; splitting them into their own category would have
    // silently dropped them out of incident clustering for any payload that
    // lacks `debugKind` — i.e. the "fix" would have removed alerting. Keep this
    // list and InboundDiagnosisCategory in lockstep.
    cat === "INBOUND_ANSWER_UNACKED"
  );
}

export function isSdp488Failure(p: Record<string, unknown>): boolean {
  const sipFailure = p.sipFailure as Record<string, unknown> | undefined;
  const code =
    typeof sipFailure?.sipStatusCode === "number"
      ? sipFailure.sipStatusCode
      : typeof p.sipStatusCode === "number"
        ? p.sipStatusCode
        : null;
  const cause = String(sipFailure?.failedCause ?? p.failedCause ?? p.endReason ?? "");
  return isWebrtcSdpRejection({ sipCode: code, cause });
}

function inWindow(rows: WebrtcDiagEventRow[], nowMs: number, windowMs: number): WebrtcDiagEventRow[] {
  const cutoff = nowMs - windowMs;
  return rows.filter((r) => ts(r) >= cutoff);
}

function aggregateTrigger(
  failureType: WebrtcIncidentFailureType,
  severity: "critical" | "warning",
  direction: "inbound" | "outbound" | "both",
  matched: WebrtcDiagEventRow[],
  diagnosisSummary: string,
): WebrtcIncidentTrigger | null {
  if (matched.length === 0) return null;
  const sorted = [...matched].sort((a, b) => ts(a) - ts(b));
  const last = matched.reduce((a, b) => (ts(a) > ts(b) ? a : b));
  const lp = last.payload;
  const sipFailure = lp.sipFailure as Record<string, unknown> | undefined;
  const latestSipCode =
    typeof sipFailure?.sipStatusCode === "number"
      ? sipFailure.sipStatusCode
      : typeof lp.sipStatusCode === "number"
        ? lp.sipStatusCode
        : null;
  const latestSipReason = String(
    sipFailure?.sipReasonPhrase ?? sipFailure?.failedCause ?? lp.failedCause ?? lp.endReason ?? "",
  ).slice(0, 128) || null;

  const userIds = [...new Set(matched.map((r) => r.userId).filter(Boolean) as string[])];
  const extensions = [
    ...new Set(
      matched
        .map((r) => {
          const identity = r.payload.identity as Record<string, unknown> | undefined;
          return (
            (identity?.extensionNumber as string | undefined) ??
            (identity?.authUsername as string | undefined) ??
            (r.payload.calleeExtension as string | undefined) ??
            null
          );
        })
        .filter(Boolean) as string[],
    ),
  ];

  return {
    failureType,
    severity,
    direction,
    count: matched.length,
    firstSeenAt: new Date(ts(sorted[0]!)),
    lastSeenAt: new Date(ts(last)),
    latestSipCode,
    latestSipReason,
    affectedUserIds: userIds,
    affectedExtensions: extensions,
    sampleEventIds: matched.map((r) => r.id).filter(Boolean).slice(0, 5) as string[],
    diagnosisSummary,
  };
}

/** Evaluate all admin incident triggers for one tenant from recent diag rows. */
export function evaluateWebrtcIncidentTriggers(
  rows: WebrtcDiagEventRow[],
  nowMs: number = Date.now(),
): WebrtcIncidentTrigger[] {
  const out: WebrtcIncidentTrigger[] = [];

  const outboundFails5m = inWindow(rows, nowMs, 5 * 60 * 1000).filter((r) =>
    isOutboundWebrtcFailure(r.payload),
  );
  if (outboundFails5m.length >= 3) {
    const t = aggregateTrigger(
      WEBRTC_INCIDENT_FAILURE_TYPES.OUTBOUND_FAIL_CLUSTER,
      "critical",
      "outbound",
      outboundFails5m,
      `${outboundFails5m.length} outbound WebRTC failures in 5 minutes`,
    );
    if (t) out.push(t);
  }

  const sdp488_15m = inWindow(rows, nowMs, 15 * 60 * 1000).filter((r) => isSdp488Failure(r.payload));
  if (sdp488_15m.length >= 2) {
    const t = aggregateTrigger(
      WEBRTC_INCIDENT_FAILURE_TYPES.SDP_488_CLUSTER,
      "critical",
      "outbound",
      sdp488_15m,
      `${sdp488_15m.length} Incompatible SDP / 488 rejections in 15 minutes`,
    );
    if (t) out.push(t);
  } else if (sdp488_15m.length >= 1) {
    const t = aggregateTrigger(
      WEBRTC_INCIDENT_FAILURE_TYPES.SDP_488_CLUSTER,
      "warning",
      "outbound",
      sdp488_15m,
      "Incompatible SDP / 488 WebRTC rejection detected",
    );
    if (t) out.push(t);
  }

  const inboundFails5m = inWindow(rows, nowMs, 5 * 60 * 1000).filter((r) =>
    isInboundAnswerFailure(r.payload),
  );
  if (inboundFails5m.length >= 2) {
    const t = aggregateTrigger(
      WEBRTC_INCIDENT_FAILURE_TYPES.INBOUND_ANSWER_FAIL_CLUSTER,
      "critical",
      "inbound",
      inboundFails5m,
      `${inboundFails5m.length} inbound answer failures in 5 minutes`,
    );
    if (t) out.push(t);
  }

  const outbound30m = inWindow(rows, nowMs, 30 * 60 * 1000);
  const droughtFails = outbound30m.filter((r) => isOutboundWebrtcFailure(r.payload));
  const droughtSuccess = outbound30m.filter((r) => isWebrtcSuccessPayload(r.payload));
  if (droughtFails.length >= 5 && droughtSuccess.length === 0) {
    const t = aggregateTrigger(
      WEBRTC_INCIDENT_FAILURE_TYPES.OUTBOUND_DROUGHT,
      "critical",
      "outbound",
      droughtFails,
      `${droughtFails.length} outbound failures with zero successes in 30 minutes`,
    );
    if (t) out.push(t);
  }

  const rateWindow = inWindow(rows, nowMs, 15 * 60 * 1000);
  const attempts = rateWindow.filter(
    (r) => isWebrtcFailurePayload(r.payload) || isWebrtcSuccessPayload(r.payload),
  );
  const successes = attempts.filter((r) => isWebrtcSuccessPayload(r.payload));
  if (attempts.length >= WEBRTC_SUCCESS_RATE_MIN_ATTEMPTS) {
    const rate = successes.length / attempts.length;
    if (rate < WEBRTC_SUCCESS_RATE_CRITICAL) {
      const t = aggregateTrigger(
        WEBRTC_INCIDENT_FAILURE_TYPES.SUCCESS_RATE_LOW,
        "critical",
        "both",
        attempts.filter((r) => isWebrtcFailurePayload(r.payload)),
        `WebRTC success rate ${Math.round(rate * 100)}% (${successes.length}/${attempts.length}) in 15 minutes`,
      );
      if (t) out.push(t);
    } else if (rate < WEBRTC_SUCCESS_RATE_WARNING) {
      const t = aggregateTrigger(
        WEBRTC_INCIDENT_FAILURE_TYPES.SUCCESS_RATE_LOW,
        "warning",
        "both",
        attempts.filter((r) => isWebrtcFailurePayload(r.payload)),
        `WebRTC success rate ${Math.round(rate * 100)}% (${successes.length}/${attempts.length}) in 15 minutes`,
      );
      if (t) out.push(t);
    }
  }

  return out;
}

export function webrtcIncidentTitle(failureType: WebrtcIncidentFailureType): string {
  const map: Record<WebrtcIncidentFailureType, string> = {
    outbound_fail_cluster: "WebRTC outbound calling failures (cluster)",
    sdp_488_cluster: "WebRTC Incompatible SDP / 488 rejections",
    inbound_answer_fail_cluster: "WebRTC inbound answer failures",
    outbound_drought: "WebRTC outbound drought (no successful calls)",
    success_rate_low: "WebRTC calling success rate degraded",
  };
  return map[failureType] ?? "WebRTC calling incident";
}

export function webrtcIncidentSuggestedAction(failureType: WebrtcIncidentFailureType): string {
  const map: Record<WebrtcIncidentFailureType, string> = {
    outbound_fail_cluster:
      "Open Call Timeline / Call Flight for affected extensions. Check WEBRTC_CALL_DEBUG payloads and PBX channel creation. See WEBRTC_DIAGNOSTICS.md.",
    sdp_488_cluster:
      "Capture redacted SDP from WEBRTC_CALL_DEBUG rows. Compare offer codecs/DTLS with PBX endpoint allow list. Do not change PBX without evidence.",
    inbound_answer_fail_cluster:
      "Check mobile push → INVITE → answer pipeline in Call Flight. Look for session_not_found_timeout or sip_invite_not_received.",
    outbound_drought:
      "Verify SIP registration and WSS transport for affected tenant. Compare with last successful outbound in VoiceDiagEvent.",
    success_rate_low:
      "Review recent WEBRTC_CALL_DEBUG failures vs successes. Check TURN, registration, and tenant-wide outage patterns.",
  };
  return map[failureType];
}

export function webrtcIncidentDrillDownPath(failureType: WebrtcIncidentFailureType): string {
  if (failureType === WEBRTC_INCIDENT_FAILURE_TYPES.INBOUND_ANSWER_FAIL_CLUSTER) {
    return "/admin/call-flight";
  }
  return "/admin/call-timeline";
}
