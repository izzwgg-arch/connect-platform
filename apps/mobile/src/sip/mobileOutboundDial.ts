/**
 * Outbound mobile dial helpers — registration preflight, number normalization,
 * and SIP failure diagnosis for Call Flight Recorder.
 */

export const OUTBOUND_REGISTRATION_WAIT_MS = 15_000;
export const OUTBOUND_PROGRESS_TIMEOUT_MS = 45_000;

export type OutboundRegistrationSnapshot = {
  connected: boolean;
  registered: boolean;
  registrationAgeMs: number | null;
};

export type OutboundSipFailureDiagnosis = {
  category:
    | "OUTBOUND_AUTH_FAILED"
    | "OUTBOUND_BAD_NUMBER"
    | "OUTBOUND_UNAVAILABLE"
    | "OUTBOUND_MEDIA_FAILED"
    | "OUTBOUND_MEDIA_SDP_REJECTED"
    | "OUTBOUND_TRUNK_FAILED"
    | "OUTBOUND_NOT_REGISTERED"
    | "OUTBOUND_PERMISSION_DENIED"
    | "OUTBOUND_WEBRTC_FAILED"
    | "OUTBOUND_FAILED_OTHER";
  sipCode: number | null;
  sipReason: string | null;
  sipCause: string | null;
};

/** Strip display formatting; preserve * / # feature codes and short extensions. */
export function normalizeMobileDialTarget(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) return trimmed;
  if (trimmed.startsWith("*") || trimmed.startsWith("#")) return trimmed;
  return trimmed.replace(/[()\-\s.+]/g, "");
}

export function classifyOutboundSipFailure(input: {
  sipCode?: number | null;
  sipReason?: string | null;
  sipCause?: string | null;
  localReason?: string | null;
}): OutboundSipFailureDiagnosis {
  const code = typeof input.sipCode === "number" ? input.sipCode : null;
  const reason = String(input.sipReason || input.localReason || "").trim() || null;
  const cause = String(input.sipCause || "").trim() || null;
  const causeLower = (cause || "").toLowerCase();
  const reasonLower = (reason || "").toLowerCase();

  if (
    reasonLower.includes("not registered") ||
    reasonLower.includes("ua not registered") ||
    causeLower.includes("not registered")
  ) {
    return { category: "OUTBOUND_NOT_REGISTERED", sipCode: code, sipReason: reason, sipCause: cause };
  }

  if (
    reasonLower.includes("permission") ||
    reasonLower.includes("notallowed") ||
    reasonLower.includes("microphone") ||
    causeLower.includes("notallowed")
  ) {
    return { category: "OUTBOUND_PERMISSION_DENIED", sipCode: code, sipReason: reason, sipCause: cause };
  }

  if (
    causeLower.includes("ice") ||
    causeLower.includes("webrtc") ||
    causeLower.includes("getusermedia") ||
    causeLower.includes("peerconnection")
  ) {
    return { category: "OUTBOUND_WEBRTC_FAILED", sipCode: code, sipReason: reason, sipCause: cause };
  }

  if (code === 401 || code === 403 || code === 407) {
    return { category: "OUTBOUND_AUTH_FAILED", sipCode: code, sipReason: reason, sipCause: cause };
  }

  if (code === 404 || code === 484 || code === 410) {
    return { category: "OUTBOUND_BAD_NUMBER", sipCode: code, sipReason: reason, sipCause: cause };
  }

  if (code === 480 || code === 486 || code === 600 || code === 603) {
    return { category: "OUTBOUND_UNAVAILABLE", sipCode: code, sipReason: reason, sipCause: cause };
  }

  if (
    code === 488 ||
    code === 606 ||
    causeLower.includes("incompatible sdp") ||
    reasonLower.includes("incompatible sdp") ||
    reasonLower.includes("not acceptable here")
  ) {
    return {
      category: "OUTBOUND_MEDIA_SDP_REJECTED",
      sipCode: code,
      sipReason: reason,
      sipCause: cause,
    };
  }

  if (code === 503 || code === 502 || code === 504) {
    return { category: "OUTBOUND_TRUNK_FAILED", sipCode: code, sipReason: reason, sipCause: cause };
  }

  return { category: "OUTBOUND_FAILED_OTHER", sipCode: code, sipReason: reason, sipCause: cause };
}

export async function ensureOutboundSipRegistration(input: {
  isConnected: () => boolean;
  isRegistered: () => boolean;
  register: (options?: { forceRestart?: boolean }) => Promise<void>;
  waitMs?: number;
}): Promise<{ ok: boolean; forcedRefresh: boolean; waitedMs: number; error?: string }> {
  const waitMs = input.waitMs ?? OUTBOUND_REGISTRATION_WAIT_MS;
  const start = Date.now();
  let forcedRefresh = false;

  const healthy = () => {
    try {
      return input.isConnected() && input.isRegistered();
    } catch {
      return false;
    }
  };

  if (!healthy()) {
    forcedRefresh = true;
    try {
      await input.register({ forceRestart: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, forcedRefresh, waitedMs: Date.now() - start, error: msg };
    }
  }

  while (!healthy() && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!healthy()) {
    return {
      ok: false,
      forcedRefresh,
      waitedMs: Date.now() - start,
      error: "sip_registration_timeout",
    };
  }

  return { ok: true, forcedRefresh, waitedMs: Date.now() - start };
}
