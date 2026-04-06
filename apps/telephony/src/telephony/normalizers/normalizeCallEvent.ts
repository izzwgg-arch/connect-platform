import type { NormalizedCall } from "../types";

// Max duration (seconds) to send to client; prevents absurd values from stale data
const MAX_DURATION_SEC = 86400; // 24h

/** True if channel is a helper/optimization/duplicate leg (Local, mixing, Message/, etc.). */
export function isHelperChannel(channel: string): boolean {
  const ch = channel.trim();
  if (!ch) return true;
  if (ch.startsWith("Local/")) return true;
  if (ch.startsWith("mixing/")) return true;
  if (ch.startsWith("Multicast/")) return true;
  if (ch.startsWith("ConfBridge/")) return true;
  if (ch.startsWith("Message/")) return true;
  return false;
}

/** True when the call has only helper channels. Do not show as user-facing. */
export function isLocalOnlyCall(call: NormalizedCall): boolean {
  return (
    call.channels.length > 0 &&
    call.channels.every((ch) => isHelperChannel(ch))
  );
}

/** True if call has at least one non-helper channel (user-visible leg). */
export function hasValidChannel(call: NormalizedCall): boolean {
  return call.channels.some((ch) => !isHelperChannel(ch));
}

// Normalizes a NormalizedCall into a clean frontend-safe payload.
// Strips internal engine fields that should not leave the service.
// For active calls, durationSec is computed from timestamps (answeredAt or startedAt → now).
export function normalizeCallForClient(call: NormalizedCall): NormalizedCall {
  let durationSec = call.durationSec;
  if (call.state !== "hungup" && call.startedAt) {
    const ref = call.answeredAt || call.startedAt;
    const refMs = new Date(ref).getTime();
    if (!isNaN(refMs)) {
      durationSec = Math.min(
        MAX_DURATION_SEC,
        Math.max(0, Math.floor((Date.now() - refMs) / 1000)),
      );
    }
  } else if (durationSec > MAX_DURATION_SEC) {
    durationSec = MAX_DURATION_SEC;
  }
  return {
    id: call.id,
    linkedId: call.linkedId,
    tenantId: call.tenantId,
    tenantName: call.tenantName ?? null,
    direction: call.direction,
    state: call.state,
    from: call.from ?? null,
    fromName: call.fromName ?? null,
    to: call.to ?? null,
    connectedLine: call.connectedLine,
    channels: [...call.channels],
    bridgeIds: [...call.bridgeIds],
    extensions: [...call.extensions],
    queueId: call.queueId,
    trunk: call.trunk,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSec,
    billableSec: call.billableSec,
    metadata: { ...call.metadata },
  };
}
