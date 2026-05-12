import type Redis from "ioredis";
import type { VitalPbxClient } from "@connect/integrations";
import {
  buildAriBridgedSnapshotRedisKey,
  isSnapshotAcceptablyFresh,
  parseAriBridgedSnapshotJson,
  snapshotAgeMs,
  snapshotBridgesToPbxLiveRawCalls,
} from "@connect/shared";

const DIRECT_ARI_BACKOFF_MS = 5000;
const DIRECT_ARI_INFLIGHT = new Map<string, Promise<DirectAriSliceInner>>();
let directAriBackoffUntil = 0;

type DirectAriSliceInner = {
  activeCallsList: unknown[];
  activeCallsSource: "ari" | "unavailable";
  registeredEndpoints: number | null;
  unregisteredEndpoints: number | null;
};

export type FetchAriSliceForPbxLiveResult<T> = {
  activeCallsList: T[];
  activeCallsSource: "telephony_redis" | "ari" | "unavailable";
  registeredEndpoints: number | null;
  unregisteredEndpoints: number | null;
  activeCallsSnapshotAgeMs: number | null;
};

type Logger = { info: (obj: Record<string, unknown>, msg?: string) => void; warn: (obj: Record<string, unknown>, msg?: string) => void };

async function readSnapshotFromRedis(
  redis: Redis | null,
  snapshotPbxHost: string,
): Promise<{ snapshot: NonNullable<ReturnType<typeof parseAriBridgedSnapshotJson>>; ageMs: number } | null> {
  if (!redis) return null;
  const key = buildAriBridgedSnapshotRedisKey(snapshotPbxHost);
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  const snapshot = parseAriBridgedSnapshotJson(raw);
  if (!snapshot) return null;
  return { snapshot, ageMs: snapshotAgeMs(snapshot.producedAt) };
}

async function directVitalAriFetch<T>(input: {
  client: VitalPbxClient;
  ariUser: string;
  ariPass: string;
  tenantLabel: string;
  snapshotPbxHost: string;
  normalizeRow: (raw: Record<string, unknown>, tenantId?: string | null) => T;
  log: Logger;
}): Promise<FetchAriSliceForPbxLiveResult<T>> {
  const inflightKey = `directAri:${input.snapshotPbxHost}`;
  let promise = DIRECT_ARI_INFLIGHT.get(inflightKey);
  if (!promise) {
    promise = (async (): Promise<DirectAriSliceInner> => {
      try {
        const [bridged, endpointCounts] = await Promise.all([
          input.client.getAriBridgedActiveCalls(input.ariUser, input.ariPass).catch(() => null),
          input.client.getAriEndpointCounts(input.ariUser, input.ariPass).catch(() => null),
        ]);
        let activeCallsList: unknown[] = [];
        let activeCallsSource: "ari" | "unavailable" = "unavailable";
        if (bridged) {
          activeCallsSource = "ari";
          activeCallsList = bridged.bridges.map((b) =>
            input.normalizeRow(
              {
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
              },
              input.tenantLabel,
            ),
          );
          if (
            bridged.debug.totalBridges > 0 &&
            bridged.debug.qualifyingBridges === 0 &&
            bridged.debug.orphanLegCalls === 0
          ) {
            input.log.warn(
              {
                tenantLabel: input.tenantLabel,
                activeCalls: bridged.activeCalls,
                verification: bridged.verification,
              },
              "pbx_live:ari_bridged_active_all_bridges_excluded",
            );
          } else if (process.env.PBX_ARI_BRIDGED_VERIFY_LOG?.toLowerCase() === "true") {
            input.log.info({ tenantLabel: input.tenantLabel, verification: bridged.verification }, "pbx_live:ari_bridged_active_verify");
          }
        }
        let registeredEndpoints: number | null = null;
        let unregisteredEndpoints: number | null = null;
        if (endpointCounts) {
          registeredEndpoints = endpointCounts.registered;
          unregisteredEndpoints = endpointCounts.unregistered;
        }
        directAriBackoffUntil = 0;
        return { activeCallsList, activeCallsSource, registeredEndpoints, unregisteredEndpoints };
      } catch {
        directAriBackoffUntil = Date.now() + DIRECT_ARI_BACKOFF_MS;
        return { activeCallsList: [], activeCallsSource: "unavailable", registeredEndpoints: null, unregisteredEndpoints: null };
      }
    })().finally(() => {
      DIRECT_ARI_INFLIGHT.delete(inflightKey);
    });
    DIRECT_ARI_INFLIGHT.set(inflightKey, promise);
  }

  const inner = await promise;
  return {
    activeCallsList: inner.activeCallsList as T[],
    activeCallsSource: inner.activeCallsSource === "ari" ? "ari" : "unavailable",
    registeredEndpoints: inner.registeredEndpoints,
    unregisteredEndpoints: inner.unregisteredEndpoints,
    activeCallsSnapshotAgeMs: null,
  };
}

/**
 * Prefer telephony Redis snapshot; direct Vital ARI only on miss/stale, backoff, or `forceDirectAri`.
 */
export async function fetchAriSliceForPbxLiveFromRedisOrAri<T>(input: {
  client: VitalPbxClient;
  tenantLabel: string;
  redis: Redis | null;
  snapshotPbxHost: string;
  snapshotStaleMs: number;
  forceDirectAri: boolean;
  normalizeRow: (raw: Record<string, unknown>, tenantId?: string | null) => T;
  log: Logger;
}): Promise<FetchAriSliceForPbxLiveResult<T>> {
  const ariUser = process.env.PBX_ARI_USER || "";
  const ariPass = process.env.PBX_ARI_PASS || "";
  const pbxProfile =
    process.env.CONNECT_PBX_PROFILE === "1" ||
    String(process.env.CONNECT_PBX_PROFILE || "").toLowerCase() === "true";

  if (!ariUser || !ariPass) {
    return {
      activeCallsList: [],
      activeCallsSource: "unavailable",
      registeredEndpoints: null,
      unregisteredEndpoints: null,
      activeCallsSnapshotAgeMs: null,
    };
  }

  if (!input.forceDirectAri) {
    const snapRead = await readSnapshotFromRedis(input.redis, input.snapshotPbxHost);
    if (snapRead && isSnapshotAcceptablyFresh(snapRead.snapshot, input.snapshotStaleMs)) {
      const raws = snapshotBridgesToPbxLiveRawCalls(snapRead.snapshot);
      const activeCallsList = raws.map((raw: Record<string, unknown>) => input.normalizeRow(raw, input.tenantLabel));
      return {
        activeCallsList,
        activeCallsSource: "telephony_redis",
        registeredEndpoints: snapRead.snapshot.registeredEndpoints,
        unregisteredEndpoints: snapRead.snapshot.unregisteredEndpoints,
        activeCallsSnapshotAgeMs: snapRead.ageMs,
      };
    }
  }

  if (!input.forceDirectAri && Date.now() < directAriBackoffUntil) {
    input.log.warn(
      {
        event: "pbx_live_ari_direct_backoff",
        tenantLabel: input.tenantLabel,
        backoffUntilMs: directAriBackoffUntil,
      },
      "pbx live: skipping direct ARI (backoff after recent failure)",
    );
    const snapRead = await readSnapshotFromRedis(input.redis, input.snapshotPbxHost);
    if (snapRead?.snapshot) {
      const raws = snapshotBridgesToPbxLiveRawCalls(snapRead.snapshot);
      const activeCallsList = raws.map((raw: Record<string, unknown>) => input.normalizeRow(raw, input.tenantLabel));
      return {
        activeCallsList,
        activeCallsSource: "telephony_redis",
        registeredEndpoints: snapRead.snapshot.registeredEndpoints,
        unregisteredEndpoints: snapRead.snapshot.unregisteredEndpoints,
        activeCallsSnapshotAgeMs: snapRead.ageMs,
      };
    }
    return {
      activeCallsList: [],
      activeCallsSource: "unavailable",
      registeredEndpoints: null,
      unregisteredEndpoints: null,
      activeCallsSnapshotAgeMs: null,
    };
  }

  const sliceStarted = pbxProfile ? Date.now() : 0;
  const out = await directVitalAriFetch({
    client: input.client,
    ariUser,
    ariPass,
    tenantLabel: input.tenantLabel,
    snapshotPbxHost: input.snapshotPbxHost,
    normalizeRow: input.normalizeRow,
    log: input.log,
  });

  if (input.forceDirectAri && out.activeCallsSource === "ari") {
    input.log.info(
      { event: "pbx_live_ari_direct_fallback", tenantLabel: input.tenantLabel, reason: "forced_direct_ari" },
      "pbx live used direct ARI (explicit force)",
    );
  } else if (out.activeCallsSource === "ari") {
    const hadFreshSnapAttempt = !input.forceDirectAri;
    if (hadFreshSnapAttempt) {
      input.log.info(
        {
          event: "pbx_live_ari_direct_fallback",
          tenantLabel: input.tenantLabel,
          reason: "snapshot_missing_or_stale",
        },
        "pbx live used direct ARI (telephony snapshot unavailable or stale)",
      );
    }
  }

  if (pbxProfile) {
    input.log.info(
      {
        event: "pbx_outbound_profile",
        caller: "fetchAriSliceForPbxLiveFromRedisOrAri",
        service: "api",
        tenantLabel: input.tenantLabel,
        ms: Date.now() - sliceStarted,
        activeCallsSource: out.activeCallsSource,
        activeCallRows: out.activeCallsList.length,
        registeredEndpoints: out.registeredEndpoints,
        unregisteredEndpoints: out.unregisteredEndpoints,
        ariPaths: ["/ari/bridges", "/ari/channels", "/ari/endpoints"],
      },
      "PBX outbound ARI (pbx live slice)",
    );
  }

  return out;
}
