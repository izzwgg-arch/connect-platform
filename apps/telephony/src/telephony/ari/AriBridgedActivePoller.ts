import { EventEmitter } from "events";
import type { AriClient } from "./AriClient";
import type { BridgedActiveCallRow, BridgedActiveResult } from "./ariBridgedActiveCalls";
import { computeBridgedActiveCalls } from "./ariBridgedActiveCalls";
import type { NormalizedCall } from "../types";
import { inferLiveCallDirection } from "../inferLiveCallDirection";
import { env } from "../../config/env";
import { childLogger } from "../../logging/logger";

const log = childLogger("AriBridgedActivePoller");

const POLL_MS = 1000;

function bridgeRowsToNormalizedCalls(rows: BridgedActiveCallRow[]): NormalizedCall[] {
  const now = new Date().toISOString();
  return rows.map((b) => {
    const callerRaw = b.caller === "—" ? "" : b.caller;
    const direction = inferLiveCallDirection(
      b.dialplanContext ?? "",
      b.dialplanExten ?? "",
      callerRaw.replace(/\D/g, "") || callerRaw,
    );
    const metaSource = b.sourceKind === "bridge" ? "ari_bridge" : "ari_orphan_leg";
    return {
      id: b.sourceKind === "bridge" ? `bridge:${b.bridgeId}` : b.bridgeId,
      linkedId: b.bridgeId,
      tenantId: null,
      direction,
      state: "up" as const,
      from: b.caller === "—" ? null : b.caller,
      to: b.callee === "—" ? null : b.callee,
      connectedLine: null,
      channels: [],
      bridgeIds: b.sourceKind === "bridge" ? [b.bridgeId] : [],
      extensions: [],
      queueId: null,
      trunk: null,
      startedAt: now,
      answeredAt: now,
      endedAt: null,
      durationSec: 0,
      billableSec: 0,
      metadata: { source: metaSource, bridgeChannelCount: b.channelCount },
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

  constructor(private readonly ari: AriClient) {
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
    return bridgeRowsToNormalizedCalls(this.last.bridges);
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
