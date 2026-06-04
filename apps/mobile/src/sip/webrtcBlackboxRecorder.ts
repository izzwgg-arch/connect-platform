/**
 * Mobile WebRTC black-box recorder — mirrors portal schema for API ingestion.
 */
import {
  BlackboxTimeline,
  buildPbxHint,
  classifyInboundDiagnosis,
  classifyOutboundDiagnosis,
  createCallAttemptId,
  finalizeBlackboxPayload,
  redactSdpForDebug,
  summarizeJsSipFailureEvent,
  summarizeOfferSdp,
  checkOfferCompatibility,
  snapshotPeerConnectionExtended,
  WEBRTC_BLACKBOX_PAYLOAD_VERSION,
  WEBRTC_BLACKBOX_SCHEMA_VERSION,
} from "@connect/shared/webrtcBlackbox";

export type MobileBlackboxIdentity = {
  tenantId?: string | null;
  userId?: string | null;
  extensionId?: string | null;
  extensionNumber?: string | null;
  sipUsername?: string | null;
  authUsername?: string | null;
  deviceIdHash?: string | null;
};

export class MobileWebrtcBlackboxRecorder {
  readonly callAttemptId: string;
  readonly correlationId: string;
  readonly timeline: BlackboxTimeline;
  private identity: MobileBlackboxIdentity = {};
  private client: Record<string, unknown> = {};
  private registrationMeta: Record<string, unknown> = {};
  private dialMeta: Record<string, unknown> = {};
  private inboundMeta: Record<string, unknown> = {};

  constructor(correlationId?: string) {
    this.correlationId = correlationId ?? createCallAttemptId("corr");
    this.callAttemptId = createCallAttemptId("mob");
    this.timeline = new BlackboxTimeline(this.callAttemptId, this.correlationId);
  }

  setIdentity(identity: MobileBlackboxIdentity) {
    this.identity = { ...this.identity, ...identity };
  }

  setClient(client: Record<string, unknown>) {
    this.client = { ...this.client, ...client };
  }

  setRegistration(meta: Record<string, unknown>) {
    this.registrationMeta = { ...this.registrationMeta, ...meta };
  }

  setDial(meta: Record<string, unknown>) {
    this.dialMeta = { ...this.dialMeta, ...meta };
    this.timeline.mark("dial_meta", meta);
  }

  setInboundMeta(meta: Record<string, unknown>) {
    this.inboundMeta = { ...this.inboundMeta, ...meta };
    for (const [stage, detail] of Object.entries(meta)) {
      if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
        this.timeline.mark(stage, detail as Record<string, unknown>);
      } else {
        this.timeline.mark(stage, { value: detail });
      }
    }
  }

  mark(stage: string, detail?: Record<string, unknown>) {
    this.timeline.mark(stage, detail);
  }

  endpointName(): string | null {
    return this.identity.authUsername ?? null;
  }

  buildOutboundFailurePayload(input: {
    targetRaw?: string | null;
    targetNormalized?: string | null;
    session?: unknown;
    failedEvent?: unknown;
    offerSdp?: string | null;
    dialMeta?: Record<string, unknown>;
    mediaMeta?: Record<string, unknown>;
    wssConnected?: boolean;
    channelNotCreated?: boolean;
  }): Record<string, unknown> {
    const fields = summarizeJsSipFailureEvent(input.failedEvent ?? {});
    const offer = input.offerSdp ?? null;
    const offerSummary = offer ? summarizeOfferSdp(offer) : null;
    const pcSnap = input.session
      ? snapshotPeerConnectionExtended((input.session as { connection?: unknown }).connection)
      : null;
    const diagnosis = classifyOutboundDiagnosis({
      sipCode: fields.sipStatusCode as number | null,
      sipCause: fields.failedCause as string | null,
      permissionDenied: input.mediaMeta?.permissionGranted === false,
      notRegistered: this.registrationMeta.registrationState === "failed",
    });

    return finalizeBlackboxPayload({
      schemaVersion: WEBRTC_BLACKBOX_SCHEMA_VERSION,
      payloadVersion: WEBRTC_BLACKBOX_PAYLOAD_VERSION,
      debugKind: diagnosis === "OUTBOUND_MEDIA_SDP_REJECTED" ? "WEBRTC_SDP_REJECT" : "WEBRTC_OUTBOUND_FAIL",
      kind: "WEBRTC_CALL_DEBUG",
      correlationId: this.correlationId,
      callAttemptId: this.callAttemptId,
      capturedAt: new Date().toISOString(),
      platform: "MOBILE",
      direction: "outbound",
      identity: this.identity,
      client: this.client,
      target: { raw: input.targetRaw ?? null, normalized: input.targetNormalized ?? null },
      registration: { ...this.registrationMeta, wssConnected: input.wssConnected ?? null },
      media: input.mediaMeta ?? null,
      dial: { ...this.dialMeta, ...(input.dialMeta ?? {}) },
      peerConnection: {
        snapshot: pcSnap,
        offerSummary,
        offerCompatibilityIssues: offerSummary ? checkOfferCompatibility(offerSummary) : [],
        offerSdpRedacted: offer ? redactSdpForDebug(offer) : null,
      },
      sipFailure: fields,
      timeline: this.timeline.toJSON(),
      durationUntilFailureMs: this.timeline.elapsedMs(),
      diagnosisCategory: diagnosis,
      pbxHint: buildPbxHint({
        endpointName: this.endpointName(),
        tenantId: this.identity.tenantId ?? null,
        extension: this.identity.extensionNumber ?? null,
        channelNotCreated: input.channelNotCreated ?? true,
      }),
    });
  }

  buildInboundFailurePayload(input: {
    inviteId?: string | null;
    pbxCallId?: string | null;
    callerNumber?: string | null;
    calleeExtension?: string | null;
    incomingSessionSnapshot?: Record<string, unknown> | null;
    failureReason?: string | null;
    backendAccept?: Record<string, unknown> | null;
    sipAnswer?: Record<string, unknown> | null;
    uiState?: Record<string, unknown> | null;
    pushMeta?: Record<string, unknown> | null;
    forceRestart?: { decided?: boolean; reason?: string | null };
  }): Record<string, unknown> {
    const diagnosis = classifyInboundDiagnosis({
      failureReason: input.failureReason,
      backendAcceptCode: (input.backendAccept?.responseCode as string | undefined) ?? null,
      inviteNotReceived: input.failureReason === "sip_invite_not_received",
    });

    return finalizeBlackboxPayload({
      schemaVersion: WEBRTC_BLACKBOX_SCHEMA_VERSION,
      payloadVersion: WEBRTC_BLACKBOX_PAYLOAD_VERSION,
      debugKind: "WEBRTC_INBOUND_ANSWER_FAIL",
      kind: "WEBRTC_CALL_DEBUG",
      correlationId: this.correlationId,
      callAttemptId: this.callAttemptId,
      capturedAt: new Date().toISOString(),
      platform: "MOBILE",
      direction: "inbound",
      inviteId: input.inviteId ?? null,
      pbxCallId: input.pbxCallId ?? null,
      identity: this.identity,
      client: this.client,
      callerNumber: input.callerNumber ?? null,
      calleeExtension: input.calleeExtension ?? null,
      pushMeta: { ...(this.inboundMeta.pushMeta as Record<string, unknown> | undefined), ...(input.pushMeta ?? {}) },
      registration: this.registrationMeta,
      forceRestart: input.forceRestart ?? this.inboundMeta.forceRestart ?? null,
      incomingSessionSnapshot: input.incomingSessionSnapshot ?? null,
      backendAccept: { ...(this.inboundMeta.backendAccept as Record<string, unknown> | undefined), ...(input.backendAccept ?? {}) },
      sipAnswer: input.sipAnswer ?? null,
      uiState: { ...(this.inboundMeta.uiState as Record<string, unknown> | undefined), ...(input.uiState ?? {}) },
      sessionNotFoundTimeout: input.failureReason === "session_not_found_timeout",
      timeline: this.timeline.toJSON(),
      durationUntilFailureMs: this.timeline.elapsedMs(),
      diagnosisCategory: diagnosis,
      pbxHint: buildPbxHint({
        endpointName: this.endpointName(),
        tenantId: this.identity.tenantId ?? null,
        extension: input.calleeExtension ?? this.identity.extensionNumber ?? null,
        pbxCallId: input.pbxCallId ?? null,
      }),
    });
  }
}
