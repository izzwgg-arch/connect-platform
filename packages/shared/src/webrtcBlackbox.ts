/**
 * WebRTC black-box recorder — schema, SDP analysis, redaction, truncation.
 * Shared by portal, mobile, and API ingestion. Pure / side-effect-free except
 * createCallAttemptId uses Math.random.
 */

import {
  extractJsSipFailureFields,
  inferSipRejectionSource,
  isWebrtcSdpRejection,
  snapshotPeerConnection,
  SDP_REJECT_SIP_CODES,
  type JsSipFailureFields,
  type PeerConnectionSnapshot,
  type SipRejectionSource,
} from "./webrtcCallDiagnostics";

export {
  extractJsSipFailureFields,
  inferSipRejectionSource,
  isWebrtcSdpRejection,
  snapshotPeerConnection,
  SDP_REJECT_SIP_CODES,
  type JsSipFailureFields,
  type PeerConnectionSnapshot,
  type SipRejectionSource,
};

export const WEBRTC_BLACKBOX_SCHEMA_VERSION = 2;
export const WEBRTC_BLACKBOX_PAYLOAD_VERSION = 2;
export const WEBRTC_BLACKBOX_MAX_JSON_BYTES = 48_000;
export const WEBRTC_BLACKBOX_MAX_SDP_CHARS = 16_000;

export type BlackboxStage = {
  stage: string;
  tsMs: number;
  detail?: Record<string, unknown>;
};

export type SdpOfferSummary = {
  audioMLine: string | null;
  profiles: string[];
  payloadTypes: string[];
  audioCodecs: string[];
  fmtpLines: string[];
  extmapLines: string[];
  extmapCount: number;
  hasOpus: boolean;
  hasPcmu: boolean;
  hasPcma: boolean;
  hasRtcpMux: boolean;
  hasBundle: boolean;
  hasDtlsFingerprint: boolean;
  dtlsSetup: string | null;
  hasIceUfrag: boolean;
  hasIcePwd: boolean;
  hasIceLite: boolean;
  mLineCount: number;
  audioMLineCount: number;
  candidateCount: number;
  candidateTypes: string[];
};

export type OutboundDiagnosisCategory =
  | "OUTBOUND_MEDIA_SDP_REJECTED"
  | "OUTBOUND_AUTH_FAILED"
  | "OUTBOUND_NOT_REGISTERED"
  | "OUTBOUND_PERMISSION_DENIED"
  | "OUTBOUND_WEBRTC_FAILED"
  | "OUTBOUND_UNAVAILABLE"
  | "OUTBOUND_TRUNK_FAILED"
  | "OUTBOUND_FAILED_OTHER";

export type InboundDiagnosisCategory =
  | "INBOUND_SESSION_NOT_FOUND_TIMEOUT"
  | "INBOUND_INVITE_NOT_RECEIVED"
  | "INBOUND_SIP_ANSWER_FAILED"
  | "INBOUND_BACKEND_CLAIM_FAILED"
  | "INBOUND_MAX_ATTEMPTS"
  | "INBOUND_FAILED_OTHER";

export type WebrtcAlertKind =
  | "webrtc_outbound_488_spike"
  | "webrtc_outbound_fail_cluster"
  | "outbound_no_pbx_channel"
  | "inbound_claimed_no_sip_connect"
  | "session_not_found_timeout_spike"
  | "webrtc_contact_registration_loss"
  | "webrtc_outbound_drought"
  | "webrtc_diag_ingest_failure";

function sdpLines(sdp: string): string[] {
  return String(sdp || "").split(/\r\n|\r|\n/);
}

export function createCallAttemptId(prefix = "wbb"): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}_${r}`;
}

/** Stable non-reversible hash for device labels/ids (no crypto dep). */
export function hashStableId(input: string): string {
  const s = String(input || "");
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return `h${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function summarizeCandidateTypes(sdp: string): { count: number; types: string[] } {
  const types = new Set<string>();
  let count = 0;
  for (const raw of sdpLines(sdp)) {
    const line = raw.trim();
    if (!line.startsWith("a=candidate:")) continue;
    count += 1;
    const typMatch = line.match(/\btyp\s+(\S+)/i);
    if (typMatch?.[1]) types.add(typMatch[1].toLowerCase());
  }
  return { count, types: [...types].sort() };
}

export function summarizeOfferSdp(sdp: string): SdpOfferSummary {
  const ls = sdpLines(sdp);
  const profiles: string[] = [];
  const payloadTypes: string[] = [];
  const audioCodecs: string[] = [];
  const fmtpLines: string[] = [];
  const extmapLines: string[] = [];
  let mLineCount = 0;
  let audioMLineCount = 0;
  let audioMLine: string | null = null;
  let inFirstAudio = false;
  let seenFirstAudio = false;

  for (const raw of ls) {
    const line = raw.trim();
    if (line.startsWith("m=")) {
      mLineCount += 1;
      const parts = line.slice(2).split(/\s+/);
      const media = parts[0] || "";
      const proto = parts[2] || "";
      if (proto) profiles.push(proto);
      const isAudio = media === "audio";
      if (isAudio) {
        audioMLineCount += 1;
        if (!audioMLine) audioMLine = line;
        if (parts.length > 3) payloadTypes.push(...parts.slice(3));
      }
      inFirstAudio = isAudio && !seenFirstAudio;
      if (inFirstAudio) seenFirstAudio = true;
      continue;
    }
    if (inFirstAudio && line.startsWith("a=rtpmap:")) {
      const v = line.slice("a=rtpmap:".length).split(/\s+/)[1];
      if (v) audioCodecs.push(v);
    }
    if (inFirstAudio && line.startsWith("a=fmtp:")) fmtpLines.push(line);
    if (line.startsWith("a=extmap:")) {
      extmapLines.push(line.slice(0, 120));
    }
  }

  const lower = String(sdp || "").toLowerCase();
  const codecsLower = audioCodecs.map((c) => c.toLowerCase());
  const setupMatch = ls.map((l) => l.trim()).find((l) => l.startsWith("a=setup:"));
  const { count: candidateCount, types: candidateTypes } = summarizeCandidateTypes(sdp);

  return {
    audioMLine,
    profiles,
    payloadTypes: payloadTypes.slice(0, 32),
    audioCodecs,
    fmtpLines: fmtpLines.slice(0, 24),
    extmapLines: extmapLines.slice(0, 32),
    extmapCount: extmapLines.length,
    hasOpus: codecsLower.some((c) => c.startsWith("opus")),
    hasPcmu: codecsLower.some((c) => c.startsWith("pcmu")),
    hasPcma: codecsLower.some((c) => c.startsWith("pcma")),
    hasRtcpMux: lower.includes("a=rtcp-mux"),
    hasBundle: lower.includes("a=group:bundle"),
    hasDtlsFingerprint: lower.includes("a=fingerprint:"),
    dtlsSetup: setupMatch ? setupMatch.slice("a=setup:".length).trim() : null,
    hasIceUfrag: lower.includes("a=ice-ufrag:"),
    hasIcePwd: lower.includes("a=ice-pwd:"),
    hasIceLite: lower.includes("a=ice-lite"),
    mLineCount,
    audioMLineCount,
    candidateCount,
    candidateTypes,
  };
}

export function checkOfferCompatibility(summary: SdpOfferSummary): string[] {
  const issues: string[] = [];
  if (summary.audioMLineCount === 0) issues.push("no m=audio section in offer");
  if (summary.audioCodecs.length > 0 && !summary.hasOpus && !summary.hasPcmu && !summary.hasPcma) {
    issues.push("offer has no opus/PCMU/PCMA");
  }
  if (summary.profiles.length > 0 && !summary.profiles.some((p) => p.includes("SAVPF") || p.includes("SAVP"))) {
    issues.push(`non-secure media profile(s): ${summary.profiles.join(",")}`);
  }
  if (!summary.hasDtlsFingerprint) issues.push("missing a=fingerprint (DTLS)");
  if (!summary.hasIceUfrag || !summary.hasIcePwd) issues.push("missing ICE ufrag/pwd");
  if (!summary.hasRtcpMux) issues.push("missing a=rtcp-mux");
  return issues;
}

export function redactSdpForDebug(sdp: string): string {
  return String(sdp || "")
    .replace(/^(a=ice-ufrag:).*$/gim, "$1[REDACTED]")
    .replace(/^(a=ice-pwd:).*$/gim, "$1[REDACTED]")
    .replace(/^(a=candidate:.*)$/gim, (line) =>
      line
        .replace(/(\d{1,3}\.){3}\d{1,3}/g, "x.x.x.x")
        .replace(/\b([0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]+\b/g, "x:x:x"))
    .replace(/^(c=IN IP4 ).*$/gim, "$1x.x.x.x")
    .slice(0, WEBRTC_BLACKBOX_MAX_SDP_CHARS);
}

const SECRET_KEY_PATTERN = /password|secret|token|authorization|jwt|bearer|credential|ice-ufrag|ice-pwd|iceufrag|icepwd|ufrag/i;

export function redactSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^Bearer\s+/i.test(value)) return "Bearer [REDACTED]";
    if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)) return "[REDACTED_JWT]";
    if (value.length > 500 && SECRET_KEY_PATTERN.test(value)) return "[REDACTED_STRING]";
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((v) => redactSecretsDeep(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecretsDeep(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function summarizeJsSipFailureEvent(event: unknown): Record<string, unknown> {
  const fields = extractJsSipFailureFields(event);
  const e = (event ?? {}) as Record<string, unknown>;
  return {
    sipStatusCode: fields.sipStatusCode,
    sipReasonPhrase: fields.sipReasonPhrase,
    sipMethod: fields.sipMethod,
    failedCause: fields.failedCause,
    failedOriginator: fields.failedOriginator,
    sipRejectionSource: inferSipRejectionSource(fields),
    hasMessage: !!e.message,
    hasResponse: !!e.response,
  };
}

export function snapshotPeerConnectionExtended(pc: unknown): Record<string, unknown> | null {
  const base = snapshotPeerConnection(pc);
  if (!pc || typeof pc !== "object") return base;
  const conn = pc as RTCPeerConnection;
  try {
    const local = conn.localDescription;
    const remote = conn.remoteDescription;
    return {
      ...base,
      peerConnectionCreated: true,
      localDescriptionType: local?.type ?? null,
      remoteDescriptionExists: !!remote?.sdp,
      remoteDescriptionType: remote?.type ?? null,
    };
  } catch {
    return base ? { ...base, peerConnectionCreated: true } : null;
  }
}

export function classifyOutboundDiagnosis(input: {
  sipCode?: number | null;
  sipCause?: string | null;
  sipReason?: string | null;
  permissionDenied?: boolean;
  notRegistered?: boolean;
}): OutboundDiagnosisCategory {
  if (input.permissionDenied) return "OUTBOUND_PERMISSION_DENIED";
  if (input.notRegistered) return "OUTBOUND_NOT_REGISTERED";
  const code = typeof input.sipCode === "number" ? input.sipCode : null;
  const cause = String(input.sipCause || "").toLowerCase();
  if (code === 401 || code === 403 || code === 407) return "OUTBOUND_AUTH_FAILED";
  if (isWebrtcSdpRejection({ sipCode: code, cause: input.sipCause })) {
    return "OUTBOUND_MEDIA_SDP_REJECTED";
  }
  if (cause.includes("ice") || cause.includes("webrtc") || cause.includes("peerconnection")) {
    return "OUTBOUND_WEBRTC_FAILED";
  }
  if (code === 480 || code === 486 || code === 600 || code === 603) return "OUTBOUND_UNAVAILABLE";
  if (code === 503 || code === 502 || code === 504) return "OUTBOUND_TRUNK_FAILED";
  return "OUTBOUND_FAILED_OTHER";
}

export function classifyInboundDiagnosis(input: {
  failureReason?: string | null;
  backendAcceptCode?: string | null;
  inviteNotReceived?: boolean;
}): InboundDiagnosisCategory {
  const reason = String(input.failureReason || "").toLowerCase();
  if (reason === "session_not_found_timeout") return "INBOUND_SESSION_NOT_FOUND_TIMEOUT";
  if (reason === "max_attempts") return "INBOUND_MAX_ATTEMPTS";
  if (input.inviteNotReceived || reason === "sip_invite_not_received") {
    return "INBOUND_INVITE_NOT_RECEIVED";
  }
  if (input.backendAcceptCode && input.backendAcceptCode !== "INVITE_CLAIMED_OK") {
    return "INBOUND_BACKEND_CLAIM_FAILED";
  }
  if (reason.includes("answer")) return "INBOUND_SIP_ANSWER_FAILED";
  return "INBOUND_FAILED_OTHER";
}

export function buildPbxHint(input: {
  endpointName?: string | null;
  tenantId?: string | null;
  extension?: string | null;
  pbxCallId?: string | null;
  sipCallId?: string | null;
  channelNotCreated?: boolean;
}): Record<string, unknown> {
  const endpoint = input.endpointName ?? null;
  const ext = input.extension ?? null;
  return {
    endpointName: endpoint,
    tenantId: input.tenantId ?? null,
    extension: ext,
    pbxCallId: input.pbxCallId ?? null,
    sipCallId: input.sipCallId ?? null,
    channelName: endpoint ? `PJSIP/${endpoint}` : null,
    cdrLookupHint: input.pbxCallId ?? null,
    channelNotCreated: input.channelNotCreated ?? null,
    trunkNotReached: input.channelNotCreated ?? null,
  };
}

export type TruncateResult = {
  payload: Record<string, unknown>;
  truncated: boolean;
  originalBytes: number;
};

export function truncateBlackboxPayload(
  payload: Record<string, unknown>,
  maxBytes = WEBRTC_BLACKBOX_MAX_JSON_BYTES,
): TruncateResult {
  let working = { ...payload };
  let json = JSON.stringify(working);
  let truncated = false;
  if (json.length <= maxBytes) {
    return { payload: working, truncated: false, originalBytes: json.length };
  }
  const originalBytes = json.length;
  if (typeof working.offerSdpRedacted === "string" && working.offerSdpRedacted.length > 4000) {
    working.offerSdpRedacted = `${working.offerSdpRedacted.slice(0, 4000)}…[TRUNCATED_SDP]`;
    truncated = true;
  }
  json = JSON.stringify(working);
  if (json.length > maxBytes && Array.isArray(working.timeline)) {
    working.timeline = (working.timeline as unknown[]).slice(-40);
    truncated = true;
    json = JSON.stringify(working);
  }
  if (json.length > maxBytes && Array.isArray(working.stages)) {
    working.stages = (working.stages as unknown[]).slice(-40);
    truncated = true;
    json = JSON.stringify(working);
  }
  if (json.length > maxBytes) {
    delete working.offerSdpRedacted;
    truncated = true;
    json = JSON.stringify(working);
  }
  if (json.length > maxBytes) {
    working = {
      schemaVersion: working.schemaVersion,
      payloadVersion: working.payloadVersion,
      debugKind: working.debugKind,
      correlationId: working.correlationId,
      callAttemptId: working.callAttemptId,
      truncated: true,
      truncateReason: "payload_exceeded_max_bytes",
      originalBytes,
    };
    truncated = true;
  } else {
    working.truncated = truncated;
    if (truncated) working.originalBytes = originalBytes;
  }
  return { payload: working, truncated: true, originalBytes };
}

export function finalizeBlackboxPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSecretsDeep(payload) as Record<string, unknown>;
  return truncateBlackboxPayload(redacted).payload;
}

export function compactBlackboxLogLine(payload: Record<string, unknown>): string {
  const line = {
    tag: "WEBRTC_CALL_DEBUG",
    schemaVersion: payload.schemaVersion ?? WEBRTC_BLACKBOX_SCHEMA_VERSION,
    debugKind: payload.debugKind ?? null,
    callAttemptId: payload.callAttemptId ?? null,
    correlationId: payload.correlationId ?? null,
    platform: payload.platform ?? null,
    direction: payload.direction ?? null,
    tenantId: (payload.identity as Record<string, unknown> | undefined)?.tenantId
      ?? payload.tenantId
      ?? null,
    endpointName: (payload.pbxHint as Record<string, unknown> | undefined)?.endpointName ?? null,
    sipStatusCode: (payload.sipFailure as Record<string, unknown> | undefined)?.sipStatusCode
      ?? payload.sipStatusCode
      ?? null,
    diagnosisCategory: payload.diagnosisCategory ?? null,
    durationUntilFailureMs: payload.durationUntilFailureMs ?? null,
    truncated: payload.truncated ?? false,
  };
  return JSON.stringify(line);
}

/** In-memory stage timeline for one call attempt. */
export class BlackboxTimeline {
  private readonly stages: BlackboxStage[] = [];
  private readonly startedAtMs: number;

  constructor(readonly callAttemptId: string, readonly correlationId: string) {
    this.startedAtMs = Date.now();
    this.mark("blackbox_started");
  }

  mark(stage: string, detail?: Record<string, unknown>) {
    this.stages.push({
      stage,
      tsMs: Date.now(),
      ...(detail && Object.keys(detail).length ? { detail } : {}),
    });
  }

  elapsedMs(): number {
    return Math.max(0, Date.now() - this.startedAtMs);
  }

  toJSON(): BlackboxStage[] {
    return [...this.stages];
  }
}

export function webrtcAlertWindowMinutes(kind: WebrtcAlertKind): number {
  switch (kind) {
    case "webrtc_outbound_fail_cluster":
      return 5;
    case "webrtc_outbound_488_spike":
    case "session_not_found_timeout_spike":
      return 15;
    case "outbound_no_pbx_channel":
    case "inbound_claimed_no_sip_connect":
    case "webrtc_outbound_drought":
      return 30;
    case "webrtc_contact_registration_loss":
    case "webrtc_diag_ingest_failure":
      return 60;
    default:
      return 15;
  }
}

export function webrtcAlertThreshold(kind: WebrtcAlertKind): number {
  switch (kind) {
    case "webrtc_outbound_fail_cluster":
      return 3;
    case "webrtc_outbound_488_spike":
    case "session_not_found_timeout_spike":
      return 2;
    case "webrtc_outbound_drought":
      return 5;
    case "webrtc_diag_ingest_failure":
      return 10;
    default:
      return 1;
  }
}

export function webrtcAlertDescription(kind: WebrtcAlertKind): string {
  const map: Record<WebrtcAlertKind, string> = {
    webrtc_outbound_488_spike:
      "VoiceDiagEvent WEBRTC_CALL_DEBUG or endReason Incompatible SDP / WEBRTC_SDP_REJECT_*",
    webrtc_outbound_fail_cluster:
      "≥3 WEBRTC outbound failures in 5 minutes per tenant (WEBRTC_OUTBOUND_FAIL or WEBRTC_SDP_REJECT)",
    outbound_no_pbx_channel:
      "Outbound failure with pbxHint.channelNotCreated=true or no ConnectCdr *_ext_1 ±60s",
    inbound_claimed_no_sip_connect:
      "WEBRTC_INBOUND_ANSWER_FAIL with backendAccept.ok and no sipAnswer.confirmed",
    session_not_found_timeout_spike:
      "diagnosisCategory INBOUND_SESSION_NOT_FOUND_TIMEOUT ≥2 in 15 min",
    webrtc_contact_registration_loss:
      "SIP_REGISTER_FAILED / WS_DISCONNECTED spike per tenant vs 7d baseline",
    webrtc_outbound_drought:
      "≥N consecutive outbound failures with zero successes for tenant in 30 min",
    webrtc_diag_ingest_failure:
      "API webrtc-sdp-debug 4xx/5xx or persist errors ≥10/hour",
  };
  return map[kind];
}

export function sdpRejectionLabel(sipCode?: number | null): string {
  return typeof sipCode === "number" ? `WEBRTC_SDP_REJECT_${sipCode}` : "WEBRTC_SDP_REJECT";
}

export function webrtcSdpDebugEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (process.env.NODE_ENV === "development") return true;
    if (window.localStorage?.getItem("cc_webrtc_sdp_debug") === "1") return true;
    const qs = new URLSearchParams(window.location.search);
    return qs.has("webrtcDebug") || qs.get("debug") === "webrtc";
  } catch {
    return false;
  }
}
