import Redis from "ioredis";
import { childLogger } from "../../logging/logger";
import type { BridgedActiveResult } from "../ari/ariBridgedActiveCalls";
import {
  buildAriBridgedSnapshotRedisKey,
  type AriBridgedSnapshotV1,
} from "../pbx/ariBridgedSnapshotLocal";

const log = childLogger("AriBridgedRedisPublisher");

export type AriBridgedPollSnapshotInput = {
  result: BridgedActiveResult;
  pollIntervalMs: number;
  pbxHost: string;
  ttlSec: number;
  rawBridgeCount: number;
  rawChannelCount: number;
  registeredEndpoints: number | null;
  unregisteredEndpoints: number | null;
  totalEndpoints: number | null;
};

/** JSON payload written to Redis (`SET … EX`). Used by unit tests; keep aligned with `AriBridgedSnapshotV1`. */
export function serializeAriBridgedPollToRedisJson(input: AriBridgedPollSnapshotInput): string {
  return JSON.stringify(toSnapshotV1(input));
}

function toSnapshotV1(input: AriBridgedPollSnapshotInput): AriBridgedSnapshotV1 {
  const { result, pollIntervalMs, pbxHost, rawBridgeCount, rawChannelCount, registeredEndpoints, unregisteredEndpoints, totalEndpoints } = input;
  return {
    v: 1,
    producedAt: new Date().toISOString(),
    pollIntervalMs,
    source: "telephony",
    pbxHost,
    rawBridgeCount,
    rawChannelCount,
    qualifyingBridges: result.debug.qualifyingBridges,
    activeCalls: result.activeCalls,
    bridges: result.bridges.map((b) => ({
      bridgeId: b.bridgeId,
      channelCount: b.channelCount,
      caller: b.caller,
      callee: b.callee,
      channelNames: [...b.channelNames],
      channelIds: [...b.channelIds],
      sourceKind: b.sourceKind,
      dialplanContext: b.dialplanContext,
      dialplanExten: b.dialplanExten,
      calledNumber: b.calledNumber,
    })),
    registeredEndpoints,
    unregisteredEndpoints,
    totalEndpoints,
  };
}

export type AriBridgedRedisPublisherApi = {
  publishFromPoll(input: AriBridgedPollSnapshotInput): Promise<void>;
  close(): Promise<void>;
};

export function createAriBridgedRedisPublisher(opts: {
  redisUrl?: string;
  pbxHost: string;
}): AriBridgedRedisPublisherApi {
  if (!opts.redisUrl?.trim()) {
    return {
      publishFromPoll: async () => {},
      close: async () => {},
    };
  }

  const client = new Redis(opts.redisUrl, { maxRetriesPerRequest: 2 });
  const key = buildAriBridgedSnapshotRedisKey(opts.pbxHost);

  return {
    async publishFromPoll(input: AriBridgedPollSnapshotInput): Promise<void> {
      const snap = toSnapshotV1(input);
      try {
        await client.set(key, JSON.stringify(snap), "EX", input.ttlSec);
      } catch (err: unknown) {
        log.warn({ err: err instanceof Error ? err.message : String(err), key }, "ari_bridged_snapshot_redis_set_failed");
      }
    },
    async close(): Promise<void> {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
