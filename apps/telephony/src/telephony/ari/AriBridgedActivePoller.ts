import { EventEmitter } from "events";
import type { AriClient } from "./AriClient";
import type { BridgedActiveCallRow, BridgedActiveResult } from "./ariBridgedActiveCalls";
import { computeBridgedActiveCalls } from "./ariBridgedActiveCalls";
import type { NormalizedCall } from "../types";
import { inferLiveCallDirection } from "../inferLiveCallDirection";
import type { TenantResolver } from "../state/TenantResolver";
import { normalizeExtensionFromChannel } from "../normalizers/normalizeExtension";
import { env } from "../../config/env";
import { childLogger } from "../../logging/logger";

const log = childLogger("AriBridgedActivePoller");

const POLL_MS = 1000;

function bridgeRowsToNormalizedCalls(
  rows: BridgedActiveCallRow[],
  resolver?: TenantResolver,
  firstSeenAt?: Map<string, string>,
  callerIdNumCache?: Map<string, string>,
): NormalizedCall[] {
  const now = new Date().toISOString();
  return rows.map((b) => {
    const callerRaw = b.caller === "—" ? "" : b.caller;
    const direction = inferLiveCallDirection(
      b.dialplanContext ?? "",
      b.dialplanExten ?? "",
      callerRaw.replace(/\D/g, "") || callerRaw,
    );
    const calleeRaw = b.callee === "—" ? "" : b.callee;

    // Resolve the DID from priority sources:
    // 1. CALLERID(num) channel variable on T{n} extension channel (most reliable for VitalPBX).
    //    VitalPBX sets this to the originally-dialed DID on the internal extension leg.
    // 2. connected.number from the trunk channel (calledNumber from ARI static data).
    // 3. dialplanExten if 7+ digits.
    // 4. callee label fallback.
    const tnChannelDid = (() => {
      if (!callerIdNumCache) return "";
      for (let i = 0; i < b.channelNames.length; i++) {
        const name = b.channelNames[i] ?? "";
        const id = b.channelIds[i] ?? "";
        if (/^PJSIP\/T\d+_/i.test(name) && id && callerIdNumCache.has(id)) {
          return callerIdNumCache.get(id) ?? "";
        }
      }
      return "";
    })();
    const calledDigits = tnChannelDid || (b.calledNumber ?? "").replace(/\D/g, "");
    const dialedDigits = (b.dialplanExten ?? "").replace(/\D/g, "");
    const calleeDigits = calleeRaw.replace(/\D/g, "");
    const toNumberForResolver =
      calledDigits.length >= 7
        ? calledDigits
        : dialedDigits.length >= 7
          ? dialedDigits
          : calleeDigits.length >= 7
            ? calleeDigits
            : calleeDigits || calleeRaw || undefined;

    // Prefer T{n} extension channel (gives direct T-code → UUID resolution).
    // Fall back to the first available PJSIP channel — its name contains the tenant slug
    // (e.g. PJSIP/344022_gesheft-XXXX) which TenantResolver uses via resolveBySlug().
    const tnChannel = b.channelNames.find((n) => /^PJSIP\/T\d+_/i.test(n));
    const channelHint = tnChannel ?? b.channelNames.find((n) => n.startsWith("PJSIP/")) ?? undefined;
    const extensions = [
      ...new Set(
        b.channelNames
          .map((name) => normalizeExtensionFromChannel(name))
          .filter((ext): ext is string => Boolean(ext)),
      ),
    ];

    const tres =
      resolver?.resolveDetails({
        context: b.dialplanContext ?? "",
        exten: b.dialplanExten ?? "",
        callerIdNum: callerRaw.replace(/\D/g, "") || callerRaw,
        toNumber: toNumberForResolver,
        fromNumber: callerRaw.replace(/\D/g, "") || callerRaw || undefined,
        channel: channelHint,
      }) ?? null;

    // For the displayed "to" field use a priority chain:
    // 1. calledNumber (connected.number on trunk) — most reliable DID source for inbound.
    // 2. dialplanExten when it looks like a DID (7+ digits) and call is inbound.
    // 3. callee label when it already looks like a DID (7+ digits).
    // 4. callee label for non-inbound calls (extension or external number).
    // 5. Fallback: reverse-lookup the tenant's first registered inbound DID from the
    //    Ombutel cache — this handles cases where ARI data doesn't expose the DID.
    const calleeLabel = b.callee === "—" ? null : (b.callee || null);
    let toField: string | null =
      direction === "inbound" && calledDigits.length >= 7
        ? calledDigits
        : direction === "inbound" && dialedDigits.length >= 7
          ? dialedDigits
          : calleeLabel ?? (dialedDigits.length > 0 ? dialedDigits : null);

    // DID fallback: if toField is still empty or looks like an extension (< 7 digits),
    // look up the tenant's first inbound DID from the Ombutel DID cache.
    const toDigits = (toField ?? "").replace(/\D/g, "");
    if (direction === "inbound" && toDigits.length < 7) {
      const fallbackDid = resolver?.getInboundDid(tres?.tenantId ?? null) ?? null;
      if (fallbackDid) toField = fallbackDid;
    }


    const metaSource = b.sourceKind === "bridge" ? "ari_bridge" : "ari_orphan_leg";
    return {
      id: b.sourceKind === "bridge" ? `bridge:${b.bridgeId}` : b.bridgeId,
      linkedId: b.bridgeId,
      tenantId: tres?.tenantId ?? null,
      tenantName: tres?.tenantName ?? null,
      direction,
      state: "up" as const,
      from: b.caller === "—" ? null : b.caller,
      fromName: null,
      to: toField,
      connectedLine: null,
      channels: [],
      bridgeIds: b.sourceKind === "bridge" ? [b.bridgeId] : [],
      extensions,
      queueId: null,
      trunk: null,
      startedAt: firstSeenAt?.get(b.bridgeId) ?? now,
      answeredAt: now,
      endedAt: null,
      durationSec: 0,
      billableSec: 0,
      metadata: {
        source: metaSource,
        bridgeChannelCount: b.channelCount,
        ...(tres?.pbxVitalTenantId ? { pbxVitalTenantId: tres.pbxVitalTenantId } : {}),
        ...(tres?.pbxTenantCode ? { pbxTenantCode: tres.pbxTenantCode } : {}),
      },
    };
  });
}

export declare interface AriBridgedActivePoller {
  on(event: "update", listener: (payload: BridgedActiveResult) => void): this;
}

/** Polls ARI bridges+channels at 1 Hz (no per-AMI-event fanout). */
export class AriBridgedActivePoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private last: BridgedActiveResult | null = null;
  /** Preserves the first-seen timestamp for each bridgeId across polls so duration counts up correctly. */
  private firstSeenAt = new Map<string, string>();
  /**
   * Cache of CALLERID(num) keyed by ARI channel ID.
   * Fetched once per new channel, purged when the channel is no longer active.
   * For inbound VitalPBX calls, the T{n}_ext extension channel carries the DID in CALLERID(num).
   */
  private callerIdNumCache = new Map<string, string>();

  constructor(
    private readonly ari: AriClient,
    private readonly tenantResolver?: TenantResolver,
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLast(): BridgedActiveResult | null {
    return this.last;
  }

  getCallsForSnapshot(): NormalizedCall[] {
    if (!this.last) return [];
    return bridgeRowsToNormalizedCalls(this.last.bridges, this.tenantResolver, this.firstSeenAt, this.callerIdNumCache);
  }

  getActiveCallCount(): number {
    return this.last?.activeCalls ?? 0;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.ari._isConnected) {
      if (this.last !== null) {
        this.last = null;
        this.emit("update", {
          activeCalls: 0,
          bridges: [],
          debug: {
            totalChannels: 0,
            totalBridges: 0,
            qualifyingBridges: 0,
            orphanLegCalls: 0,
            excluded: [],
          },
          verification: {
            rawBridgeCount: 0,
            rawChannelCount: 0,
            qualifyingBridgeCount: 0,
            bridgeBackedCallCount: 0,
            orphanLegCallCount: 0,
            finalActiveCalls: 0,
            qualifyingBridges: [],
            excludedBridges: [],
            orphanLegs: [],
          },
        });
      }
      return;
    }

    try {
      const [bridges, channels] = await Promise.all([
        this.ari.getBridges(),
        this.ari.getChannels(),
      ]);
      const result = computeBridgedActiveCalls(bridges, channels);
      this.last = result;

      // Maintain firstSeenAt: stamp new bridges, purge gone ones.
      const now = new Date().toISOString();
      const currentIds = new Set(result.bridges.map((b) => b.bridgeId));
      for (const [id] of this.firstSeenAt) {
        if (!currentIds.has(id)) this.firstSeenAt.delete(id);
      }
      for (const b of result.bridges) {
        if (!this.firstSeenAt.has(b.bridgeId)) this.firstSeenAt.set(b.bridgeId, now);
      }

      // Fetch CALLERID(num) for extension channels (PJSIP/T{n}_) to get the inbound DID.
      // VitalPBX sets CALLERID(num) on the internal extension channel to the originally-dialed DID.
      // Cache by channel ID so we only fetch once per channel lifetime.
      const activeChannelIds = new Set<string>();
      const varFetches: Promise<void>[] = [];
      for (const b of result.bridges) {
        for (let i = 0; i < b.channelNames.length; i++) {
          const name = b.channelNames[i] ?? "";
          const id = b.channelIds[i] ?? "";
          if (!id) continue;
          activeChannelIds.add(id);
          // Only fetch for extension channels (T{n}_) that we haven't cached yet.
          if (/^PJSIP\/T\d+_/i.test(name) && !this.callerIdNumCache.has(id)) {
            varFetches.push(
              this.ari.getChannelVariable(id, "CALLERID(num)").then((val) => {
                if (val && /^\d{7,}$/.test(val.trim())) {
                  this.callerIdNumCache.set(id, val.trim());
                }
              })
            );
          }
        }
      }
      // Purge cache entries for channels no longer active.
      for (const [cid] of this.callerIdNumCache) {
        if (!activeChannelIds.has(cid)) this.callerIdNumCache.delete(cid);
      }
      if (varFetches.length > 0) await Promise.all(varFetches);

      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ verification: result.verification }, "ari_bridged_active_verify_poll");
      }
      if (
        env.ENABLE_TELEPHONY_DEBUG &&
        result.debug.totalBridges > 0 &&
        result.debug.qualifyingBridges === 0 &&
        result.debug.orphanLegCalls === 0
      ) {
        log.warn({ verification: result.verification }, "ari_bridged_active_all_bridges_excluded");
      }

      this.emit("update", result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ err: msg }, "ari_bridged_active_poll_failed");
    }
  }
}
