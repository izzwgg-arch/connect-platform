/**
 * Portal WebRTC black-box recorder — builds full outbound/inbound failure payloads.
 */
import {
  BlackboxTimeline,
  buildPbxHint,
  classifyInboundDiagnosis,
  classifyOutboundDiagnosis,
  createCallAttemptId,
  finalizeBlackboxPayload,
  hashStableId,
  redactSdpForDebug,
  summarizeJsSipFailureEvent,
  summarizeOfferSdp,
  checkOfferCompatibility,
  snapshotPeerConnectionExtended,
  WEBRTC_BLACKBOX_PAYLOAD_VERSION,
  WEBRTC_BLACKBOX_SCHEMA_VERSION,
  type OutboundDiagnosisCategory,
} from "@connect/shared/webrtcBlackbox";

export type PortalBlackboxIdentity = {
  tenantId?: string | null;
  userId?: string | null;
  extensionId?: string | null;
  extensionNumber?: string | null;
  sipUsername?: string | null;
  authUsername?: string | null;
  tenantSlug?: string | null;
};

export type PortalBlackboxClient = {
  userAgent?: string | null;
  commitHash?: string | null;
};

export class PortalWebrtcBlackboxRecorder {
  readonly callAttemptId: string;
  readonly correlationId: string;
  readonly timeline: BlackboxTimeline;
  private identity: PortalBlackboxIdentity = {};
  private client: PortalBlackboxClient = {};
  private dialMeta: Record<string, unknown> = {};
  private registrationMeta: Record<string, unknown> = {};
  private mediaMeta: Record<string, unknown> = {};
  private direction: "inbound" | "outbound" = "outbound";

  constructor(correlationId?: string) {
    this.correlationId = correlationId ?? createCallAttemptId("corr");
    this.callAttemptId = createCallAttemptId("web");
    this.timeline = new BlackboxTimeline(this.callAttemptId, this.correlationId);
  }

  setDirection(direction: "inbound" | "outbound") {
    this.direction = direction;
  }

  setIdentity(identity: PortalBlackboxIdentity) {
    this.identity = { ...this.identity, ...identity };
  }

  setClient(client: PortalBlackboxClient) {
    this.client = { ...this.client, ...client };
    if (typeof navigator !== "undefined" && !this.client.userAgent) {
      this.client.userAgent = navigator.userAgent;
    }
  }

  setRegistration(meta: Record<string, unknown>) {
    this.registrationMeta = { ...this.registrationMeta, ...meta };
    this.timeline.mark("registration_snapshot", meta);
  }

  setMedia(meta: Record<string, unknown>) {
    this.mediaMeta = { ...this.mediaMeta, ...meta };
  }

  setDial(meta: Record<string, unknown>) {
    this.dialMeta = { ...this.dialMeta, ...meta };
  }

  mark(stage: string, detail?: Record<string, unknown>) {
    this.timeline.mark(stage, detail);
  }

  endpointName(): string | null {
    return this.identity.authUsername ?? this.identity.sipUsername ?? null;
  }

  buildOutboundFailurePayload(input: {
    targetRaw?: string | null;
    targetNormalized?: string | null;
    sipTarget?: string | null;
    session?: unknown;
    failedEvent?: unknown;
    offerSdp?: string | null;
    wssConnected?: boolean;
    uaStarted?: boolean;
    channelNotCreated?: boolean;
    dialMeta?: Record<string, unknown>;
    mediaMeta?: Record<string, unknown>;
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
      permissionDenied: this.mediaMeta.permissionGranted === false,
      notRegistered: this.registrationMeta.registrationState === "failed",
    }) as OutboundDiagnosisCategory;

    const payload: Record<string, unknown> = {
      schemaVersion: WEBRTC_BLACKBOX_SCHEMA_VERSION,
      payloadVersion: WEBRTC_BLACKBOX_PAYLOAD_VERSION,
      debugKind: diagnosis === "OUTBOUND_MEDIA_SDP_REJECTED" ? "WEBRTC_SDP_REJECT" : "WEBRTC_OUTBOUND_FAIL",
      kind: "WEBRTC_CALL_DEBUG",
      correlationId: this.correlationId,
      callAttemptId: this.callAttemptId,
      capturedAt: new Date().toISOString(),
      platform: "WEB",
      direction: "outbound",
      identity: {
        tenantId: this.identity.tenantId ?? null,
        userId: this.identity.userId ?? null,
        extensionId: this.identity.extensionId ?? null,
        extensionNumber: this.identity.extensionNumber ?? null,
        sipUsername: this.identity.sipUsername ?? null,
        authUsername: this.identity.authUsername ?? null,
        tenantSlug: this.identity.tenantSlug ?? null,
      },
      client: this.client,
      target: {
        raw: input.targetRaw ?? null,
        normalized: input.targetNormalized ?? null,
        sipTarget: input.sipTarget ?? null,
      },
      registration: {
        ...this.registrationMeta,
        wssConnected: input.wssConnected ?? null,
        uaStarted: input.uaStarted ?? null,
      },
      media: {
        ...this.mediaMeta,
        ...(input.mediaMeta ?? {}),
        inputDeviceLabelHash:
          typeof (input.mediaMeta?.inputDeviceLabel ?? this.mediaMeta.inputDeviceLabel) === "string"
            ? hashStableId(String(input.mediaMeta?.inputDeviceLabel ?? this.mediaMeta.inputDeviceLabel))
            : null,
      },
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
    };
    return finalizeBlackboxPayload(payload);
  }

  buildInboundFailurePayload(input: {
    inviteId?: string | null;
    pbxCallId?: string | null;
    callerNumber?: string | null;
    calleeExtension?: string | null;
    incomingSessionSnapshot?: Record<string, unknown> | null;
    failureReason?: string | null;
    backendAccept?: { requestedAt?: string | null; responseCode?: string | null; ok?: boolean };
    sipAnswer?: { attempted?: boolean; sent?: boolean; confirmed?: boolean };
    uiState?: Record<string, unknown>;
    pushMeta?: Record<string, unknown>;
  }): Record<string, unknown> {
    const diagnosis = classifyInboundDiagnosis({
      failureReason: input.failureReason,
      backendAcceptCode: input.backendAccept?.responseCode ?? null,
      inviteNotReceived: input.failureReason === "sip_invite_not_received",
    });

    const payload: Record<string, unknown> = {
      schemaVersion: WEBRTC_BLACKBOX_SCHEMA_VERSION,
      payloadVersion: WEBRTC_BLACKBOX_PAYLOAD_VERSION,
      debugKind: "WEBRTC_INBOUND_ANSWER_FAIL",
      kind: "WEBRTC_CALL_DEBUG",
      correlationId: this.correlationId,
      callAttemptId: this.callAttemptId,
      capturedAt: new Date().toISOString(),
      platform: "WEB",
      direction: "inbound",
      inviteId: input.inviteId ?? null,
      pbxCallId: input.pbxCallId ?? null,
      identity: {
        tenantId: this.identity.tenantId ?? null,
        userId: this.identity.userId ?? null,
        extensionNumber: this.identity.extensionNumber ?? null,
        sipUsername: this.identity.sipUsername ?? null,
        authUsername: this.identity.authUsername ?? null,
      },
      client: this.client,
      callerNumber: input.callerNumber ?? null,
      calleeExtension: input.calleeExtension ?? null,
      pushMeta: input.pushMeta ?? null,
      registration: this.registrationMeta,
      incomingSessionSnapshot: input.incomingSessionSnapshot ?? null,
      backendAccept: input.backendAccept ?? null,
      sipAnswer: input.sipAnswer ?? null,
      uiState: input.uiState ?? null,
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
    };
    return finalizeBlackboxPayload(payload);
  }
}
