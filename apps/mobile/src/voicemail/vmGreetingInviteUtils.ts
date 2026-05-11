import type { CallInvite } from "../types";

/** Maps Vital-style sipUsername (e.g. T21_101_1) to PBX extension digits (101). */
export function extensionFromSipUsername(sipUsername: string): string {
  const m = String(sipUsername || "").match(/^T\d+_(\d+)/);
  return m ? m[1] : "";
}

function base64UrlToUtf8(segment: string): string | null {
  try {
    let b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const atobFn =
      typeof globalThis !== "undefined" && typeof (globalThis as any).atob === "function"
        ? ((globalThis as any).atob as (s: string) => string).bind(globalThis)
        : null;
    if (!atobFn) return null;
    return atobFn(b64);
  } catch {
    return null;
  }
}

/** Best-effort JWT payload decode (no signature verification). */
export function decodeJwtPayloadLoose(token: string): Record<string, unknown> | null {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const json = base64UrlToUtf8(parts[1]);
    if (!json) return null;
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function pickVmRecordFromNumber(callerNumber: string, toExtension: string): string {
  const fallback = "Voicemail Greeting Recording";
  const raw = String(callerNumber || "").trim();
  if (!raw) return fallback;
  const digitsRaw = raw.replace(/[^0-9+]/g, "");
  const digitsTo = String(toExtension || "").replace(/[^0-9+]/g, "");
  if (digitsRaw && digitsTo && digitsRaw === digitsTo) return fallback;
  return raw;
}

/** Generic SIP-state synthetic invite — avoids self-loop same as vm path, different empty/self label. */
export function pickGenericSipFromNumber(callerNumber: string, toExtension: string): string {
  const fallback = "Incoming call";
  const raw = String(callerNumber || "").trim();
  if (!raw) return fallback;
  const digitsRaw = raw.replace(/[^0-9+]/g, "");
  const digitsTo = String(toExtension || "").replace(/[^0-9+]/g, "");
  if (digitsRaw && digitsTo && digitsRaw === digitsTo) return fallback;
  return raw;
}

/** True when stored wake metadata is for PBX vm-greeting-record jobs (our AsyncStorage key only). */
export function isVmGreetingRecordWake(meta: { pbxCallId: string }): boolean {
  return String(meta.pbxCallId || "").startsWith("vm-greeting-record");
}

export type BuildSipStateSyntheticInviteInput = {
  authToken: string;
  sessionId: string;
  sipUsername: string;
  callerNumber: string;
  callerDisplayName: string | null;
  /** vm-greeting-record wake only; otherwise null for direct PBX originate. */
  wakePbxCallId: string | null;
  /** True only when wake metadata proves vm-greeting-record. */
  isVoicemailGreetingRecord: boolean;
  nowMs?: number;
};

/**
 * Minimal server-shaped invite for IncomingCall UI + SIP answer/reject.
 * `sipLocalAnswerOnly` skips respondInvite / invite polling.
 */
export function buildSipStateSyntheticInvite(input: BuildSipStateSyntheticInviteInput): CallInvite {
  const nowMs = input.nowMs ?? Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 120_000).toISOString();
  const toExtension = extensionFromSipUsername(input.sipUsername) || input.sipUsername;
  const jwt = decodeJwtPayloadLoose(input.authToken);
  const tenantId = String(jwt?.tenantId ?? jwt?.tid ?? "unknown");
  const userId = String(jwt?.sub ?? jwt?.userId ?? "sip-synthetic");
  const fromNumber = input.isVoicemailGreetingRecord
    ? pickVmRecordFromNumber(input.callerNumber, toExtension)
    : pickGenericSipFromNumber(input.callerNumber, toExtension);
  const vmLabel = "Voicemail Greeting Recording";
  const genLabel = "Incoming call";
  const fromDisplay =
    input.callerDisplayName?.trim() ||
    (fromNumber === vmLabel ? vmLabel : fromNumber === genLabel ? genLabel : null);

  const pbxId = input.wakePbxCallId?.trim() || null;

  return {
    id: `sip-${input.sessionId}`,
    tenantId,
    userId,
    extensionId: null,
    pbxCallId: pbxId,
    linkedId: pbxId,
    pbxSipUsername: input.sipUsername,
    sipCallTarget: null,
    fromDisplay,
    fromNumber,
    toExtension,
    status: "PENDING",
    createdAt,
    expiresAt,
    type: "SIP_INBOUND",
    source: "sip_state",
    sipLocalAnswerOnly: true,
    isVoicemailGreetingRecord: input.isVoicemailGreetingRecord,
  } as CallInvite;
}

/** @deprecated Use buildSipStateSyntheticInvite with wake + isVoicemailGreetingRecord: true */
export function buildVmRecordSyntheticInvite(
  input: Omit<BuildSipStateSyntheticInviteInput, "isVoicemailGreetingRecord" | "wakePbxCallId"> & {
    wakePbxCallId: string;
  },
): CallInvite {
  return buildSipStateSyntheticInvite({
    ...input,
    wakePbxCallId: input.wakePbxCallId,
    isVoicemailGreetingRecord: true,
  });
}
