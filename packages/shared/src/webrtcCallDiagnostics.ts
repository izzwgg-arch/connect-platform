/**
 * Cross-platform WebRTC / JsSIP failure diagnostics.
 * Pure helpers — safe in portal, mobile, and API.
 */

export const SDP_REJECT_SIP_CODES = [488, 606] as const;

export type JsSipFailureFields = {
  sipStatusCode: number | null;
  sipReasonPhrase: string | null;
  sipMethod: string | null;
  failedCause: string | null;
  failedOriginator: string | null;
};

export type SipRejectionSource =
  | "asterisk_or_upstream"
  | "local_client"
  | "unknown";

export type PeerConnectionSnapshot = {
  connectionState: string | null;
  iceConnectionState: string | null;
  iceGatheringState: string | null;
  signalingState: string | null;
};

/** Normalize JsSIP `failed` event fields (message vs response shape differs by version). */
export function extractJsSipFailureFields(event: unknown): JsSipFailureFields {
  const e = (event ?? {}) as Record<string, unknown>;
  const message = (e.message ?? null) as Record<string, unknown> | null;
  const response = (e.response ?? null) as Record<string, unknown> | null;
  const codeFromMessage =
    typeof message?.status_code === "number" ? message.status_code : null;
  const codeFromResponse =
    typeof response?.status_code === "number" ? response.status_code : null;
  const reasonFromMessage =
    typeof message?.reason_phrase === "string" ? message.reason_phrase : null;
  const reasonFromResponse =
    typeof response?.reason_phrase === "string" ? response.reason_phrase : null;
  const methodFromMessage =
    typeof message?.method === "string" ? message.method : null;
  const methodFromResponse =
    typeof response?.method === "string" ? response.method : null;

  return {
    sipStatusCode: codeFromMessage ?? codeFromResponse,
    sipReasonPhrase: reasonFromMessage ?? reasonFromResponse,
    sipMethod: methodFromMessage ?? methodFromResponse,
    failedCause: typeof e.cause === "string" ? e.cause : null,
    failedOriginator: typeof e.originator === "string" ? e.originator : null,
  };
}

export function isWebrtcSdpRejection(input: {
  sipCode?: number | null;
  cause?: string | null;
}): boolean {
  const code = typeof input.sipCode === "number" ? input.sipCode : null;
  if (code != null && (SDP_REJECT_SIP_CODES as readonly number[]).includes(code)) {
    return true;
  }
  const cause = String(input.cause || "").toLowerCase();
  return cause.includes("incompatible sdp") || cause.includes("not acceptable here");
}

/**
 * Where the SIP 488/606 likely originated.
 * JsSIP sets cause `Incompatible SDP` only for remote 488/606 responses.
 * `originator: remote` confirms a network SIP response (Asterisk/proxy).
 */
export function inferSipRejectionSource(fields: JsSipFailureFields): SipRejectionSource {
  if (fields.failedOriginator === "local") return "local_client";
  if (fields.failedOriginator === "remote" && fields.sipStatusCode != null) {
    return "asterisk_or_upstream";
  }
  if (isWebrtcSdpRejection({ sipCode: fields.sipStatusCode, cause: fields.failedCause })) {
    return "asterisk_or_upstream";
  }
  return "unknown";
}

export function snapshotPeerConnection(pc: unknown): PeerConnectionSnapshot | null {
  if (!pc || typeof pc !== "object") return null;
  const conn = pc as RTCPeerConnection;
  try {
    return {
      connectionState: conn.connectionState ?? null,
      iceConnectionState: conn.iceConnectionState ?? null,
      iceGatheringState: conn.iceGatheringState ?? null,
      signalingState: conn.signalingState ?? null,
    };
  } catch {
    return null;
  }
}
