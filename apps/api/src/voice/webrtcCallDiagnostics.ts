import { z } from "zod";
import {
  compactBlackboxLogLine,
  finalizeBlackboxPayload,
  isWebrtcSdpRejection,
  WEBRTC_BLACKBOX_PAYLOAD_VERSION,
  WEBRTC_BLACKBOX_SCHEMA_VERSION,
  webrtcAlertDescription,
  webrtcAlertThreshold,
  webrtcAlertWindowMinutes,
  type WebrtcAlertKind,
} from "@connect/shared/webrtcBlackbox";

const stageSchema = z.object({
  stage: z.string().max(64),
  tsMs: z.number(),
  detail: z.record(z.unknown()).optional(),
});

const sdpSummarySchema = z.object({
  audioMLine: z.string().max(256).nullable().optional(),
  profiles: z.array(z.string().max(64)).max(16).optional(),
  payloadTypes: z.array(z.string().max(16)).max(32).optional(),
  audioCodecs: z.array(z.string().max(64)).max(32).optional(),
  fmtpLines: z.array(z.string().max(256)).max(24).optional(),
  extmapLines: z.array(z.string().max(128)).max(32).optional(),
  extmapCount: z.number().int().nonnegative().optional(),
  candidateCount: z.number().int().nonnegative().optional(),
  candidateTypes: z.array(z.string().max(16)).max(8).optional(),
  hasOpus: z.boolean().optional(),
  hasPcmu: z.boolean().optional(),
  hasPcma: z.boolean().optional(),
  hasRtcpMux: z.boolean().optional(),
  hasBundle: z.boolean().optional(),
  hasDtlsFingerprint: z.boolean().optional(),
  dtlsSetup: z.string().max(16).nullable().optional(),
  hasIceLite: z.boolean().optional(),
}).passthrough();

export const webrtcCallDebugBodySchema = z
  .object({
    schemaVersion: z.number().int().min(1).max(99).optional().nullable(),
    payloadVersion: z.number().int().min(1).max(99).optional().nullable(),
    kind: z.string().max(32).optional().nullable(),
    debugKind: z
      .enum([
        "WEBRTC_SDP_REJECT",
        "WEBRTC_OUTBOUND_FAIL",
        "WEBRTC_INBOUND_ANSWER_FAIL",
        "WEBRTC_OUTBOUND_SUMMARY",
        "WEBRTC_INBOUND_SUMMARY",
      ])
      .optional()
      .nullable(),
    platform: z.enum(["WEB", "MOBILE"]).optional().nullable(),
    direction: z.enum(["inbound", "outbound"]).optional().nullable(),
    correlationId: z.string().max(80).optional().nullable(),
    callAttemptId: z.string().max(80).optional().nullable(),
    capturedAt: z.string().max(40).optional().nullable(),
    target: z.string().max(64).optional().nullable(),
    targetRaw: z.string().max(64).optional().nullable(),
    targetNormalized: z.string().max(64).optional().nullable(),
    sipTarget: z.string().max(128).optional().nullable(),
    route: z.string().max(64).optional().nullable(),
    sessionId: z.string().max(80).optional().nullable(),
    inviteId: z.string().max(80).optional().nullable(),
    pbxCallId: z.string().max(64).optional().nullable(),
    callerNumber: z.string().max(32).optional().nullable(),
    calleeExtension: z.string().max(16).optional().nullable(),
    flushReason: z.string().max(64).optional().nullable(),
    failedCause: z.string().max(128).optional().nullable(),
    failedOriginator: z.string().max(32).optional().nullable(),
    sipRejectionSource: z
      .enum(["asterisk_or_upstream", "local_client", "unknown"])
      .optional()
      .nullable(),
    sipStatusCode: z.number().int().min(100).max(699).optional().nullable(),
    sipReasonPhrase: z.string().max(128).optional().nullable(),
    sipMethod: z.string().max(16).optional().nullable(),
    diagnosisCategory: z.string().max(64).optional().nullable(),
    durationUntilFailureMs: z.number().int().nonnegative().optional().nullable(),
    durationMs: z.number().int().nonnegative().optional().nullable(),
    sessionReturned: z.boolean().optional().nullable(),
    offerSdpSource: z.string().max(24).optional().nullable(),
    offerSummary: sdpSummarySchema.optional().nullable(),
    offerCompatibilityIssues: z.array(z.string().max(200)).max(40).optional(),
    offerSdpRedacted: z.string().max(20_000).optional().nullable(),
    callInvokedAt: z.string().max(40).optional().nullable(),
    failedAt: z.string().max(40).optional().nullable(),
    truncated: z.boolean().optional().nullable(),
    originalBytes: z.number().int().nonnegative().optional().nullable(),
    identity: z.record(z.unknown()).optional().nullable(),
    client: z.record(z.unknown()).optional().nullable(),
    registration: z.record(z.unknown()).optional().nullable(),
    media: z.record(z.unknown()).optional().nullable(),
    dial: z.record(z.unknown()).optional().nullable(),
    targetBlock: z.record(z.unknown()).optional().nullable(),
    peerConnection: z.record(z.unknown()).optional().nullable(),
    peerConnectionSnapshot: z.record(z.unknown()).optional().nullable(),
    sipFailure: z.record(z.unknown()).optional().nullable(),
    timeline: z.array(stageSchema).max(120).optional(),
    incomingSessionSnapshot: z.record(z.unknown()).optional().nullable(),
    registrationSnapshot: z.record(z.unknown()).optional().nullable(),
    backendAccept: z.record(z.unknown()).optional().nullable(),
    sipAnswer: z.record(z.unknown()).optional().nullable(),
    uiState: z.record(z.unknown()).optional().nullable(),
    pushMeta: z.record(z.unknown()).optional().nullable(),
    pbxHint: z.record(z.unknown()).optional().nullable(),
    sessionNotFoundTimeout: z.boolean().optional().nullable(),
    forceRestart: z.record(z.unknown()).optional().nullable(),
  })
  .passthrough();

export type WebrtcCallDebugBody = z.infer<typeof webrtcCallDebugBodySchema>;

export function parseWebrtcCallDebugBody(body: unknown): WebrtcCallDebugBody {
  return webrtcCallDebugBodySchema.parse(body);
}

export function normalizeWebrtcCallDebugPayload(
  input: WebrtcCallDebugBody,
): Record<string, unknown> {
  const debugKind =
    input.debugKind ??
    (input.kind === "WEBRTC_OUTBOUND_SUMMARY"
      ? "WEBRTC_OUTBOUND_SUMMARY"
      : isWebrtcSdpRejection({
          sipCode: input.sipStatusCode,
          cause: input.failedCause,
        })
        ? "WEBRTC_SDP_REJECT"
        : input.direction === "inbound"
          ? "WEBRTC_INBOUND_ANSWER_FAIL"
          : "WEBRTC_OUTBOUND_FAIL");

  const base: Record<string, unknown> = {
    kind: "WEBRTC_CALL_DEBUG",
    schemaVersion: input.schemaVersion ?? WEBRTC_BLACKBOX_SCHEMA_VERSION,
    payloadVersion: input.payloadVersion ?? WEBRTC_BLACKBOX_PAYLOAD_VERSION,
    debugKind,
    ...input,
  };
  return finalizeBlackboxPayload(base);
}

export function webrtcAlertQuerySpec(kind: WebrtcAlertKind): {
  windowMinutes: number;
  threshold: number;
  description: string;
} {
  return {
    windowMinutes: webrtcAlertWindowMinutes(kind),
    threshold: webrtcAlertThreshold(kind),
    description: webrtcAlertDescription(kind),
  };
}

export { compactBlackboxLogLine };

export type WebrtcCallDebugIngestResult =
  | { ok: true; eventId: string | null; compactLog: string }
  | { ok: false; error: string };

export function buildCompactWebrtcDebugLog(payload: Record<string, unknown>): string {
  return compactBlackboxLogLine(payload);
}
