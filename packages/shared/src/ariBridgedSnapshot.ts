import { z } from "zod";

/** Redis key prefix — must match telephony publisher and API reader. */
export const ARI_BRIDGED_SNAPSHOT_KEY_PREFIX = "connect:telephony:ariBridged:v1:";

/** Sanitize PBX host for use in a Redis key (no secrets). */
export function buildAriBridgedSnapshotRedisKey(pbxHost: string): string {
  const safe = String(pbxHost || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128);
  return `${ARI_BRIDGED_SNAPSHOT_KEY_PREFIX}${safe}`;
}

export const AriBridgedSnapshotBridgeV1Schema = z.object({
  bridgeId: z.string(),
  channelCount: z.number().int(),
  caller: z.string(),
  callee: z.string(),
  channelNames: z.array(z.string()),
  channelIds: z.array(z.string()),
  sourceKind: z.enum(["bridge", "orphan_leg"]),
  dialplanContext: z.string().optional(),
  dialplanExten: z.string().optional(),
  calledNumber: z.string().optional(),
});

export const AriBridgedSnapshotV1Schema = z.object({
  v: z.literal(1),
  producedAt: z.string(),
  pollIntervalMs: z.number().int().positive(),
  source: z.literal("telephony"),
  pbxHost: z.string(),
  rawBridgeCount: z.number().int().nonnegative(),
  rawChannelCount: z.number().int().nonnegative(),
  qualifyingBridges: z.number().int().nonnegative(),
  activeCalls: z.number().int().nonnegative(),
  bridges: z.array(AriBridgedSnapshotBridgeV1Schema),
  registeredEndpoints: z.number().int().nullable(),
  unregisteredEndpoints: z.number().int().nullable(),
  totalEndpoints: z.number().int().nullable(),
});

export type AriBridgedSnapshotBridgeV1 = z.infer<typeof AriBridgedSnapshotBridgeV1Schema>;
export type AriBridgedSnapshotV1 = z.infer<typeof AriBridgedSnapshotV1Schema>;

export function parseAriBridgedSnapshotJson(raw: string): AriBridgedSnapshotV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const out = AriBridgedSnapshotV1Schema.safeParse(parsed);
  return out.success ? out.data : null;
}

export function snapshotAgeMs(producedAtIso: string, nowMs: number = Date.now()): number {
  const t = Date.parse(producedAtIso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - t);
}

export function isSnapshotAcceptablyFresh(
  snapshot: AriBridgedSnapshotV1,
  staleAfterMs: number,
  nowMs: number = Date.now(),
): boolean {
  return snapshotAgeMs(snapshot.producedAt, nowMs) <= staleAfterMs;
}

/** Map snapshot bridges to the raw shape expected by API `normalizePbxActiveCall`. */
export function snapshotBridgesToPbxLiveRawCalls(snapshot: AriBridgedSnapshotV1): Record<string, unknown>[] {
  return snapshot.bridges.map((b) => ({
    id: b.sourceKind === "bridge" ? `bridge:${b.bridgeId}` : b.bridgeId,
    state: "Up",
    caller: { number: b.caller },
    connected: { number: b.callee },
    dialplan: {
      context: b.dialplanContext ?? "",
      exten: b.dialplanExten ?? "",
    },
    bridgeId: b.bridgeId,
    bridgeChannelCount: b.channelCount,
  }));
}
