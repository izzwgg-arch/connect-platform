/**
 * Local copy of Redis key + snapshot envelope for telephony → API handoff.
 * Keep in sync with `packages/shared/src/ariBridgedSnapshot.ts` (API validates with zod).
 */
export const ARI_BRIDGED_SNAPSHOT_KEY_PREFIX = "connect:telephony:ariBridged:v1:";

export function buildAriBridgedSnapshotRedisKey(pbxHost: string): string {
  const safe = String(pbxHost || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128);
  return `${ARI_BRIDGED_SNAPSHOT_KEY_PREFIX}${safe}`;
}

export type AriBridgedSnapshotBridgeV1 = {
  bridgeId: string;
  channelCount: number;
  caller: string;
  callee: string;
  channelNames: string[];
  channelIds: string[];
  sourceKind: "bridge" | "orphan_leg";
  dialplanContext?: string;
  dialplanExten?: string;
  calledNumber?: string;
};

export type AriBridgedSnapshotV1 = {
  v: 1;
  producedAt: string;
  pollIntervalMs: number;
  source: "telephony";
  pbxHost: string;
  rawBridgeCount: number;
  rawChannelCount: number;
  qualifyingBridges: number;
  activeCalls: number;
  bridges: AriBridgedSnapshotBridgeV1[];
  registeredEndpoints: number | null;
  unregisteredEndpoints: number | null;
  totalEndpoints: number | null;
};
