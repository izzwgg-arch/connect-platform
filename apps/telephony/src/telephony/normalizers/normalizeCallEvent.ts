import type { NormalizedCall } from "../types";

// Normalizes a NormalizedCall into a clean frontend-safe payload.
// Strips internal engine fields that should not leave the service.
export function normalizeCallForClient(call: NormalizedCall): NormalizedCall {
  return {
    id: call.id,
    linkedId: call.linkedId,
    tenantId: call.tenantId,
    direction: call.direction,
    state: call.state,
    from: call.from,
    to: call.to,
    connectedLine: call.connectedLine,
    channels: [...call.channels],
    bridgeIds: [...call.bridgeIds],
    extensions: [...call.extensions],
    queueId: call.queueId,
    trunk: call.trunk,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSec: call.durationSec,
    billableSec: call.billableSec,
    metadata: { ...call.metadata },
  };
}
