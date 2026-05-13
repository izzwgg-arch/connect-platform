import type { PbxLinkState } from "../types";

const STALE_NO_TRAFFIC_MS = 3 * 60 * 1000;
const POST_CONNECT_TRAFFIC_GRACE_MS = 90 * 1000;

/**
 * Operator-facing PBX link classification (dashboard / health JSON).
 * Distinct from {@link TelephonyHealth.status} which drives HTTP 503 liveness.
 */
export function computePbxLinkState(input: {
  amiConnected: boolean;
  ariHealthy: boolean;
  lastAmiTrafficAt: string | null;
  connectedSince: string | null;
  /** Test hook */
  nowMs?: number;
}): PbxLinkState {
  if (!input.amiConnected) {
    return "reconnecting";
  }
  if (!input.ariHealthy) {
    return "degraded";
  }
  const now = input.nowMs ?? Date.now();
  const since = input.connectedSince ? Date.parse(input.connectedSince) : 0;
  if (since > 0 && now - since < POST_CONNECT_TRAFFIC_GRACE_MS) {
    return "healthy";
  }
  const traffic = input.lastAmiTrafficAt ? Date.parse(input.lastAmiTrafficAt) : 0;
  if (traffic > 0 && now - traffic > STALE_NO_TRAFFIC_MS) {
    return "stale";
  }
  return "healthy";
}
